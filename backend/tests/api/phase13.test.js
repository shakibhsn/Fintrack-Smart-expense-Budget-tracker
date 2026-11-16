const { prisma } = require('./dbenv');
const subs = require('../../src/services/subscriptionService');
const M = require('../../src/utils/subscriptionMath');
const R = require('../../src/utils/recurrence');
const { call, register, tx, eq, done } = require('./lib');

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const now0 = new Date();
const today = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth(), now0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));

(async () => {
  // ================= pure maths =================
  const mk = (amount, frequency, customIntervalDays = null) => ({ amount, frequency, customIntervalDays });
  eq('monthly 100 => 100/mo, 1200/yr', [M.monthlyEstimate(mk(100, 'MONTHLY')), M.yearlyEstimate(mk(100, 'MONTHLY'))], [100, 1200]);
  eq('quarterly 300 => 100/mo, 1200/yr', [M.monthlyEstimate(mk(300, 'QUARTERLY')), M.yearlyEstimate(mk(300, 'QUARTERLY'))], [100, 1200]);
  eq('yearly 1200 => 100/mo, 1200/yr', [M.monthlyEstimate(mk(1200, 'YEARLY')), M.yearlyEstimate(mk(1200, 'YEARLY'))], [100, 1200]);
  eq('weekly 100 => 434.82/mo, 5217.86/yr (365.25/7 payments a year)', [M.monthlyEstimate(mk(100, 'WEEKLY')), M.yearlyEstimate(mk(100, 'WEEKLY'))], [434.82, 5217.86]);
  eq('custom every 10 days, 50 => 152.19/mo, 1826.25/yr', [M.monthlyEstimate(mk(50, 'CUSTOM', 10)), M.yearlyEstimate(mk(50, 'CUSTOM', 10))], [152.19, 1826.25]);
  const e = (o) => M.effectiveStatus({ status: 'ACTIVE', endDate: null, nextRenewalDate: today, ...o }, today);
  eq('status: active / paused / cancelled', [e({}), e({ status: 'PAUSED' }), e({ status: 'CANCELLED' })], ['active', 'paused', 'cancelled']);
  eq('status: end date passed => expired; end date TODAY is still active (inclusive)', [e({ endDate: D(dd(-1)) }), e({ endDate: today })], ['expired', 'active']);
  eq('status: no further renewal => expired; cancelled beats expired; paused past end => expired', [e({ nextRenewalDate: null }), e({ status: 'CANCELLED', endDate: D(dd(-5)) }), e({ status: 'PAUSED', endDate: D(dd(-5)) })], ['expired', 'cancelled', 'expired']);
  const seq = (rule, n) => Array.from({ length: n }, (_, i) => iso(R.occurrenceAt({ ...rule, startDate: D(rule.start) }, i)));
  eq('quarterly (monthly x3) from Jan 31: Jan31, Apr30, Jul31, Oct31', seq({ frequency: 'MONTHLY', interval: 3, start: '2027-01-31' }, 4), ['2027-01-31', '2027-04-30', '2027-07-31', '2027-10-31']);
  eq('quarterly from Nov 30 2027 hits Feb 29 in the 2028 leap year', seq({ frequency: 'MONTHLY', interval: 3, start: '2027-11-30' }, 3), ['2027-11-30', '2028-02-29', '2028-05-30']);
  eq('custom every 45 days', seq({ frequency: 'DAILY', interval: 45, start: '2027-01-01' }, 3), ['2027-01-01', '2027-02-15', '2027-04-01']);
  eq('every 2 weeks / every 2 years', [seq({ frequency: 'WEEKLY', interval: 2, start: '2027-03-01' }, 3), seq({ frequency: 'YEARLY', interval: 2, start: '2028-02-29' }, 3)], [['2027-03-01', '2027-03-15', '2027-03-29'], ['2028-02-29', '2030-02-28', '2032-02-29']]);
  let bad = 0;
  for (const rule of [{ frequency: 'MONTHLY', interval: 3, start: '2027-01-31' }, { frequency: 'DAILY', interval: 45, start: '2027-01-05' }, { frequency: 'YEARLY', interval: 2, start: '2028-02-29' }, { frequency: 'WEEKLY', interval: 3, start: '2027-03-01' }]) {
    const r = { ...rule, startDate: D(rule.start) }; const occ = Array.from({ length: 200 }, (_, i) => R.occurrenceAt(r, i));
    for (let k = -20; k < 900; k++) { const q = new Date(D('2027-01-01').getTime() + k * 86400000); const brute = occ.find((o) => o >= q); if (brute && iso(R.firstOnOrAfter(r, q)) !== iso(brute)) bad++; }
  }
  eq('interval lookups agree with brute force (4 rules x 920 dates)', bad, 0);

  // ================= API =================
  const A = await register('s13a'); const B = await register('s13b');
  const create = (T, o) => call(T, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 500, frequency: 'MONTHLY', startDate: dd(0), ...o });
  const uid = async (T) => (await call(T, 'GET', '/auth/me')).data.user.id;
  const Aid = await uid(A);

  eq('no token => 401', (await call(null, 'GET', '/subscriptions')).status, 401);
  eq('validation: bad category', (await create(A, { category: 'Games' })).status, 400);
  eq('validation: amount 0', (await create(A, { amount: 0 })).status, 400);
  eq('validation: custom billing needs an interval', (await create(A, { frequency: 'CUSTOM' })).status, 400);
  eq('validation: end before start', (await create(A, { startDate: dd(5), endDate: dd(1) })).status, 400);
  eq('validation: 2-letter currency / unknown field / empty name', [(await create(A, { currency: 'bd' })).status, (await create(A, { admin: true })).status, (await create(A, { name: '  ' })).status], [400, 400, 400]);
  eq('validation: autoRecord with a foreign currency', (await create(A, { currency: 'USD', autoRecord: true })).status, 400);
  eq('lower-case currency is normalised', (await create(A, { name: 'Dollar plan', currency: 'usd', amount: 10 })).data.subscription.currency, 'USD');

  // ---- create + estimates ----
  let r = await create(A, { name: 'Netflix-like', provider: 'Example Video', startDate: dd(-45), paymentMethod: 'Card', notes: 'family plan' });
  const s1 = r.data.subscription;
  eq('create => 201; estimated vs actual labelled; defaults', [r.status, s1.status, s1.estimate, s1.currency, s1.autoRecord], [201, 'active', { monthly: 500, yearly: 6000, basis: 'estimated' }, 'BDT', false]);
  eq('start 45 days ago => next renewal is the first anchor date on/after today (within 31 days)', [s1.nextRenewalDate >= dd(0), s1.nextRenewalDate <= dd(31), s1.daysUntilRenewal >= 0], [true, true, true]);
  eq('explicit next renewal is respected (and becomes the billing anchor)', (await create(A, { name: 'Explicit', nextRenewalDate: dd(10), startDate: dd(-100) })).data.subscription.nextRenewalDate, dd(10));
  eq('weekly / quarterly / yearly / custom estimates via the API', await (async () => {
    const out = [];
    for (const [f, amt, extra] of [['WEEKLY', 100], ['QUARTERLY', 300], ['YEARLY', 1200], ['CUSTOM', 50, { customIntervalDays: 10 }]]) { const x = (await create(A, { name: `p-${f}`, frequency: f, amount: amt, ...(extra || {}) })).data.subscription; out.push([x.estimate.monthly, x.estimate.yearly]); }
    return out; })(), [[434.82, 5217.86], [100, 1200], [100, 1200], [152.19, 1826.25]]);
  r = await create(A, { name: 'Twin', amount: 777 });
  await call(A, 'POST', '/recurring', { title: 'twin', type: 'EXPENSE', amount: 777, category: 'Bills', frequency: 'MONTHLY', startDate: dd(40) });
  r = await create(A, { name: 'Twin', amount: 777 });
  eq('double-count warning when a recurring transaction has the same name+amount', [r.status, r.data.warnings.length], [201, 1]);

  // ---- isolation ----
  const sid = s1.id;
  eq('B sees none of A\'s subscriptions', (await call(B, 'GET', '/subscriptions')).data.subscriptions, []);
  for (const [n, m, p, b] of [['read', 'GET', `/${sid}`], ['edit', 'PUT', `/${sid}`, { amount: 1 }], ['delete', 'DELETE', `/${sid}`], ['pause', 'POST', `/${sid}/pause`], ['resume', 'POST', `/${sid}/resume`], ['cancel', 'POST', `/${sid}/cancel`], ['pay', 'POST', `/${sid}/payments`, {}]]) {
    eq(`B cannot ${n} A's subscription (404)`, (await call(B, m, `/subscriptions${p}`, b)).status, 404);
  }
  eq('B summary shows nothing of A', (await call(B, 'GET', '/subscriptions/summary')).data.counts.total, 0);
  eq('A\'s subscription untouched by those attempts', (await call(A, 'GET', `/subscriptions/${sid}`)).data.subscription.amount, 500);

  // ---- status management ----
  const C = await register('s13c'); const Cid = await uid(C);
  const c1 = (await create(C, { name: 'One', startDate: dd(0), nextRenewalDate: dd(5) })).data.subscription;
  const c2 = (await create(C, { name: 'Two', amount: 200, nextRenewalDate: dd(8) })).data.subscription;
  eq('summary counts active subs and sums estimates', await (async () => { const s = (await call(C, 'GET', '/subscriptions/summary')).data; return [s.counts.active, s.estimated.monthly, s.estimated.yearly]; })(), [2, 700, 8400]);
  r = await call(C, 'POST', `/subscriptions/${c2.id}/pause`);
  eq('pause => paused; removed from active totals and from upcoming', await (async () => { const s = (await call(C, 'GET', '/subscriptions/summary')).data; return [r.data.subscription.status, s.counts.active, s.counts.paused, s.estimated.monthly, s.upcoming.items.map((u) => u.name)]; })(), ['paused', 1, 1, 500, ['One']]);
  eq('pausing again is harmless', (await call(C, 'POST', `/subscriptions/${c2.id}/pause`)).data.subscription.status, 'paused');
  eq('a paused subscription cannot record a payment', (await call(C, 'POST', `/subscriptions/${c2.id}/payments`, {})).status, 409);
  r = await call(C, 'POST', `/subscriptions/${c2.id}/resume`);
  eq('resume => active; next renewal skips missed dates (on/after today), nothing charged', [r.data.subscription.status, r.data.subscription.nextRenewalDate >= dd(0), (await call(C, 'GET', '/transactions')).data.transactions.length], ['active', true, 0]);
  r = await call(C, 'POST', `/subscriptions/${c1.id}/cancel`);
  const sm = (await call(C, 'GET', '/subscriptions/summary')).data;
  eq('cancel => cancelled, excluded from active totals, listed as recently cancelled', [r.data.subscription.status, sm.counts.active, sm.estimated.monthly, sm.recentlyCancelled.map((x) => x.name)], ['cancelled', 1, 200, ['One']]);
  eq('cancelled cannot be paused; can be resumed (re-subscribed)', [(await call(C, 'POST', `/subscriptions/${c1.id}/pause`)).status, (await call(C, 'POST', `/subscriptions/${c1.id}/resume`)).data.subscription.status], [409, 'active']);
  const ex = (await create(C, { name: 'Ended', startDate: dd(-60), endDate: dd(-10) })).data.subscription;
  eq('end date in the past => expired, no renewal, not counted', [ex.status, ex.nextRenewalDate], ['expired', null]);
  const ex2 = (await create(C, { name: 'Ends tomorrow', startDate: dd(-20), endDate: dd(1), nextRenewalDate: dd(1) })).data.subscription;
  eq('end date tomorrow => still active; after paying there is no further renewal => expired', await (async () => { await call(C, 'POST', `/subscriptions/${ex2.id}/payments`, {}); const x = (await call(C, 'GET', `/subscriptions/${ex2.id}`)).data.subscription; return [ex2.status, x.nextRenewalDate, x.status]; })(), ['active', null, 'expired']);
  eq('filters: status=expired / cancelled / paused / active / all', await (async () => { const f = async (s) => (await call(C, 'GET', `/subscriptions?status=${s}`)).data.subscriptions.map((x) => x.name).sort(); return [await f('expired'), await f('paused'), (await f('all')).length]; })(), [['Ended', 'Ends tomorrow'], [], 4]);
  eq('invalid status filter => 400', (await call(C, 'GET', '/subscriptions?status=weird')).status, 400);

  // ---- renewal boundaries ----
  const Rn = await register('s13r');
  await create(Rn, { name: 'Due today', nextRenewalDate: dd(0), startDate: dd(-30) });
  await create(Rn, { name: 'Tomorrow', nextRenewalDate: dd(1), startDate: dd(-30) });
  await create(Rn, { name: 'In 7', nextRenewalDate: dd(7), startDate: dd(-30) });
  await create(Rn, { name: 'In 8', nextRenewalDate: dd(8), startDate: dd(-30) });
  await create(Rn, { name: 'Overdue', nextRenewalDate: dd(-2), startDate: dd(-60) });
  const up = async (days) => (await call(Rn, 'GET', `/subscriptions?status=upcoming&days=${days}`)).data.subscriptions;
  eq('upcoming (7 days) includes day 0..7, the overdue one first, excludes day 8', (await up(7)).map((s) => s.name), ['Overdue', 'Due today', 'Tomorrow', 'In 7']);
  const u = await up(30);
  eq('due today / tomorrow / overdue flags', [u.find((s) => s.name === 'Due today').daysUntilRenewal, u.find((s) => s.name === 'Due today').isDue, u.find((s) => s.name === 'Tomorrow').isDue, u.find((s) => s.name === 'Overdue').daysUntilRenewal, u.find((s) => s.name === 'Overdue').isDue], [0, true, false, -2, true]);
  eq('reaching the renewal date does NOT create a payment or an expense by itself', [(await call(Rn, 'GET', '/transactions')).data.transactions.length, await prisma.subscriptionPayment.count({ where: { userId: await uid(Rn) } })], [0, 0]);
  const su = (await call(Rn, 'GET', '/subscriptions/summary?days=7')).data;
  eq('upcoming renewal total (4 within 7 days x 500)', [su.upcoming.items.length, su.upcoming.totals.BDT, su.upcoming.dueNow], [4, 2000, 2]);

  // ---- marking a renewal paid: payment + ONE linked expense, counted once ----
  const P = await register('s13p'); const Pid = await uid(P);
  const p1 = (await create(P, { name: 'Pay me', amount: 800, category: 'Software', nextRenewalDate: dd(0), startDate: dd(-30) })).data.subscription;
  r = await call(P, 'POST', `/subscriptions/${p1.id}/payments`, {});
  const paid = r.data;
  eq('pay => 201, one expense created with the subscription link, category and amount', await (async () => { const t = (await call(P, 'GET', '/transactions')).data.transactions; return [r.status, t.length, t[0].amount, t[0].category, t[0].type, t[0].description]; })(), [201, 1, 800, 'Software', 'EXPENSE', 'Pay me']);
  eq('payment history records it; next renewal advanced one month', [paid.subscription.payments.length, paid.subscription.payments[0].status, paid.subscription.payments[0].source, paid.subscription.payments[0].transactionId === paid.transactionId, paid.subscription.nextRenewalDate > dd(0)], [1, 'PAID', 'MANUAL', true, true]);
  eq('dashboard counts that expense exactly ONCE (no double counting)', (await call(P, 'GET', '/dashboard?period=year')).data.summary.totalExpense, 800);
  eq('summary: ACTUAL payments (800) are separate from the ESTIMATE (800/mo)', await (async () => { const s = (await call(P, 'GET', '/subscriptions/summary')).data; return [s.actualPayments.thisMonth, s.actualPayments.last12Months, s.estimated.monthly, /ESTIMATE/.test(s.estimated.basis), /ACTUAL/.test(s.actualPayments.basis)]; })(), [800, 800, 800, true, true]);
  await prisma.subscription.update({ where: { id: p1.id }, data: { nextRenewalDate: D(dd(0)) } }); // rewind to the already-paid date
  eq('recording the SAME renewal date again is refused (409), nothing duplicated', [(await call(P, 'POST', `/subscriptions/${p1.id}/payments`, {})).status, (await call(P, 'GET', '/transactions')).data.transactions.length], [409, 1]);
  let dbRejected = 0;
  try { await prisma.subscriptionPayment.create({ data: { subscriptionId: p1.id, userId: Pid, dueDate: D(dd(0)), amount: 1, currency: 'BDT' } }); } catch (x) { if (x.code === 'P2002') dbRejected += 1; }
  try { await prisma.transaction.create({ data: { userId: Pid, type: 'EXPENSE', amount: 1, category: 'Software', description: 'dup', date: today, subscriptionId: p1.id, occurrenceDate: D(dd(0)) } }); } catch (x) { if (x.code === 'P2002') dbRejected += 1; }
  eq('the DATABASE itself rejects a duplicate payment row and a duplicate linked expense', dbRejected, 2);
  await prisma.subscription.update({ where: { id: p1.id }, data: { nextRenewalDate: D(dd(31)) } });
  const par = await Promise.all(Array.from({ length: 5 }, () => subs.markPaid(Pid, p1.id, {}).then(() => 'ok', (x) => x.statusCode || x.code || 'err')));
  const pays = await prisma.subscriptionPayment.findMany({ where: { subscriptionId: p1.id } });
  eq('5 simultaneous "mark paid" calls never create duplicate payments or expenses', [new Set(pays.map((x) => x.dueDate.getTime())).size === pays.length, await prisma.transaction.count({ where: { subscriptionId: p1.id } }) === pays.filter((x) => x.transactionId).length], [true, true]);
  eq('payment without an expense (recordTransaction=false)', await (async () => { const q = (await create(P, { name: 'No tx', nextRenewalDate: dd(0) })).data.subscription; const before = await prisma.transaction.count({ where: { userId: Pid } }); await call(P, 'POST', `/subscriptions/${q.id}/payments`, { recordTransaction: false }); return [(await prisma.transaction.count({ where: { userId: Pid } })) - before, (await call(P, 'GET', `/subscriptions/${q.id}`)).data.subscription.payments[0].transactionId]; })(), [0, null]);
  const usd = (await create(P, { name: 'Foreign', currency: 'USD', amount: 12, nextRenewalDate: dd(0) })).data.subscription;
  eq('foreign-currency subscription: payment recorded WITHOUT a BDT expense; forcing one is refused; excluded from BDT totals', [(await call(P, 'POST', `/subscriptions/${usd.id}/payments`, { recordTransaction: true })).status, (await call(P, 'POST', `/subscriptions/${usd.id}/payments`, {})).status, (await call(P, 'GET', '/subscriptions/summary')).data.estimated.otherCurrencies.map((c) => [c.currency, c.monthly])], [400, 201, [['USD', 12]]]);

  // ---- month-end anchoring through real payments ----
  const Me = await register('s13m');
  const m31 = (await create(Me, { name: 'Month end', startDate: '2027-01-31', nextRenewalDate: '2027-01-31' })).data.subscription;
  const nexts = []; for (let i = 0; i < 4; i++) { const x = (await call(Me, 'POST', `/subscriptions/${m31.id}/payments`, { recordTransaction: false })).data.subscription; nexts.push(x.nextRenewalDate); }
  eq('monthly on the 31st (via payments): Feb 28, Mar 31, Apr 30, May 31 (no drift)', nexts, ['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  const lp = (await create(Me, { name: 'Leap', startDate: '2028-01-31', nextRenewalDate: '2028-01-31' })).data.subscription;
  eq('leap year: Jan 31 => Feb 29', (await call(Me, 'POST', `/subscriptions/${lp.id}/payments`, { recordTransaction: false })).data.subscription.nextRenewalDate, '2028-02-29');
  const qt = (await create(Me, { name: 'Quarterly', frequency: 'QUARTERLY', amount: 300, startDate: '2027-11-30', nextRenewalDate: '2027-11-30' })).data.subscription;
  const q2 = (await call(Me, 'POST', `/subscriptions/${qt.id}/payments`, { recordTransaction: false })).data.subscription.nextRenewalDate;
  const q3 = (await call(Me, 'POST', `/subscriptions/${qt.id}/payments`, { recordTransaction: false })).data.subscription.nextRenewalDate;
  eq('quarterly from Nov 30: Feb 29 (2028), May 30', [q2, q3], ['2028-02-29', '2028-05-30']);

  // ---- auto-record (opt-in) ----
  const Au = await register('s13au'); const Auid = await uid(Au);
  const a1 = (await create(Au, { name: 'Auto', amount: 90, autoRecord: true, frequency: 'WEEKLY', nextRenewalDate: dd(-14), startDate: dd(-60), category: 'Productivity' })).data.subscription;
  const aPaused = (await create(Au, { name: 'Auto paused', amount: 5, autoRecord: true, frequency: 'WEEKLY', nextRenewalDate: dd(-14), startDate: dd(-60) })).data.subscription;
  await call(Au, 'POST', `/subscriptions/${aPaused.id}/pause`);
  const aCancelled = (await create(Au, { name: 'Auto cancelled', amount: 5, autoRecord: true, frequency: 'WEEKLY', nextRenewalDate: dd(-14), startDate: dd(-60) })).data.subscription;
  await call(Au, 'POST', `/subscriptions/${aCancelled.id}/cancel`);
  const manual = (await create(Au, { name: 'Manual only', amount: 5, frequency: 'WEEKLY', nextRenewalDate: dd(-14), startDate: dd(-60) })).data.subscription;
  await Promise.all([subs.processAll(), subs.processAll(), subs.processUser(Auid), call(Au, 'POST', '/subscriptions/process')]);
  const aTx = await prisma.transaction.findMany({ where: { subscriptionId: a1.id }, orderBy: { occurrenceDate: 'asc' } });
  eq('auto-record: caught up on the due weeks (-14, -7, 0), once each, even with 4 simultaneous runs', [aTx.map((t) => iso(t.occurrenceDate)), aTx.every((t) => Number(t.amount) === 90 && t.category === 'Productivity')], [[dd(-14), dd(-7), dd(0)], true]);
  eq('auto-record: next renewal moved past today; payments marked AUTO', [(await call(Au, 'GET', `/subscriptions/${a1.id}`)).data.subscription.nextRenewalDate > dd(0), (await prisma.subscriptionPayment.findMany({ where: { subscriptionId: a1.id } })).every((p) => p.source === 'AUTO' && p.status === 'PAID')], [true, true]);
  eq('auto-record: paused, cancelled and manual subscriptions generate NOTHING', await Promise.all([aPaused.id, aCancelled.id, manual.id].map((id) => prisma.transaction.count({ where: { subscriptionId: id } }))), [0, 0, 0]);
  const again = await subs.processAll();
  eq('re-running the job creates nothing new (idempotent)', [again.recorded, await prisma.transaction.count({ where: { subscriptionId: a1.id } })], [0, 3]);
  const late = (await create(Au, { name: 'Very late', amount: 10, autoRecord: true, frequency: 'WEEKLY', nextRenewalDate: dd(-100), startDate: dd(-120) })).data.subscription;
  await subs.processUser(Auid);
  const lp2 = await prisma.subscriptionPayment.findMany({ where: { subscriptionId: late.id } });
  eq('auto-record after a long gap: renewals > 62 days late are SKIPPED (no expense), recent ones recorded', [lp2.filter((p) => p.status === 'SKIPPED').every((p) => !p.transactionId), lp2.filter((p) => p.status === 'PAID').length === (await prisma.transaction.count({ where: { subscriptionId: late.id } })), lp2.some((p) => p.status === 'SKIPPED'), lp2.some((p) => p.status === 'PAID')], [true, true, true, true]);
  eq('listing subscriptions also triggers due auto-recording (hosts that sleep)', await (async () => { const z = (await create(Au, { name: 'Lazy', amount: 7, autoRecord: true, frequency: 'MONTHLY', nextRenewalDate: dd(-1), startDate: dd(-40) })).data.subscription; await call(Au, 'GET', '/subscriptions'); return prisma.transaction.count({ where: { subscriptionId: z.id } }); })(), 1);
  eq('analytics see each auto payment once (dashboard total = sum of the linked expenses)', await (async () => { const t = await prisma.transaction.aggregate({ where: { userId: Auid }, _sum: { amount: true } }); return Number((await call(Au, 'GET', '/dashboard?period=year')).data.summary.totalExpense) === Number(t._sum.amount) || 'range'; })(), true);

  // ---- edit + delete ----
  const E = await register('s13e'); const Eid = await uid(E);
  const e1 = (await create(E, { name: 'Edit me', amount: 100, nextRenewalDate: dd(10), startDate: dd(-20) })).data.subscription;
  r = await call(E, 'PUT', `/subscriptions/${e1.id}`, { amount: 150, name: 'Edited', notes: 'changed' });
  eq('edit amount/name => estimates follow', [r.data.subscription.name, r.data.subscription.estimate.monthly, r.data.subscription.estimate.yearly], ['Edited', 150, 1800]);
  eq('omitting provider/payment method/notes in an update KEEPS them (no silent wipe); empty string clears', [(await call(E, 'PUT', `/subscriptions/${e1.id}`, { amount: 150 })).data.subscription.notes, (await call(E, 'PUT', `/subscriptions/${e1.id}`, { notes: '' })).data.subscription.notes], ['changed', null]);
  r = await call(E, 'PUT', `/subscriptions/${e1.id}`, { frequency: 'YEARLY' });
  eq('changing the billing cycle keeps the renewal date and recomputes estimates', [r.data.subscription.nextRenewalDate, r.data.subscription.estimate.monthly], [dd(10), 12.5]);
  eq('changing the next renewal date re-anchors', (await call(E, 'PUT', `/subscriptions/${e1.id}`, { nextRenewalDate: dd(20) })).data.subscription.nextRenewalDate, dd(20));
  eq('edit validation: empty / unknown / custom without interval / end before start', [(await call(E, 'PUT', `/subscriptions/${e1.id}`, {})).status, (await call(E, 'PUT', `/subscriptions/${e1.id}`, { id: 'x' })).status, (await call(E, 'PUT', `/subscriptions/${e1.id}`, { frequency: 'CUSTOM' })).status, (await call(E, 'PUT', `/subscriptions/${e1.id}`, { endDate: dd(-100) })).status], [400, 400, 400, 400]);
  const ended = (await create(E, { name: 'Revive', startDate: dd(-60), endDate: dd(-10) })).data.subscription;
  eq('extending the end date revives an expired subscription', (await call(E, 'PUT', `/subscriptions/${ended.id}`, { endDate: dd(200) })).data.subscription.status, 'active');
  await call(E, 'POST', `/subscriptions/${e1.id}/payments`, {});
  const txId = (await call(E, 'GET', '/transactions')).data.transactions[0].id;
  eq('delete subscription => 200; its payment history goes, the expense it created is KEPT (unlinked)', [(await call(E, 'DELETE', `/subscriptions/${e1.id}`)).status, (await call(E, 'GET', `/subscriptions/${e1.id}`)).status, (await prisma.transaction.findUnique({ where: { id: txId } })).subscriptionId, await prisma.subscriptionPayment.count({ where: { subscriptionId: e1.id } })], [200, 404, null, 0]);

  // ---- summary on the seeded multi-plan account ----
  const S = await register('s13s');
  await create(S, { name: 'Video', category: 'Entertainment', amount: 500, nextRenewalDate: dd(3) });
  await create(S, { name: 'Music', category: 'Entertainment', amount: 120, nextRenewalDate: dd(40) });
  await create(S, { name: 'Cloud', category: 'Cloud Services', amount: 1200, frequency: 'YEARLY', nextRenewalDate: dd(10) });
  await create(S, { name: 'Weekly tool', category: 'Productivity', amount: 100, frequency: 'WEEKLY', nextRenewalDate: dd(2) });
  await create(S, { name: 'Quarterly app', category: 'Software', amount: 300, frequency: 'QUARTERLY', nextRenewalDate: dd(60) });
  const ss = (await call(S, 'GET', '/subscriptions/summary')).data;
  eq('summary: 5 active; monthly 1254.82; yearly 15057.86 (hand-computed)', [ss.counts.active, ss.estimated.monthly, ss.estimated.yearly], [5, 1254.82, 15057.86]);
  eq('summary: category breakdown (monthly estimates, shares add to ~100)', [ss.categoryBreakdown.map((c) => [c.category, c.monthly]), Math.round(ss.categoryBreakdown.reduce((s, c) => s + c.share, 0))], [[['Entertainment', 620], ['Productivity', 434.82], ['Cloud Services', 100], ['Software', 100]], 100]);
  eq('summary: most expensive first', ss.topExpensive.map((x) => x.name), ['Video', 'Weekly tool', 'Music', 'Cloud', 'Quarterly app']);
  eq('summary: upcoming within 30 days (Weekly 2d, Video 3d, Cloud 10d) and their total 1800', [ss.upcoming.items.map((x) => x.name), ss.upcoming.totals.BDT], [['Weekly tool', 'Video', 'Cloud'], 1800]);
  const Z = await register('s13z');
  const zs = (await call(Z, 'GET', '/subscriptions/summary')).data;
  eq('summary with no subscriptions: zeros, no invented data', [zs.counts.total, zs.estimated.monthly, zs.upcoming.items, zs.categoryBreakdown, zs.actualPayments.last12Months], [0, 0, [], [], 0]);
  eq('subscription rows have no default/example records', (await call(Z, 'GET', '/subscriptions')).data.subscriptions, []);

  await prisma.$disconnect();
  done();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
