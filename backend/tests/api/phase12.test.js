const { prisma, svc } = require('./dbenv');
const { call, register, tx, eq, done } = require('./lib');

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const now0 = new Date();
const today = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth(), now0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));
const at = (s, h = 12) => new Date(`${s}T${String(h).padStart(2, '0')}:00:00Z`); // a "clock" reading on day s

(async () => {
  const meId = async (T) => (await call(T, 'GET', '/auth/me')).data.user.id;
  const mk = (T, o) => call(T, 'POST', '/recurring', { title: 'Rent', type: 'EXPENSE', amount: 1200, category: 'Rent', frequency: 'MONTHLY', startDate: dd(0), ...o });
  const txs = async (T, q = '') => (await call(T, 'GET', `/transactions?limit=500${q}`)).data.transactions;
  const byRec = async (T, id) => (await txs(T)).filter((t) => t.recurringId === id);
  const hist = async (T, id) => (await call(T, 'GET', `/recurring/${id}/occurrences`)).data;

  const A = await register('r12a'); const Aid = await meId(A);
  const B = await register('r12b'); const Bid = await meId(B);

  // ================= create + immediate generation =================
  await call(A, 'POST', '/budgets', { category: 'Rent', limit: 1000, startDate: dd(-5), endDate: dd(25) });
  let r = await mk(A, { title: 'Monthly Rent', notes: 'flat 4B' });
  const rent = r.data.recurring;
  eq('create => 201, active, generated today immediately', [r.status, rent.status, rent.generatedCount, rent.nextOccurrence !== dd(0)], [201, 'active', 1, true]);
  let g = await byRec(A, rent.id);
  eq('generated transaction: user A, right amount/type/category/date, flagged recurring', [g.length, g[0].amount, g[0].type, g[0].category, g[0].date, g[0].description, g[0].isRecurring, g[0].notes], [1, 1200, 'EXPENSE', 'Rent', dd(0), 'Monthly Rent', true, 'flat 4B']);
  eq('appears in the normal transaction list', (await txs(A)).some((t) => t.id === g[0].id), true);
  eq('dashboard total includes it', (await call(A, 'GET', '/dashboard?period=month')).data.summary.totalExpense, 1200);
  eq('analytics overview includes it', (await call(A, 'GET', '/analytics/overview?period=this_month')).data.summary.expense, 1200);
  const notes = (await call(A, 'GET', '/notifications')).data.notifications;
  eq('notification: recurring added (once) + budget alert from the generated expense', [notes.filter((n) => n.type === 'RECURRING' && /Recurring added/.test(n.title)).length, notes.some((n) => n.type === 'BUDGET_EXCEEDED')], [1, true]);

  // ================= idempotency =================
  const run1 = (await call(A, 'POST', '/recurring/process')).data;
  const run2 = (await call(A, 'POST', '/recurring/process')).data;
  eq('re-running the job generates nothing new', [run1.generated, run2.generated, (await byRec(A, rent.id)).length], [0, 0, 1]);
  await Promise.all(Array.from({ length: 12 }, () => call(A, 'POST', '/recurring/process')));
  eq('12 concurrent runs => still exactly one transaction', (await byRec(A, rent.id)).length, 1);
  eq('in-process job x3 in parallel as well', [(await Promise.all([svc.processSchedule(rent.id, now0), svc.processSchedule(rent.id, now0), svc.processSchedule(rent.id, now0)])).reduce((s, x) => s + x.generated.length, 0), (await byRec(A, rent.id)).length], [0, 1]);
  eq('exactly one occurrence row, status GENERATED', (await hist(A, rent.id)).history.map((h) => [h.scheduledDate, h.status, !!h.transactionId]), [[dd(0), 'GENERATED', true]]);
  eq('only one RECURRING "added" notification after all those runs', (await call(A, 'GET', '/notifications')).data.notifications.filter((n) => /Recurring added/.test(n.title)).length, 1);

  // DB-level guarantee: a second transaction for the same schedule+date is rejected by the database itself
  let dbRejected = false;
  try { await prisma.transaction.create({ data: { userId: Aid, type: 'EXPENSE', amount: 1, category: 'Rent', description: 'dup', date: today, recurringId: rent.id, occurrenceDate: today } }); } catch (e) { dbRejected = e.code === 'P2002'; }
  eq('database unique constraint rejects a duplicate (recurringId, occurrenceDate)', dbRejected, true);

  // ================= start-date policies =================
  r = await mk(A, { title: 'Gym', frequency: 'WEEKLY', startDate: dd(3), amount: 500, category: 'Health' });
  const gym = r.data.recurring;
  eq('future start: nothing generated, next = start date', [gym.generatedCount, gym.nextOccurrence, (await byRec(A, gym.id)).length], [0, dd(3), 0]);
  const up = (await hist(A, gym.id)).upcoming;
  eq('upcoming list: 5 dates, 7 days apart, labelled UPCOMING', [up.length, up[1].scheduledDate, up[4].scheduledDate, up[0].status], [5, dd(10), dd(31), 'UPCOMING']);

  r = await mk(A, { title: 'Daily past (no backfill)', frequency: 'DAILY', startDate: dd(-5), amount: 10, category: 'Misc' });
  const d1 = r.data.recurring;
  eq('past start WITHOUT backfill: only today is created (no surprise flood)', [(await byRec(A, d1.id)).map((t) => t.date), d1.nextOccurrence], [[dd(0)], dd(1)]);
  r = await mk(A, { title: 'Daily past (backfill)', frequency: 'DAILY', startDate: dd(-5), amount: 10, category: 'Misc', backfill: true });
  const d2 = r.data.recurring;
  eq('past start WITH backfill: 6 transactions (5 days ago..today), next tomorrow', [(await byRec(A, d2.id)).length, d2.nextOccurrence, d2.generatedCount], [6, dd(1), 6]);
  eq('backfill of > 60 past occurrences is refused', (await mk(A, { title: 'Too old', frequency: 'DAILY', startDate: dd(-100), backfill: true })).status, 400);
  eq('end date already passed without backfill => 400 explaining why', (await mk(A, { title: 'Ended', frequency: 'DAILY', startDate: dd(-20), endDate: dd(-10) })).status, 400);

  // ================= month-end / leap-year / year-end with a simulated clock =================
  const sim = async (id, days, opts) => { let n = 0; for (const day of days) n += (await svc.processSchedule(id, at(day), opts)).generated.length; return n; };
  const generatedDates = async (T, id) => (await byRec(T, id)).map((t) => t.date).sort();

  r = await mk(A, { title: 'Subscription 31st', frequency: 'MONTHLY', startDate: '2027-01-31', amount: 99, category: 'Software' });
  const m31 = r.data.recurring;
  eq('monthly on the 31st: nothing before the first date', await sim(m31.id, ['2027-01-30']), 0);
  await sim(m31.id, ['2027-01-31', '2027-02-27', '2027-02-28', '2027-03-30', '2027-03-31', '2027-04-30']);
  eq('31st: Jan 31, Feb 28 (not 27/Mar 1), Mar 31, Apr 30', await generatedDates(A, m31.id), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  r = await mk(A, { title: 'Leap 31st', frequency: 'MONTHLY', startDate: '2028-01-31', amount: 9, category: 'Software' });
  await sim(r.data.recurring.id, ['2028-01-31', '2028-02-28', '2028-02-29', '2028-03-31']);
  eq('leap year: Feb 29 is used (not Feb 28)', await generatedDates(A, r.data.recurring.id), ['2028-01-31', '2028-02-29', '2028-03-31']);
  r = await mk(A, { title: 'Monthly 29th', frequency: 'MONTHLY', startDate: '2027-01-29', amount: 9, category: 'Software' });
  await sim(r.data.recurring.id, ['2027-01-29', '2027-02-28', '2027-03-29']);
  eq('29th: Feb 28 in a non-leap year, then back to the 29th', await generatedDates(A, r.data.recurring.id), ['2027-01-29', '2027-02-28', '2027-03-29']);
  r = await mk(A, { title: 'Monthly 30th', frequency: 'MONTHLY', startDate: '2027-01-30', amount: 9, category: 'Software' });
  await sim(r.data.recurring.id, ['2027-01-30', '2027-02-28', '2027-03-30']);
  eq('30th: Feb 28, then Mar 30', await generatedDates(A, r.data.recurring.id), ['2027-01-30', '2027-02-28', '2027-03-30']);
  r = await mk(A, { title: 'Yearly leap day', frequency: 'YEARLY', startDate: '2028-02-29', amount: 50, category: 'Fees' });
  await sim(r.data.recurring.id, ['2028-02-29', '2029-02-27', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  eq('yearly Feb 29: 2028-02-29, 2029-02-28, 2030-02-28, 2031-02-28, 2032-02-29', await generatedDates(A, r.data.recurring.id), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  r = await mk(A, { title: 'Weekly Monday', frequency: 'WEEKLY', startDate: '2027-03-01', amount: 5, category: 'Misc' });
  await sim(r.data.recurring.id, ['2027-03-01', '2027-03-08', '2027-03-15']);
  eq('weekly keeps the weekday', (await generatedDates(A, r.data.recurring.id)).map((d) => D(d).getUTCDay()), [1, 1, 1]);
  r = await mk(A, { title: 'Daily', frequency: 'DAILY', startDate: '2027-06-01', amount: 5, category: 'Misc' });
  await sim(r.data.recurring.id, ['2027-06-01', '2027-06-02', '2027-06-03']);
  eq('daily: one per day', await generatedDates(A, r.data.recurring.id), ['2027-06-01', '2027-06-02', '2027-06-03']);

  // ================= end date =================
  r = await mk(A, { title: 'Limited', frequency: 'WEEKLY', startDate: '2027-04-05', endDate: '2027-04-19', amount: 5, category: 'Misc' });
  const lim = r.data.recurring;
  await sim(lim.id, ['2027-04-05', '2027-04-12', '2027-04-19']);
  eq('end date is inclusive: Apr 5, 12, 19', await generatedDates(A, lim.id), ['2027-04-05', '2027-04-12', '2027-04-19']);
  eq('nothing after the end date', await sim(lim.id, ['2027-04-26', '2027-05-03', '2027-06-01']), 0);
  eq('finished schedule is "completed" with no next date', [(await call(A, 'GET', `/recurring/${lim.id}`)).data.recurring.status, (await call(A, 'GET', `/recurring/${lim.id}`)).data.recurring.nextOccurrence], ['completed', null]);
  eq('completed schedule has no upcoming dates', (await hist(A, lim.id)).upcoming, []);

  // ================= pause / resume =================
  r = await mk(A, { title: 'Pausable', frequency: 'DAILY', startDate: dd(0), amount: 7, category: 'Misc' });
  const pz = r.data.recurring;
  await sim(pz.id, [dd(1)]);
  r = await call(A, 'POST', `/recurring/${pz.id}/pause`);
  eq('pause => status paused, existing transactions kept', [r.data.recurring.status, (await byRec(A, pz.id)).length], ['paused', 2]);
  eq('paused: no generation days later', await sim(pz.id, [dd(2), dd(3), dd(4)]), 0);
  eq('paused: manual/process endpoint generates nothing for it either', (await call(A, 'POST', '/recurring/process')).data.generated >= 0 && (await byRec(A, pz.id)).length, 2);
  eq('pause keeps the configuration', (await call(A, 'GET', `/recurring/${pz.id}`)).data.recurring.amount, 7);
  // resume WITHOUT catch-up, 5 days after it started
  r = await call(A, 'POST', `/recurring/${pz.id}/resume`, {});
  eq('resume (default policy) at real "now" = day 0 => active again', r.data.recurring.status, 'active');
  const pz2Rows = await prisma.recurringOccurrence.findMany({ where: { recurringId: pz.id }, orderBy: { scheduledDate: 'asc' } });
  eq('resume does not flood: no extra transactions', (await byRec(A, pz.id)).length, 2);
  void pz2Rows;
  // clean policy test with a simulated clock via the service
  r = await mk(A, { title: 'Pause policy', frequency: 'DAILY', startDate: dd(0), amount: 3, category: 'Misc' });
  const pp = r.data.recurring;
  await svc.pause(Aid, pp.id, now0);
  const later = at(dd(5));
  const res = await svc.resume(Aid, pp.id, {}, later);
  eq('resume after 5 paused days: missed dates are recorded as SKIPPED (day1..day4), today generated', [(await byRec(A, pp.id)).map((t) => t.date).sort(), res.nextOccurrence], [[dd(0), dd(5)], dd(6)]);
  eq('skipped dates visible in history', (await hist(A, pp.id)).history.filter((h) => h.status === 'SKIPPED').map((h) => h.scheduledDate).sort(), [dd(1), dd(2), dd(3), dd(4)]);
  r = await mk(A, { title: 'Catch-up policy', frequency: 'DAILY', startDate: dd(0), amount: 3, category: 'Misc' });
  const cu = r.data.recurring;
  await svc.pause(Aid, cu.id, now0);
  await svc.resume(Aid, cu.id, { catchUp: true }, at(dd(5)));
  eq('resume with catchUp=true generates the missed dates on purpose', (await byRec(A, cu.id)).map((t) => t.date).sort(), [dd(0), dd(1), dd(2), dd(3), dd(4), dd(5)]);

  // ================= long outage =================
  r = await mk(A, { title: 'Outage', frequency: 'DAILY', startDate: dd(0), amount: 1, category: 'Misc' });
  const out = r.data.recurring;
  const res2 = await svc.processSchedule(out.id, at(dd(45)));
  eq('45-day outage: dates older than 31 days skipped (13), the rest generated (32)', [res2.skipped, res2.generated.length], [13, 32]);
  eq('skipped ones are recorded with an explanation', (await hist(A, out.id)).history.filter((h) => h.status === 'SKIPPED').every((h) => /Missed by more than 31 days/.test(h.error)), true);

  // ================= failure handling =================
  r = await mk(A, { title: 'Will fail', frequency: 'DAILY', startDate: dd(1), amount: 20, category: 'Misc' });
  const fl = r.data.recurring;
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_tx_trg ON "Transaction"');
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_test_tx() RETURNS trigger AS $$ BEGIN IF NEW."description" = 'Will fail' THEN RAISE EXCEPTION 'simulated database failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER fail_test_tx_trg BEFORE INSERT ON "Transaction" FOR EACH ROW EXECUTE FUNCTION fail_test_tx()'); // makes the DB reject this schedule's insert
  const f1 = await svc.processSchedule(fl.id, at(dd(1)));
  const f2 = await svc.processSchedule(fl.id, at(dd(1)));
  eq('failure: nothing generated, failed counted, pointer NOT advanced', [f1.generated.length, f1.failed, f2.failed, (await byRec(A, fl.id)).length, (await call(A, 'GET', `/recurring/${fl.id}`)).data.recurring.nextOccurrence], [0, 1, 1, 0, dd(1)]);
  let h = (await hist(A, fl.id)).history;
  eq('history: FAILED (never GENERATED), error text, attempts counted', [h.length, h[0].status, !!h[0].error, h[0].attempts, h[0].transactionId], [1, 'FAILED', true, 2, null]);
  eq('only ONE failure notification despite two failed runs', (await call(A, 'GET', '/notifications')).data.notifications.filter((n) => n.title.startsWith('Recurring failed: Will fail')).length, 1);
  eq('list shows failedCount', (await call(A, 'GET', '/recurring')).data.recurring.find((x) => x.id === fl.id).failedCount, 1);
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_tx_trg ON "Transaction"'); // the cause is fixed
  const f3 = await svc.processSchedule(fl.id, at(dd(1)));
  h = (await hist(A, fl.id)).history;
  eq('retry after the cause is fixed: same date now GENERATED, one transaction, single history row', [f3.generated.length, (await byRec(A, fl.id)).length, h.length, h[0].status, !!h[0].transactionId], [1, 1, 1, 'GENERATED', true]);

  // ================= editing =================
  r = await mk(A, { title: 'Editable', frequency: 'DAILY', startDate: dd(0), amount: 100, category: 'Bills' });
  const ed = r.data.recurring;
  const firstTx = (await byRec(A, ed.id))[0];
  r = await call(A, 'PUT', `/recurring/${ed.id}`, { amount: 150, title: 'Editable v2', applyTo: 'future' });
  eq('edit applies to the schedule', [r.status, r.data.recurring.amount, r.data.recurring.title], [200, 150, 'Editable v2']);
  eq('already-generated transaction is NOT modified', (await call(A, 'GET', `/transactions/${firstTx.id}`)).data.transaction.amount, 100);
  await svc.processSchedule(ed.id, at(dd(1)));
  eq('the next occurrence uses the new values', (await byRec(A, ed.id)).sort((a, b) => a.date.localeCompare(b.date)).map((t) => [t.amount, t.description]), [[100, 'Editable'], [150, 'Editable v2']]);
  eq('applyTo other than "future" is refused with an explanation', [(await call(A, 'PUT', `/recurring/${ed.id}`, { amount: 1, applyTo: 'past' })).status, (await call(A, 'PUT', `/recurring/${ed.id}`, { amount: 1, applyTo: 'past' })).json.message.includes('never modified')], [400, true]);
  r = await call(A, 'PUT', `/recurring/${ed.id}`, { frequency: 'WEEKLY' });
  eq('changing frequency never re-creates handled dates (next is after the last handled date)', [r.data.recurring.frequency, r.data.recurring.nextOccurrence > dd(1)], ['WEEKLY', true]);
  r = await call(A, 'PUT', `/recurring/${ed.id}`, { endDate: dd(1) });
  eq('end date before the next occurrence: schedule completes (no further dates)', [r.data.recurring.status, r.data.recurring.nextOccurrence], ['completed', null]);
  eq('end date before the start date is refused', (await call(A, 'PUT', `/recurring/${ed.id}`, { endDate: dd(-1) })).status, 400);

  // ================= delete keeps history =================
  r = await mk(A, { title: 'To delete', frequency: 'DAILY', startDate: dd(0), amount: 11, category: 'Misc' });
  const del = r.data.recurring;
  const keptId = (await byRec(A, del.id))[0].id;
  eq('delete => 200', (await call(A, 'DELETE', `/recurring/${del.id}`)).status, 200);
  const kept = (await call(A, 'GET', `/transactions/${keptId}`)).data.transaction;
  eq('generated transaction is kept, now detached from the schedule', [kept.amount, kept.recurringId, kept.isRecurring], [11, null, false]);
  eq('schedule gone', [(await call(A, 'GET', `/recurring/${del.id}`)).status, (await call(A, 'GET', '/recurring')).data.recurring.some((x) => x.id === del.id)], [404, false]);

  // deleting a generated transaction does not regenerate it, and history says so
  const gt = (await byRec(A, rent.id))[0];
  await call(A, 'DELETE', `/transactions/${gt.id}`);
  await call(A, 'POST', '/recurring/process');
  eq('deleted generated tx is not regenerated; history marks it deleted', [(await byRec(A, rent.id)).length, (await hist(A, rent.id)).history[0].transactionDeleted], [0, true]);

  // ================= generated tx cannot spawn schedules / forge links =================
  const plain = (await tx(A, 'EXPENSE', 5, 'Misc', dd(0))).data.transaction;
  await call(A, 'PUT', `/transactions/${plain.id}`, { recurringId: rent.id, occurrenceDate: dd(0) });
  const posted = (await call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: 1, category: 'Misc', description: 'forge', date: dd(0), recurringId: rent.id, occurrenceDate: dd(0) })).data.transaction;
  eq('clients cannot attach a transaction to a schedule via the transactions API', [(await call(A, 'GET', `/transactions/${plain.id}`)).data.transaction.recurringId, posted.recurringId], [null, null]);
  const nSched = (await call(A, 'GET', '/recurring')).data.recurring.length;
  await svc.processSchedule((await call(A, 'POST', '/recurring', { title: 'Spawn check', type: 'EXPENSE', amount: 1, category: 'Misc', frequency: 'DAILY', startDate: dd(0) })).data.recurring.id, now0);
  eq('generation creates transactions only, never new schedules', (await call(A, 'GET', '/recurring')).data.recurring.length, nSched + 1);

  // ================= lazy processing (hosts that sleep) =================
  r = await mk(A, { title: 'Lazy', frequency: 'DAILY', startDate: dd(0), amount: 2, category: 'Misc' });
  const lazy = r.data.recurring;
  await prisma.recurringTransaction.update({ where: { id: lazy.id }, data: { nextOccurrence: D(dd(1)) } }); // pretend the pointer is one day behind "tomorrow"? (future)
  await prisma.recurringOccurrence.deleteMany({ where: { recurringId: lazy.id } });
  await prisma.transaction.deleteMany({ where: { recurringId: lazy.id } });
  await prisma.recurringTransaction.update({ where: { id: lazy.id }, data: { startDate: D(dd(-3)), nextOccurrence: D(dd(-2)) } });
  const viaList = await txs(A);
  eq('opening the transaction list processes due schedules without any scheduler tick (dates -2,-1,0)', viaList.filter((t) => t.recurringId === lazy.id).map((t) => t.date).sort(), [dd(-2), dd(-1), dd(0)]);

  // ================= validation =================
  eq('end before start => 400', (await mk(A, { startDate: dd(5), endDate: dd(1) })).status, 400);
  eq('bad frequency => 400', (await mk(A, { frequency: 'HOURLY' })).status, 400);
  eq('amount 0 => 400', (await mk(A, { amount: 0 })).status, 400);
  eq('missing title => 400', (await mk(A, { title: '' })).status, 400);
  eq('unknown field => 400', (await mk(A, { isActive: false })).status, 400);
  eq('omitting notes in an update keeps the existing notes', (await call(A, 'PUT', `/recurring/${rent.id}`, { amount: 1200 })).data.recurring.notes, 'flat 4B');
  eq('empty string clears notes explicitly', (await call(A, 'PUT', `/recurring/${rent.id}`, { notes: '' })).data.recurring.notes, null);
  eq('empty update => 400', (await call(A, 'PUT', `/recurring/${gym.id}`, {})).status, 400);
  eq('no token => 401', (await call(null, 'GET', '/recurring')).status, 401);
  eq('process without token => 401 (no anonymous trigger)', (await call(null, 'POST', '/recurring/process')).status, 401);

  // ================= isolation =================
  const gymTx = (await byRec(A, rent.id)).length;
  eq('B sees no schedules', (await call(B, 'GET', '/recurring')).data.recurring, []);
  for (const [name, method, path, body] of [['read', 'GET', `/recurring/${gym.id}`], ['edit', 'PUT', `/recurring/${gym.id}`, { amount: 1 }], ['delete', 'DELETE', `/recurring/${gym.id}`], ['pause', 'POST', `/recurring/${gym.id}/pause`], ['resume', 'POST', `/recurring/${gym.id}/resume`, {}], ['occurrences', 'GET', `/recurring/${gym.id}/occurrences`]]) {
    eq(`B cannot ${name} A's schedule (404)`, (await call(B, method, path, body)).status, 404);
  }
  await prisma.recurringTransaction.update({ where: { id: gym.id }, data: { startDate: D(dd(-1)), nextOccurrence: D(dd(-1)) } }); // make A's gym due
  const bRun = (await call(B, 'POST', '/recurring/process')).data;
  eq("B's manual run touches nothing of A's", [bRun.schedules, await prisma.transaction.count({ where: { recurringId: gym.id } })], [0, 0]);
  eq("A's schedule is untouched by all of B's attempts", [(await call(A, 'GET', `/recurring/${gym.id}`)).data.recurring.amount, (await call(A, 'GET', `/recurring/${gym.id}`)).data.recurring.status], [500, 'active']);
  await call(A, 'POST', '/recurring/process');
  const mine = await byRec(A, gym.id);
  eq("when A's schedule runs, the transaction belongs to A and B never sees it", [mine.length, (await txs(B)).length, (await prisma.transaction.findFirst({ where: { recurringId: gym.id } })).userId === Aid], [1, 0, true]);
  eq('B has no recurring notifications', (await call(B, 'GET', '/notifications')).data.notifications.filter((n) => n.type === 'RECURRING').length, 0);
  void Bid; void gymTx;

  // ================= limit =================
  const L = await register('r12limit');
  let last;
  for (let i = 0; i < 100; i++) last = await call(L, 'POST', '/recurring', { title: `s${i}`, type: 'EXPENSE', amount: 1, category: 'x', frequency: 'MONTHLY', startDate: dd(30) });
  eq('100 schedules allowed', last.status, 201);
  eq('101st => 409', (await call(L, 'POST', '/recurring', { title: 'one more', type: 'EXPENSE', amount: 1, category: 'x', frequency: 'MONTHLY', startDate: dd(30) })).status, 409);

  await prisma.$disconnect();
  done();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
