const { call, register, tx, eq, done, stamp } = require('./lib');
const BASE = process.env.BASE || 'http://localhost:5055/api';

(async () => {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const d = (mm, dd) => new Date(Date.UTC(y, mm, dd)).toISOString().slice(0, 10);

  // ---- auth ----
  const email = `reg.${Date.now()}@test.dev`;
  let r = await call(null, 'POST', '/auth/register', { name: 'Reg User', email, password: 'secret123' });
  eq('register 201 + token', [r.status, !!r.data.token], [201, true]);
  const T = r.data.token;
  eq('duplicate email => 409', (await call(null, 'POST', '/auth/register', { name: 'x', email, password: 'secret123' })).status, 409);
  eq('short password => 400', (await call(null, 'POST', '/auth/register', { name: 'x', email: 'a@b.co', password: '123' })).status, 400);
  eq('login ok', (await call(null, 'POST', '/auth/login', { email, password: 'secret123' })).status, 200);
  eq('login wrong password => 401', (await call(null, 'POST', '/auth/login', { email, password: 'nope-nope' })).status, 401);
  eq('/auth/me', (await call(T, 'GET', '/auth/me')).data.user.email, email);
  eq('garbage token => 401 (expired/invalid)', (await call('abc.def.ghi', 'GET', '/transactions')).status, 401);
  eq('no token => 401 on every data route', await Promise.all(['/transactions', '/budgets', '/goals', '/dashboard', '/analytics/overview', '/insights', '/health-score', '/notifications'].map(async (p) => (await call(null, 'GET', p)).status)), Array(8).fill(401));

  // ---- transactions CRUD + validation ----
  r = await call(T, 'POST', '/transactions', { type: 'EXPENSE', amount: 250.5, category: 'Food', description: 'Lunch', notes: 'with team', date: d(m, 2) });
  eq('create tx', [r.status, r.data.transaction.amount, r.data.transaction.notes], [201, 250.5, 'with team']);
  const id = r.data.transaction.id;
  await tx(T, 'INCOME', 5000, 'Salary', d(m, 1)); await tx(T, 'EXPENSE', 100, 'Transport', d(m, 3), 'Bus');
  eq('amount 0 => 400', (await call(T, 'POST', '/transactions', { type: 'EXPENSE', amount: 0, category: 'x', description: 'x', date: d(m, 1) })).status, 400);
  eq('bad type => 400', (await call(T, 'POST', '/transactions', { type: 'NOPE', amount: 1, category: 'x', description: 'x', date: d(m, 1) })).status, 400);
  r = await call(T, 'PUT', `/transactions/${id}`, { amount: 300 });
  eq('update tx', r.data.transaction.amount, 300);
  eq('get tx', (await call(T, 'GET', `/transactions/${id}`)).data.transaction.description, 'Lunch');
  const list = async (q) => (await call(T, 'GET', `/transactions?${q}`)).data;
  eq('list total', (await list('')).transactions.length, 3);
  eq('filter type', (await list('type=INCOME')).transactions.length, 1);
  eq('filter category', (await list('category=Food')).transactions.length, 1);
  eq('search description', (await list('search=bus')).transactions.length, 1);
  eq('search notes', (await list('search=team')).transactions.length, 1);
  eq('amount range', (await list('minAmount=200&maxAmount=400')).transactions.map((t) => t.amount), [300]);
  eq('date range inclusive', (await list(`dateFrom=${d(m, 1)}&dateTo=${d(m, 2)}`)).transactions.length, 2);
  eq('sort amount-asc', (await list('sort=amount-asc')).transactions.map((t) => t.amount), [100, 300, 5000]);
  eq('pagination', (await list('limit=2&page=2')).transactions.length, 1);

  // ---- budgets ----
  const bs = d(m, 1); const be = d(m + 1, 0);
  r = await call(T, 'POST', '/budgets', { category: 'Food', limit: 400, startDate: bs, endDate: be });
  eq('create budget', r.status, 201);
  const bid = r.data.budget.id;
  eq('budget spent/pct computed from transactions', [r.data.budget.spent, r.data.budget.percentage, r.data.budget.remaining, r.data.budget.status], [300, 75, 100, 'active']);
  eq('overlapping budget => 409', (await call(T, 'POST', '/budgets', { category: 'Food', limit: 1, startDate: bs, endDate: be })).status, 409);
  eq('end<start => 400', (await call(T, 'POST', '/budgets', { category: 'X', limit: 1, startDate: be, endDate: bs })).status, 400);
  r = await call(T, 'PUT', `/budgets/${bid}`, { limit: 250 });
  eq('update budget: now over by 50', [r.data.budget.isOverBudget, r.data.budget.overBy], [true, 50]);
  eq('budget summary', (await call(T, 'GET', '/budgets/summary')).data.totalSpent, 300);
  await tx(T, 'EXPENSE', 10, 'Food', d(m, 3)); // triggers exceed notification
  const notes = (await call(T, 'GET', '/notifications')).data;
  eq('budget exceeded notification created (once)', notes.notifications.filter((n) => n.type === 'BUDGET_EXCEEDED').length, 1);
  eq('welcome notification exists', notes.notifications.some((n) => n.title === 'Welcome to FinTrack'), true);
  eq('mark all read', (await call(T, 'PATCH', '/notifications/read-all')).status, 200);

  // ---- dashboard ----
  r = await call(T, 'GET', '/dashboard?period=month');
  eq('dashboard totals', [r.data.summary.totalIncome, r.data.summary.totalExpense, r.data.summary.balance], [5000, 410, 4590]);
  eq('dashboard savingsRate', r.data.summary.savingsRate, 91.8);
  eq('dashboard recent + categories', [r.data.recentTransactions.length, r.data.categoryExpenses[0].category], [4, 'Food']);
  eq('dashboard period=year ok', (await call(T, 'GET', '/dashboard?period=year')).status, 200);
  eq('dashboard bad period => 400', (await call(T, 'GET', '/dashboard?period=zzz')).status, 400);
  eq('analytics monthly/categories/forecast still work', await Promise.all(['/analytics/monthly', '/analytics/categories', '/analytics/forecast', '/analytics/income-expense'].map(async (p) => (await call(T, 'GET', p)).status)), [200, 200, 200, 200]);

  // ---- isolation across ALL resources ----
  const O = await register('regother');
  eq('other: empty tx list', (await call(O, 'GET', '/transactions')).data.transactions.length, 0);
  eq('other: cannot read tx', (await call(O, 'GET', `/transactions/${id}`)).status, 404);
  eq('other: cannot edit tx', (await call(O, 'PUT', `/transactions/${id}`, { amount: 1 })).status, 404);
  eq('other: cannot delete tx', (await call(O, 'DELETE', `/transactions/${id}`)).status, 404);
  eq('other: cannot edit budget', (await call(O, 'PUT', `/budgets/${bid}`, { limit: 1 })).status, 404);
  eq('other: cannot delete budget', (await call(O, 'DELETE', `/budgets/${bid}`)).status, 404);
  eq('other: no budgets/notifications of mine', [(await call(O, 'GET', '/budgets')).data.budgets.length, (await call(O, 'GET', '/notifications')).data.notifications.some((n) => /Food/.test(n.message))], [0, false]);
  eq('other: dashboard is empty', (await call(O, 'GET', '/dashboard')).data.summary.totalIncome, 0);
  eq('my tx untouched', (await call(T, 'GET', `/transactions/${id}`)).data.transaction.amount, 300);

  // ---- deletes ----
  eq('delete tx', (await call(T, 'DELETE', `/transactions/${id}`)).status, 200);
  eq('delete budget (transactions unaffected)', [(await call(T, 'DELETE', `/budgets/${bid}`)).status, (await list('')).transactions.length], [200, 3]);
  eq('unknown route => 404 JSON', (await call(T, 'GET', '/nope')).status, 404);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
