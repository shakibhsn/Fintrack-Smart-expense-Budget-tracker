const { call, register, tx, eq, done } = require('./lib');

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
(async () => {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const dm = (back, day = 10) => new Date(Date.UTC(y, m - back, day)).toISOString().slice(0, 10);
  const calc = (T, inputs, months) => call(T, 'POST', '/simulations/calculate', { inputs, ...(months ? { months } : {}) });
  const counts = async (T) => [
    (await call(T, 'GET', '/transactions?limit=1')).data.pagination.total,
    (await call(T, 'GET', '/budgets')).data.budgets.length,
    (await call(T, 'GET', '/goals')).data.goals.length,
    (await call(T, 'GET', '/dashboard?period=year')).data.summary.totalExpense,
  ];

  // 3 complete months: income 50000 ; Food 10000 + Shopping 15000 + Transport 10000 = 35000 expenses/month
  const A = await register('s11a');
  for (let b = 1; b <= 3; b++) {
    await tx(A, 'INCOME', 50000, 'Salary', dm(b, 1));
    await tx(A, 'EXPENSE', 10000, 'Food', dm(b, 5));
    await tx(A, 'EXPENSE', 15000, 'Shopping', dm(b, 6));
    await tx(A, 'EXPENSE', 10000, 'Transport', dm(b, 7));
  }
  await tx(A, 'EXPENSE', 999, 'Food', dm(0, 1)); // current (incomplete) month must NOT affect the baseline
  await call(A, 'POST', '/budgets', { category: 'Food', limit: 9000, startDate: dm(0, 1), endDate: dm(-1, 0) });
  await call(A, 'POST', '/goals', { title: 'Trip', targetAmount: 1000 });
  const before = await counts(A);

  // ---- baseline ----
  let r = await call(A, 'GET', '/simulations/baseline');
  const b = r.data;
  eq('baseline = real monthly averages of the last 3 complete months', [b.available, b.income, b.expense, b.referencePeriod.months], [true, 50000, 35000, 3]);
  eq('baseline categories (largest first)', b.categories, [{ category: 'Shopping', monthly: 15000 }, { category: 'Food', monthly: 10000 }, { category: 'Transport', monthly: 10000 }]);
  eq('months=1 uses a single month', (await call(A, 'GET', '/simulations/baseline?months=1')).data.referencePeriod.months, 1);
  eq('bad months => 400', (await call(A, 'GET', '/simulations/baseline?months=99')).status, 400);
  eq('no token => 401', (await call(null, 'GET', '/simulations/baseline')).status, 401);

  // ---- scenarios ----
  r = await calc(A, { categoryReductions: { Shopping: 20 } });
  let R = r.data.results;
  eq('reduce shopping 20%: shopping 12000, expenses 32000, savings 18000', [R.categories.find((c) => c.category === 'Shopping').simulated, R.simulated.expenses, R.simulated.savings], [12000, 32000, 18000]);
  eq('improvement 3000, expense reduction 3000, rate 30% -> 36%', [R.savingsImprovement, R.expenseReduction, R.current.savingsRatePercent, R.simulated.savingsRatePercent], [3000, 3000, 30, 36]);
  r = await calc(A, { incomeIncrease: 5000 });
  R = r.data.results;
  eq('income +5000: savings 15000 -> 20000, expenses unchanged', [R.simulated.income, R.simulated.savings, R.simulated.expenses, R.savingsImprovement], [55000, 20000, 35000, 5000]);
  r = await calc(A, { savingsTargetPct: 40 });
  R = r.data.results.savingsTarget;
  eq('target 40% of 50000 => max expenses 30000, need to cut 5000, not achieved', [R.available, R.requiredMaxExpenses, R.targetSavings, R.additionalReductionNeeded, R.achieved], [true, 30000, 20000, 5000, false]);
  r = await calc(A, { categoryReductions: { Food: 10, Shopping: 15 }, incomeIncrease: 3000 });
  R = r.data.results;
  eq('combined: food -10%, shopping -15%, income +3000', [R.simulated.expenses, R.simulated.income, R.simulated.savings, R.savingsImprovement, R.expenseReduction], [31750, 53000, 21250, 6250, 3250]);
  r = await calc(A, { categoryReductions: { Food: 10, Shopping: 15 }, incomeIncrease: 3000, savingsTargetPct: 40 });
  eq('combined + 40% target: max 31800 >= 31750 => achieved', [r.data.results.savingsTarget.requiredMaxExpenses, r.data.results.savingsTarget.achieved, r.data.results.savingsTarget.additionalReductionNeeded], [31800, true, 0]);
  r = await calc(A, { categoryReductions: { Food: 20 }, budgetAdjustments: { Food: 8000, Transport: 12000, Shopping: 0 } });
  const bc = Object.fromEntries(r.data.results.budgetComparison.map((x) => [x.category, x]));
  eq('budget: Food limit 8000 vs simulated spend 8000 => within', [bc.Food.simulatedSpend, bc.Food.difference, bc.Food.isOver, bc.Food.percentUsed], [8000, 0, false, 100]);
  eq('budget: Transport 12000 vs 10000 => 2000 under; limit 0 => over, no %', [bc.Transport.difference, bc.Transport.isOver, bc.Shopping.isOver, bc.Shopping.percentUsed], [2000, false, true, null]);
  r = await calc(A, {});
  eq('no adjustments => simulated equals current', [r.data.results.savingsImprovement, r.data.results.expenseReduction, r.data.results.simulated.savings], [0, 0, 15000]);
  r = await calc(A, { categoryReductions: { Food: 100, Shopping: 100, Transport: 100 } });
  eq('100% cuts => zero expenses, savings = income', [r.data.results.simulated.expenses, r.data.results.simulated.savings, r.data.results.simulated.savingsRatePercent], [0, 50000, 100]);

  // ---- validation ----
  eq('reduction > 100 => 400', (await calc(A, { categoryReductions: { Food: 150 } })).status, 400);
  eq('negative income increase => 400', (await calc(A, { incomeIncrease: -1 })).status, 400);
  eq('target > 100 => 400', (await calc(A, { savingsTargetPct: 101 })).status, 400);
  eq('non-numeric => 400', (await calc(A, { incomeIncrease: 'abc' })).status, 400);
  eq('unknown category => 400 with message', [(await calc(A, { categoryReductions: { Nope: 10 } })).status, (await calc(A, { categoryReductions: { Nope: 10 } })).json.message.includes('Nope')], [400, true]);
  eq('unknown input field => 400', (await calc(A, { magic: 1 })).status, 400);

  // ---- unusual baselines ----
  const Z = await register('s11z');
  r = await call(Z, 'GET', '/simulations/baseline');
  eq('new user: baseline unavailable, no invented numbers', [r.data.available, r.data.income, r.data.categories], [false, 0, []]);
  eq('new user: calculate => 409', (await calc(Z, {})).status, 409);
  const Cm = await register('s11cur');
  await tx(Cm, 'INCOME', 1000, 'Salary', dm(0, 1)); // only current month
  eq('only current-month data => unavailable', (await call(Cm, 'GET', '/simulations/baseline')).data.available, false);
  const NI = await register('s11noinc');
  for (let k = 1; k <= 3; k++) { await tx(NI, 'EXPENSE', 3000, 'Rent', dm(k, 3)); await tx(NI, 'EXPENSE', 1500, 'Food', dm(k, 4)); }
  r = await calc(NI, { categoryReductions: { Food: 10 }, savingsTargetPct: 20 });
  eq('zero income: negative savings, rate null, target explains it', [r.data.results.current.savings, r.data.results.current.savingsRatePercent, r.data.results.simulated.savings, r.data.results.savingsTarget.available, /needs some income/.test(r.data.results.savingsTarget.message)], [-4500, null, -4350, false, true]);
  r = await calc(NI, { incomeIncrease: 6000 });
  eq('zero income + income increase works', [r.data.results.simulated.savings, r.data.results.simulated.savingsRatePercent], [1500, 25]);
  const NE = await register('s11noexp');
  for (let k = 1; k <= 3; k++) await tx(NE, 'INCOME', 2000, 'Salary', dm(k, 1));
  r = await calc(NE, { incomeIncrease: 1000 });
  eq('zero expenses: savings = income, 100% rate', [r.data.results.current.expenses, r.data.results.current.savings, r.data.results.simulated.savings, r.data.results.categories], [0, 2000, 3000, []]);
  const NS = await register('s11neg');
  for (let k = 1; k <= 3; k++) { await tx(NS, 'INCOME', 1000, 'Salary', dm(k, 1)); await tx(NS, 'EXPENSE', 3000, 'Rent', dm(k, 2)); }
  r = await calc(NS, { categoryReductions: { Rent: 50 } });
  eq('negative savings baseline: -2000 -> -500 after 50% rent cut', [r.data.results.current.savings, r.data.results.simulated.savings, r.data.results.savingsImprovement], [-2000, -500, 1500]);
  const RD = await register('s11round');
  await tx(RD, 'INCOME', 10000, 'Salary', dm(1, 1)); await tx(RD, 'EXPENSE', 1000, 'Food', dm(1, 2)); await tx(RD, 'EXPENSE', 1, 'Food', dm(2, 2)); await tx(RD, 'EXPENSE', 1, 'Food', dm(3, 2));
  r = await calc(RD, { categoryReductions: { Food: 33.333 } });
  eq('rounding: 3-month averages to 2 decimals', [r.data.baseline.income, r.data.baseline.expense, r.data.results.simulated.expenses], [3333.33, 334, 222.67]);

  // ---- saving ----
  const inputs = { categoryReductions: { Food: 10, Shopping: 15 }, incomeIncrease: 3000, savingsTargetPct: 40, budgetAdjustments: { Food: 9000 } };
  r = await call(A, 'POST', '/simulations', { name: 'Tighten up', inputs });
  const sim = r.data.simulation;
  eq('save => 201 with server-calculated results + baseline snapshot + date', [r.status, sim.name, sim.results.simulated.savings, sim.baseline.referencePeriod.months, !!sim.createdAt], [201, 'Tighten up', 21250, 3, true]);
  eq('client cannot inject results/baseline (strict) => 400', (await call(A, 'POST', '/simulations', { name: 'x', inputs, results: { simulated: { savings: 999999 } } })).status, 400);
  eq('empty name => 400', (await call(A, 'POST', '/simulations', { name: '  ', inputs })).status, 400);
  eq('name > 100 chars => 400', (await call(A, 'POST', '/simulations', { name: 'x'.repeat(101), inputs })).status, 400);
  eq('invalid inputs not saved => 400', (await call(A, 'POST', '/simulations', { name: 'bad', inputs: { categoryReductions: { Food: 500 } } })).status, 400);
  eq('unavailable baseline cannot be saved => 409', (await call(Z, 'POST', '/simulations', { name: 'x', inputs: {} })).status, 409);
  eq('list has exactly the one saved', (await call(A, 'GET', '/simulations')).data.simulations.map((s) => s.name), ['Tighten up']);
  r = await call(A, 'GET', `/simulations/${sim.id}`);
  eq('get: unchanged data => recalculated equals saved, flag false', [r.data.simulation.dataChangedSinceSaved, canon(r.data.simulation.recalculated.results) === canon(sim.results)], [false, true]);

  // ---- data changes later: saved result stays, recalculated moves ----
  await tx(A, 'INCOME', 9000, 'Bonus', dm(1, 15)); // +3000/month average
  r = await call(A, 'GET', `/simulations/${sim.id}`);
  eq('later data change: saved result untouched', canon(r.data.simulation.results) === canon(sim.results), true);
  eq('...recalculated reflects new data (income 53000 base)', [r.data.simulation.dataChangedSinceSaved, r.data.simulation.recalculated.baseline.income, r.data.simulation.recalculated.results.simulated.income], [true, 53000, 56000]);

  // ---- real records never touched ----
  const after = await counts(A);
  eq('transactions/budgets/goals/totals unchanged by ALL simulations (only the +1 bonus tx I added)', [after[0], after[1], after[2]], [before[0] + 1, before[1], before[2]]);
  eq('dashboard expense total unchanged', after[3], before[3]);

  // ---- isolation + delete ----
  const O = await register('s11other');
  eq('other user: empty list', (await call(O, 'GET', '/simulations')).data.simulations, []);
  eq('other user: cannot read (404)', (await call(O, 'GET', `/simulations/${sim.id}`)).status, 404);
  eq('other user: cannot delete (404)', (await call(O, 'DELETE', `/simulations/${sim.id}`)).status, 404);
  eq('still there after the attempt', (await call(A, 'GET', '/simulations')).data.simulations.length, 1);
  eq('owner can delete', (await call(A, 'DELETE', `/simulations/${sim.id}`)).status, 200);
  eq('deleted => 404', (await call(A, 'GET', `/simulations/${sim.id}`)).status, 404);

  // ---- cap ----
  let last;
  for (let i = 0; i < 50; i++) last = await call(A, 'POST', '/simulations', { name: `s${i}`, inputs: {} });
  eq('50 saved ok', last.status, 201);
  eq('51st => 409', (await call(A, 'POST', '/simulations', { name: 'one too many', inputs: {} })).status, 409);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
