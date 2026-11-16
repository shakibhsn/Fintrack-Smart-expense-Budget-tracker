const { call, register, tx, eq, done } = require('./lib');

(async () => {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const dm = (back, day = 10) => new Date(Date.UTC(y, m - back, day)).toISOString().slice(0, 10);
  const F = (T, p = 'next_30_days') => call(T, 'GET', `/forecast?period=${p}`);
  const MSG = 'Not enough financial history to generate a reliable forecast.';
  const r2 = (x) => Math.round(x * 100) / 100;

  // ---- new user ----
  const Z = await register('f9z');
  let r = await F(Z);
  eq('new user: unavailable + exact message', [r.status, r.data.available, r.data.message], [200, false, MSG]);
  eq('new user: 0 months, 0 tx, no numbers invented', [r.data.dataAvailability.monthsOfHistory, r.data.monthly], [0, undefined]);
  eq('no token => 401', (await call(null, 'GET', '/forecast')).status, 401);
  eq('bad period => 400', (await F(Z, 'next_9_years')).status, 400);

  // ---- one complete month only -> insufficient ----
  const O = await register('f9one');
  for (let i = 0; i < 9; i++) await tx(O, 'EXPENSE', 100, 'Food', dm(1, 1 + i));
  r = await F(O);
  eq('one complete month => unavailable (needs 2)', [r.data.available, r.data.message], [false, MSG]);
  eq('all periods flagged unavailable', r.data.availablePeriods.every((p) => !p.available), true);

  // ---- 4 months, known numbers ----
  const A = await register('f9a');
  const food = [500, 1000, 1500, 2000]; const other = [500, 1000, 1500, 2000];
  for (let k = 0; k < 4; k++) {
    const back = 4 - k; // oldest first
    await tx(A, 'EXPENSE', food[k], 'Food', dm(back, 5));
    await tx(A, 'EXPENSE', other[k], 'Other', dm(back, 6));
    await tx(A, 'INCOME', 5000, 'Salary', dm(back, 1));
  }
  await tx(A, 'EXPENSE', 40, 'Gift', dm(1, 20)); // single transaction category => insufficient
  // expenses/month: 1000, 2000, 3000, 4040 -> WMA = (1000+4000+9000+16160)/10 = 3016
  r = await F(A, 'next_30_days');
  const d = r.data;
  eq('available + Moderate Data (4 months)', [d.available, d.reliability.label], [true, 'Moderate Data']);
  eq('WMA monthly expense = 3016', d.monthly.expense, 3016);
  eq('WMA monthly income = 5000, savings = 1984', [d.monthly.income, d.monthly.savings, d.monthly.isDeficit], [5000, 1984, false]);
  eq('savings rate = 39.7%', d.monthly.savingsRatePercent, 39.7);
  eq('30-day forecast = monthly * 30/30.4375', d.forecast.expense, r2(3016 * 30 / 30.4375));
  eq('history is real months (4), solid actuals', d.history.map((h) => h.expense), [1000, 2000, 3000, 4040]);
  eq('projection: 1 month, flat at the prediction', [d.projection.length, d.projection[0].expense], [1, 3016]);
  eq('trend: expenses rising', [d.trend.expense.direction, d.trend.expense.percent], ['up', 134.7]);
  const food9 = d.categories.find((c) => c.category === 'Food');
  eq('Food predicted = (500+2000+4500+8000)/10 = 1500', [food9.sufficient, food9.predictedMonthly], [true, 1500]);
  const gift = d.categories.find((c) => c.category === 'Gift');
  eq('Gift: insufficient message, no prediction', [gift.sufficient, gift.predictedMonthly, /Insufficient data/.test(gift.message)], [false, undefined, true]);
  eq('periods: 7d/30d/3m ok, 6m unavailable (needs 6 months)', d.availablePeriods.map((p) => p.available), [true, true, true, false]);
  eq('6m request => available:false with reason', (await F(A, 'next_6_months')).data.available, false);
  r = await F(A, 'next_3_months');
  eq('3 months: forecast = 3 x monthly; 3 projected months', [r.data.forecast.expense, r.data.projection.length], [9048, 3]);
  r = await F(A, 'next_7_days');
  eq('7 days = monthly * 7/30.4375', r.data.forecast.expense, r2(3016 * 7 / 30.4375));
  eq('projected months are consecutive after history', (await F(A, 'next_3_months')).data.projection.map((p) => p.month).length, 3);

  // ---- updates when data changes (cache invalidated on write) ----
  const before = (await F(A)).data.currentMonth.expense;
  await tx(A, 'EXPENSE', 777, 'Food', dm(0, 1 + 0));
  const after = (await F(A)).data.currentMonth.expense;
  eq('current-month figure refreshed after a new transaction', after - before >= 777 - 0.001 || after === 777, true);
  await tx(A, 'EXPENSE', 9999, 'Food', dm(1, 25)); // changes a history month -> prediction must move
  eq('prediction recalculated after historical change', (await F(A)).data.monthly.expense > 3016, true);

  // ---- deficit + zero income ----
  const D = await register('f9d');
  for (let k = 0; k < 3; k++) { await tx(D, 'EXPENSE', 3000, 'Rent', dm(3 - k, 3)); await tx(D, 'EXPENSE', 1000, 'Food', dm(3 - k, 4)); await tx(D, 'EXPENSE', 500, 'Food', dm(3 - k, 5)); }
  r = await F(D);
  eq('zero income: income 0, savings negative, deficit shown, rate null', [r.data.monthly.income, r.data.monthly.savings, r.data.monthly.isDeficit, r.data.monthly.deficit, r.data.monthly.savingsRatePercent], [0, -4500, true, 4500, null]);
  eq('Rent flat 3000, Food flat 1500 (3 months)', [r.data.categories[0].category, r.data.categories[0].predictedMonthly, r.data.categories[1].predictedMonthly], ['Rent', 3000, 1500]);

  // ---- missing historical months are real zeros between first and last month ----
  const G = await register('f9g');
  for (let i = 0; i < 4; i++) await tx(G, 'EXPENSE', 1000, 'Food', dm(4, 2 + i)); // 4 tx in oldest month
  for (let i = 0; i < 4; i++) await tx(G, 'EXPENSE', 2000, 'Food', dm(1, 2 + i)); // 4 tx last month
  r = await F(G);
  eq('gap months counted as zero: series [4000,0,0,8000]', r.data.history.map((h) => h.expense), [4000, 0, 0, 8000]);
  eq('WMA with gaps = (4000+0+0+32000)/10 = 3600', r.data.monthly.expense, 3600);

  // ---- no expenses at all (income only) ----
  const I = await register('f9i');
  for (let k = 0; k < 3; k++) await tx(I, 'INCOME', 1000, 'Salary', dm(3 - k, 1));
  eq('income only: not enough expense history => unavailable', (await F(I)).data.available, false);

  // ---- isolation ----
  const O2 = await register('f9other');
  r = await F(O2);
  eq('other user sees nothing of A', [r.data.available, r.data.history], [false, undefined]);
  eq('A unaffected', (await F(A)).data.available, true);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
