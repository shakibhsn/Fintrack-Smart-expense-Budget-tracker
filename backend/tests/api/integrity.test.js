// Phase 19: financial data integrity. Exact decimals, boundaries, empty/zero/negative cases, consistency across Dashboard / Analytics / Reports / exports, concurrency.
const { prisma } = require('./dbenv');
const { call, register, eq, done } = require('./lib');
const ROOT = require('path').join(__dirname, '..', '..');
const { resolveAnalyticsPeriod } = require(`${ROOT}/src/utils/dateRange`);
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));
const m1 = (o, day = 1) => iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + o, day)));
const uidOf = async (p) => (await prisma.user.findFirst({ where: { email: { startsWith: p } }, orderBy: { createdAt: 'desc' } })).id;
const tx = (T, type, amount, category, date, description = 'x') => call(T, 'POST', '/transactions', { type, amount, category, description, date });

(async () => {
  // ================= exact decimals =================
  const A = await register('int-a'); const aid = await uidOf('int-a.');
  await prisma.transaction.createMany({ data: Array.from({ length: 1000 }, () => ({ userId: aid, type: 'EXPENSE', amount: 0.1, category: 'Food', description: 'dime', date: new Date(`${m1(0)}T00:00:00Z`) })) });
  await prisma.transaction.createMany({ data: Array.from({ length: 300 }, () => ({ userId: aid, type: 'INCOME', amount: 0.3, category: 'Salary', description: 'tiny', date: new Date(`${m1(0)}T00:00:00Z`) })) });
  const dash = (await call(A, 'GET', '/dashboard?period=month')).data;
  const an = (await call(A, 'GET', '/analytics/overview?period=this_month')).data;
  const rep = (await call(A, 'GET', '/reports?period=this_month')).data;
  eq('1000 x 0.10 expenses and 300 x 0.30 income: exactly 100.00 / 90.00 everywhere (no floating-point drift)', [dash.summary.totalExpense, dash.summary.totalIncome, an.summary.expense, an.summary.income, rep.summary.expense, rep.summary.income, an.summary.savings], [100, 90, 100, 90, 100, 90, -10]);
  const csv = (await fetch('http://localhost:5055/api/export/transactions', { headers: { Authorization: `Bearer ${A}` } }).then((r) => r.text())).split('\r\n').filter(Boolean).slice(1);
  eq('CSV export amounts are exact and sum to the same totals', [csv.length, Math.round(csv.reduce((s, l) => s + (l.split(',')[1] === 'EXPENSE' ? Number(l.split(',')[2]) * 100 : 0), 0))], [1300, 10000]);
  const g = (await call(A, 'POST', '/goals', { title: 'Cents', targetAmount: 10 })).data.goal;
  for (let i = 0; i < 3; i += 1) await call(A, 'POST', `/goals/${g.id}/contributions`, { amount: 0.1 });
  eq('goal: 3 x 0.10 contributions = exactly 0.30 (stored and shown)', [(await call(A, 'GET', `/goals/${g.id}`)).data.goal.savedAmount, Number((await prisma.savingsGoal.findUnique({ where: { id: g.id } })).savedAmount)], [0.3, 0.3]);

  // ================= amount / date validation =================
  const bad = async (amount) => (await tx(A, 'EXPENSE', amount, 'Food', dd(-1))).status;
  eq('more than 2 decimals is refused instead of being silently rounded (10.999 / 0.005); 10.99 and 10.1 accepted', [await bad(10.999), await bad(0.005), await bad(10.99), await bad(10.1), await bad('10.50')], [400, 400, 201, 201, 201]);
  eq('largest amount accepted (999,999,999.99); one cent more refused', [await bad(999999999.99), await bad(1000000000)], [201, 400]);
  const big = await prisma.transaction.aggregate({ where: { userId: aid, amount: { gte: 999999999 } }, _sum: { amount: true } });
  eq('sum of huge amounts stays exact in the database', Number(big._sum.amount), 999999999.99);
  await prisma.transaction.deleteMany({ where: { userId: aid, amount: { gte: 999999999 } } });

  // ================= empty / zero / negative =================
  const Z = await register('int-z');
  const routes = ['/dashboard?period=month', '/analytics/overview?period=this_month', '/reports?period=this_month', '/insights', '/health-score', '/forecast', '/unusual-spending', '/subscriptions/summary', '/budgets/summary', '/goals/summary', '/analytics/monthly', '/notifications', '/recurring', '/simulations/baseline', '/ai/recommendations'];
  const zr = await Promise.all(routes.map(async (p) => (await call(Z, 'GET', p)).status));
  eq('a brand-new account: every read endpoint answers 200 (nothing throws on empty data)', zr, routes.map(() => 200));
  const zd = (await call(Z, 'GET', '/dashboard?period=month')).data; const za = (await call(Z, 'GET', '/analytics/overview?period=this_month')).data; const zrp = (await call(Z, 'GET', '/reports?period=this_month')).data;
  eq('empty account: zero totals, no NaN anywhere, savings rate null in analytics and reports', [zd.summary.totalIncome, zd.summary.totalExpense, za.summary.savingsRate, zrp.summary.savingsRate, JSON.stringify([zd, za, zrp]).includes('NaN')], [0, 0, null, null, false]);
  await tx(Z, 'EXPENSE', 250, 'Food', m1(0));
  const zi = (await call(Z, 'GET', '/dashboard?period=month')).data; const zai = (await call(Z, 'GET', '/analytics/overview?period=this_month')).data;
  eq('expenses but ZERO income: savings rate is null/"not available" consistently (never a misleading 0%), balance negative', [zi.summary.savingsRate, zai.summary.savingsRate, zi.summary.balance, zai.summary.savings], [null, null, -250, -250]);
  await tx(Z, 'INCOME', 100, 'Salary', m1(0));
  const zn = (await call(Z, 'GET', '/dashboard?period=month')).data;
  eq('negative savings with income: rate is negative (-150%), consistent across pages', [zn.summary.savingsRate, (await call(Z, 'GET', '/analytics/overview?period=this_month')).data.summary.savingsRate, (await call(Z, 'GET', '/reports?period=this_month')).data.summary.savingsRate], [-150, -150, -150]);

  // ================= budgets: boundaries =================
  const Bx = await register('int-b');
  await call(Bx, 'POST', '/budgets', { category: 'Food', limit: 1000, startDate: '2024-02-01', endDate: '2024-02-29' });
  for (const [d, a, t] of [['2024-01-31', 1, 'EXPENSE'], ['2024-02-01', 10, 'EXPENSE'], ['2024-02-29', 100, 'EXPENSE'], ['2024-03-01', 1000, 'EXPENSE'], ['2024-02-15', 7, 'INCOME']]) await tx(Bx, t, a, 'Food', d);
  await tx(Bx, 'EXPENSE', 5, 'Transport', '2024-02-10');
  const bud = (await call(Bx, 'GET', '/budgets')).data.budgets[0];
  eq('budget range is inclusive on both end days (leap day 29 Feb counted), day before/after excluded, income and other categories ignored', [bud.spent, bud.remaining, bud.percentage], [110, 890, 11]);
  eq('analytics custom range over a leap February includes 29 Feb and excludes 1 Mar', await (async () => { const r = (await call(Bx, 'GET', '/analytics/overview?period=custom&startDate=2024-02-01&endDate=2024-02-29')).data; return [r.summary.expense, r.range.days ?? r.range.start]; })(), [115, 29]);
  const rangeOf = (period, now) => { const p = resolveAnalyticsPeriod(period, undefined, undefined, new Date(`${now}T10:00:00Z`)); return [p.range.start, p.range.end]; };
  eq('period maths at year / month / leap boundaries', [rangeOf('last_month', '2024-03-01'), rangeOf('last_month', '2025-01-15'), rangeOf('this_month', '2024-02-29'), rangeOf('last_3_months', '2024-01-31'), rangeOf('this_year', '2024-12-31')], [['2024-02-01', '2024-02-29'], ['2024-12-01', '2024-12-31'], ['2024-02-01', '2024-02-29'], ['2023-11-01', '2024-01-31'], ['2024-01-01', '2024-12-31']]);
  const prevMs = resolveAnalyticsPeriod('this_month', undefined, undefined, new Date('2024-03-31T10:00:00Z'));
  eq('"this month" on the 31st compares with the same number of days of the previous month, never spilling into March', [prevMs.previousRange.start, prevMs.previousRange.end], ['2024-02-01', '2024-02-29']);

  // ================= no double counting =================
  const Gx = await register('int-g'); const gid = await uidOf('int-g.');
  await tx(Gx, 'INCOME', 1000, 'Salary', m1(0)); await tx(Gx, 'EXPENSE', 300, 'Food', m1(0));
  const goal = (await call(Gx, 'POST', '/goals', { title: 'Trip', targetAmount: 5000 })).data.goal;
  const before = (await call(Gx, 'GET', '/analytics/overview?period=this_month')).data.summary;
  await call(Gx, 'POST', `/goals/${goal.id}/contributions`, { amount: 400 });
  const after = (await call(Gx, 'GET', '/analytics/overview?period=this_month')).data.summary; const dAfter = (await call(Gx, 'GET', '/dashboard?period=month')).data.summary; const rAfter = (await call(Gx, 'GET', '/reports?period=this_month')).data.summary;
  eq('a goal contribution never changes income / expenses / savings anywhere (it is an allocation, not a transaction)', [after.income, after.expense, after.savings, dAfter.totalExpense, rAfter.savings, await prisma.transaction.count({ where: { userId: gid } })], [before.income, before.expense, before.savings, 300, 700, 2]);
  const over = await call(Gx, 'POST', `/goals/${goal.id}/contributions`, { amount: 4601 }); // allowed by design: progress is capped at 100% but the real amount is kept (Phase 6)
  eq('over-funding a goal is allowed by design; saved stays EXACTLY the sum of its contributions and the progress bar caps at 100%', [over.status, (await call(Gx, 'GET', `/goals/${goal.id}`)).data.goal.savedAmount, (await call(Gx, 'GET', `/goals/${goal.id}`)).data.goal.progress], [201, 5001, 100]);
  await call(Gx, 'DELETE', `/goals/${goal.id}`);
  eq('deleting a goal removes its contributions and leaves transactions untouched', [await prisma.goalContribution.count({ where: { userId: gid } }), await prisma.transaction.count({ where: { userId: gid } })], [0, 2]);

  // ================= concurrency =================
  const C = await register('int-c'); const cid = await uidOf('int-c.');
  const par = await Promise.all(Array.from({ length: 40 }, (_, i) => tx(C, 'EXPENSE', 1.25, 'Food', dd(-1), `par ${i}`)));
  eq('40 simultaneous transaction creates: all stored, totals exact', [par.every((r) => r.status === 201), (await call(C, 'GET', '/dashboard?period=month')).data.summary.totalExpense >= 0, Number((await prisma.transaction.aggregate({ where: { userId: cid }, _sum: { amount: true } }))._sum.amount)], [true, true, 50]);
  const one = par[0].data.transaction.id;
  const dels = await Promise.all([1, 2, 3, 4, 5].map(() => call(C, 'DELETE', `/transactions/${one}`)));
  eq('5 simultaneous deletes of one transaction: exactly one succeeds, the rest 404, no 500', [dels.filter((r) => r.status === 200).length, dels.filter((r) => r.status === 404).length, dels.some((r) => r.status >= 500)], [1, 4, false]);
  const edits = await Promise.all(Array.from({ length: 10 }, (_, i) => call(C, 'PUT', `/transactions/${par[1].data.transaction.id}`, { amount: 10 + i })));
  eq('10 simultaneous edits: all succeed and the row holds exactly one of the submitted values', [edits.every((r) => r.status === 200), Number((await prisma.transaction.findUnique({ where: { id: par[1].data.transaction.id } })).amount) >= 10], [true, true]);
  const bud2 = await Promise.all(Array.from({ length: 8 }, () => call(C, 'POST', '/budgets', { category: 'Race', limit: 100, startDate: m1(0), endDate: m1(0, 28) })));
  eq('8 simultaneous overlapping budgets for one category: exactly ONE is created (overlap rule holds under concurrency)', [bud2.filter((r) => r.status === 201).length, bud2.filter((r) => r.status === 409).length, await prisma.budget.count({ where: { userId: cid, category: 'Race' } })], [1, 7, 1]);
  const gl = (await call(C, 'POST', '/goals', { title: 'Race goal', targetAmount: 100 })).data.goal;
  const contribs = await Promise.all(Array.from({ length: 20 }, () => call(C, 'POST', `/goals/${gl.id}/contributions`, { amount: 10 })));
  const saved = Number((await prisma.savingsGoal.findUnique({ where: { id: gl.id } })).savedAmount);
  const sum = Number((await prisma.goalContribution.aggregate({ where: { goalId: gl.id }, _sum: { amount: true } }))._sum.amount);
  eq('20 simultaneous contributions of 10: all recorded, saved equals the sum of the contribution rows exactly (no lost updates), no 500', [saved, sum, contribs.filter((r) => r.status === 201).length, contribs.some((r) => r.status >= 500)], [200, 200, 20, false]);

  // ================= pagination consistency =================
  const pg = (await call(A, 'GET', '/transactions?limit=100&page=3')).data;
  eq('pagination: page counts add up, limit above 500 refused, page 0 refused', [pg.pagination.total >= 1300, pg.transactions.length, (await call(A, 'GET', '/transactions?limit=501')).status, (await call(A, 'GET', '/transactions?page=0')).status], [true, 100, 400, 400]);
  const ids = new Set(); for (let p = 1; p <= 14; p += 1) (await call(A, 'GET', `/transactions?limit=100&page=${p}`)).data.transactions.forEach((t) => ids.add(t.id));
  eq('walking every page returns every row exactly once (stable ordering, no duplicates or gaps)', ids.size, (await call(A, 'GET', '/transactions?limit=1')).data.pagination.total);

  done();
})().catch((e) => { console.error(e); process.exit(1); });
