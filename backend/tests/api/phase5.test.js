const { call, register, tx, eq, done } = require('./lib');

(async () => {
  // Fixed "today" assumption: tests run relative to the real current date.
  const now = new Date();
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const d = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  const today = now.getUTCDate();
  // Needs today >= 5 so the "same 5 days of last month" window is meaningful.
  if (today < 5 || today > 26) { console.log('Run this test between the 5th and the 26th (fixtures place "outside the window" items on day 27)'); process.exit(2); }

  const A = await register('a'); const B = await register('b'); const C = await register('c'); const D = await register('d');

  // ---- user A ----
  await tx(A, 'INCOME', 50000, 'Salary', d(y, m, 1));
  await tx(A, 'EXPENSE', 2000, 'Food', d(y, m, 2));
  await tx(A, 'EXPENSE', 500, 'Transport', d(y, m, 3));
  // last month: 1st income, food on day 5 (inside the first-5-days window), later items outside it
  await tx(A, 'INCOME', 40000, 'Salary', d(y, m - 1, 1));
  await tx(A, 'EXPENSE', 3000, 'Food', d(y, m - 1, 5));
  await tx(A, 'EXPENSE', 500, 'Transport', d(y, m - 1, 27));
  await tx(A, 'EXPENSE', 1000, 'Food', d(y, m - 1, 27));
  await tx(A, 'EXPENSE', 100, 'Misc', d(y, m, 0));        // last day of last month (boundary)
  await tx(A, 'EXPENSE', 700, 'Food', d(y, m - 2, 15));   // two months ago
  // ---- user B (must never leak into A) ----
  await tx(B, 'EXPENSE', 99999, 'Food', d(y, m, 2));
  // ---- user C: expense only (zero income) ----
  await tx(C, 'EXPENSE', 300, 'Food', d(y, m, 2));

  let r = await call(A, 'GET', '/analytics/overview?period=this_month');
  eq('this_month status', r.status, 200);
  eq('this_month income', r.data.summary.income, 50000);
  eq('this_month expense (2000+500, B excluded)', r.data.summary.expense, 2500);
  eq('this_month savings', r.data.summary.savings, 47500);
  eq('this_month savingsRate', r.data.summary.savingsRate, 95);
  eq('this_month previous range', r.data.previousRange.start, d(y, m - 1, 1));
  eq('previous window is same #days', r.data.previousRange.days, r.data.range.days);
  eq('prev expense = only first N days of last month', r.data.previousSummary.expense, today >= 5 ? 3000 : null);
  eq('income change %', r.data.comparison.income.changePercent, 25);
  eq('expense change % (2500 vs 3000)', r.data.comparison.expense.changePercent, -16.7);
  eq('expense message', r.data.comparison.expense.message, 'Expenses decreased by 16.7%.');
  eq('categories sorted', r.data.expenseCategories.map((c) => c.category), ['Food', 'Transport']);
  eq('food share', r.data.expenseCategories[0].percentage, 80);
  eq('income categories', r.data.incomeCategories.map((c) => [c.category, c.amount]), [['Salary', 50000]]);
  eq('daily granularity', r.data.granularity, 'day');
  eq('series length = days elapsed', r.data.series.length, today);
  eq('series sums to expense', r.data.series.reduce((s, p) => s + p.expense, 0), 2500);
  eq('hasData', r.data.hasData, true);
  eq('series sums to income (first-day boundary)', r.data.series.reduce((s, p) => s + p.income, 0), 50000);
  eq('series sums to savings', r.data.series.reduce((s, p) => s + p.savings, 0), 47500);
  eq('first bucket has the 1st-of-month income', r.data.series[0].income, 50000);

  r = await call(A, 'GET', '/analytics/overview?period=last_month');
  eq('last_month income', r.data.summary.income, 40000);
  eq('last_month expense incl. boundary 100 on last day', r.data.summary.expense, 4600);
  eq('last_month prev (2 months ago) has data', r.data.comparison.available, true);
  eq('income vs prev 0 => no percent', r.data.comparison.income.changePercent, null);
  eq('income vs prev 0 message mentions amount not %', /by ৳40,000/.test(r.data.comparison.income.message), true);
  eq('category change message', r.data.comparison.categories.find((c) => c.category === 'Food').message, 'Food spending increased by ৳3,300.');
  eq('monthly granularity? (month = >31 days only when 31+, else day)', ['day', 'month'].includes(r.data.granularity), true);

  r = await call(A, 'GET', `/analytics/overview?period=custom&startDate=${d(y, m - 1, 1)}&endDate=${d(y, m, 0)}`);
  eq('custom == last_month expense (inclusive end date)', r.data.summary.expense, 4600);
  r = await call(A, 'GET', `/analytics/overview?period=custom&startDate=${d(y, m - 1, 1)}&endDate=${d(y, m - 1, 4)}`);
  eq('custom 4-day range excludes day 5 food', r.data.summary.expense, 0);
  eq('custom income only day1', r.data.summary.income, 40000);

  r = await call(A, 'GET', '/analytics/overview?period=last_3_months');
  eq('last_3_months income', r.data.summary.income, 90000);
  eq('last_3_months monthly granularity', r.data.granularity, 'month');
  eq('last_3_months series income sums', r.data.series.reduce((s, p) => s + p.income, 0), 90000);
  eq('last_3_months 3 buckets', r.data.series.length, 3);
  eq('last_3_months expense total', r.data.summary.expense, 2500 + 4600 + 700);
  r = await call(A, 'GET', '/analytics/overview?period=last_6_months');
  eq('last_6_months 6 buckets', r.data.series.length, 6);
  r = await call(A, 'GET', '/analytics/overview?period=this_year');
  eq('this_year ok', r.status, 200);
  eq('this_year includes everything this year (>=Jan)', r.data.summary.income >= 90000, true);

  // zero income
  r = await call(C, 'GET', '/analytics/overview?period=this_month');
  eq('zero income => savingsRate null', r.data.summary.savingsRate, null);
  eq('negative savings', r.data.summary.savings, -300);
  eq('no previous data => not comparable', r.data.comparison.available, false);
  eq('no previous data => no percent', r.data.comparison.expense.changePercent, null);
  eq('no previous data => message', /can't be compared/.test(r.data.comparison.expense.message), true);
  eq('no previous data => no category changes', r.data.comparison.categories, []);
  eq('no income categories', r.data.incomeCategories, []);

  // empty user
  r = await call(D, 'GET', '/analytics/overview?period=this_month');
  eq('empty: hasAnyTransactions false', r.data.hasAnyTransactions, false);
  eq('empty: hasData false', r.data.hasData, false);
  eq('empty: no categories', r.data.expenseCategories, []);
  eq('empty: zero summary', r.data.summary.income + r.data.summary.expense, 0);

  // user with data overall but none in selected window
  r = await call(A, 'GET', '/analytics/overview?period=custom&startDate=2001-01-01&endDate=2001-01-31');
  eq('window empty but account not: hasAnyTransactions true', r.data.hasAnyTransactions, true);
  eq('window empty: hasData false', r.data.hasData, false);

  // isolation
  r = await call(B, 'GET', '/analytics/overview?period=this_month');
  eq('user B sees only own 99999', r.data.summary.expense, 99999);

  // updates after transaction change
  const t = await tx(A, 'EXPENSE', 250, 'Food', d(y, m, 3));
  r = await call(A, 'GET', '/analytics/overview?period=this_month');
  eq('after add: expense updated', r.data.summary.expense, 2750);
  await call(A, 'DELETE', `/transactions/${t.data.transaction.id}`);
  r = await call(A, 'GET', '/analytics/overview?period=this_month');
  eq('after delete: expense restored', r.data.summary.expense, 2500);

  // validation / auth
  eq('bad period => 400', (await call(A, 'GET', '/analytics/overview?period=nope')).status, 400);
  eq('custom without dates => 400', (await call(A, 'GET', '/analytics/overview?period=custom')).status, 400);
  eq('custom end<start => 400', (await call(A, 'GET', '/analytics/overview?period=custom&startDate=2026-02-02&endDate=2026-02-01')).status, 400);
  eq('custom bad date => 400', (await call(A, 'GET', '/analytics/overview?period=custom&startDate=2026-13-45&endDate=2026-12-01')).status, 400);
  eq('no token => 401', (await call(null, 'GET', '/analytics/overview')).status, 401);
  eq('default period', (await call(A, 'GET', '/analytics/overview')).data.period, 'this_month');
  done();
})().catch((e) => { console.error(e); process.exit(1); });
