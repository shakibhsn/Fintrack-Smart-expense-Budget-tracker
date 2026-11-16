require('./dbenv'); // keep direct Prisma access on the TEST database
const path = require('path');
process.chdir(require('path').join(__dirname, '..', '..'));
const { call, register, tx, eq, done } = require(path.join(__dirname, 'lib'));
const { budgetFraction } = require('../../src/services/healthScoreService');

(async () => {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const d = (mm, dd) => new Date(Date.UTC(y, mm, dd)).toISOString().slice(0, 10);
  const off = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const comp = (r, k) => r.data.components.find((c) => c.key === k);

  // ---- pure formula checks ----
  eq('budget fraction <=70% => 1', budgetFraction(50), 1); eq('70% => 1', budgetFraction(70), 1);
  eq('100% => 0.6', Math.round(budgetFraction(100) * 100) / 100, 0.6);
  eq('85% => 0.8', Math.round(budgetFraction(85) * 100) / 100, 0.8);
  eq('125% => 0.3', Math.round(budgetFraction(125) * 100) / 100, 0.3);
  eq('>=150% => 0', [budgetFraction(150), budgetFraction(400)], [0, 0]);

  // ---- unavailable: brand new / too little data ----
  const Z = await register('hz'); const F = await register('hf'); const S = await register('hs');
  let r = await call(Z, 'GET', '/health-score');
  eq('new user: not available', [r.data.available, r.data.score, r.data.level], [false, null, null]);
  eq('new user: exact message', r.data.message, 'Your financial health score is not available yet.');
  eq('new user: explains requirement', /least 10 transactions/.test(r.data.requirement), true);
  eq('new user: lists what is needed', r.data.needs.length, 5);
  eq('new user: components not scored as 0', r.data.components.every((c) => c.eligible === false && c.earned === null), true);
  eq('new user: no history, no strengths', [r.data.history, r.data.strengths], [[], []]);
  for (let i = 0; i < 12; i += 1) await tx(F, 'EXPENSE', 50, 'Food', off(0));
  r = await call(F, 'GET', '/health-score');
  eq('12 tx all today, no income: still unavailable (<35 evaluable pts)', [r.data.available, /35 of the 100 points/.test(r.data.requirement)], [false, true]);

  // ---- partial score, normalised over evaluable components (income + tracking only) ----
  for (const o of [0, -6, -12, -18, -24, -30, -36]) { await tx(S, 'INCOME', 1000, 'Salary', off(o)); await tx(S, 'EXPENSE', 100, 'Food', off(o)); }
  r = await call(S, 'GET', '/health-score');
  eq('partial: available', r.data.available, true);
  eq('partial: only savings + tracking evaluated', r.data.components.filter((c) => c.eligible).map((c) => c.key).sort(), ['savingsRate', 'tracking']);
  eq('partial: basedOn 2 of 5, 35 pts', [r.data.basedOn.componentsEvaluated, r.data.basedOn.evaluablePoints, r.data.partial], [2, 35, true]);
  eq('partial: unavailable components are NOT zero-scored', r.data.components.filter((c) => !c.eligible).every((c) => c.earned === null), true);
  eq('partial: 90% savings rate => full 25, tracking full 10 => score 100 Excellent', [comp(r, 'savingsRate').earned, comp(r, 'tracking').earned, r.data.score, r.data.level], [25, 10, 100, 'Excellent']);
  eq('partial: unlock suggestions for missing parts', r.data.suggestions.some((s) => s.key === 'budget'), true);

  // ---- negative savings (spend > income) ----
  const Ng = await register('hn');
  for (const o of [0, -6, -12, -18, -24, -30, -36]) { await tx(Ng, 'INCOME', 1000, 'Salary', off(o)); await tx(Ng, 'EXPENSE', 2000, 'Food', off(o)); }
  r = await call(Ng, 'GET', '/health-score');
  eq('negative savings: earns 0 (not negative), explained', [comp(r, 'savingsRate').earned, /more than you earned/.test(comp(r, 'savingsRate').explanation)], [0, true]);
  eq('negative savings: score = 10/35 = 29, Needs Improvement', [r.data.score, r.data.level], [29, 'Needs Improvement']);
  eq('Needs-improvement list flags savings rate', r.data.improvements.map((i) => i.key), ['savingsRate']);
  eq('tracking is a strength', r.data.strengths.map((i) => i.key), ['tracking']);

  // ---- full scenario ----
  const A = await register('ha'); const B = await register('hb');
  for (let k = 5; k >= 0; k -= 1) await tx(A, 'INCOME', 40000, 'Salary', d(m - k, 1));
  for (let k = 4; k >= 1; k -= 1) await tx(A, 'EXPENSE', 20000, 'Rent', d(m - k, 10)); // steady big monthly expense
  for (let o = 0; o <= 78; o += 6) await tx(A, 'EXPENSE', 100, 'Food', off(-o));      // something every <=6 days
  await tx(A, 'EXPENSE', 150, 'Transport', off(0));
  const mStart = d(m, 1); const mEnd = d(m + 1, 0);
  await call(A, 'POST', '/budgets', { category: 'Food', limit: 100000, startDate: mStart, endDate: mEnd });     // ~0% used -> 1.0
  await call(A, 'POST', '/budgets', { category: 'Transport', limit: 100, startDate: mStart, endDate: mEnd });   // 150% used -> 0
  await call(A, 'POST', '/goals', { title: 'On pace', targetAmount: 1000, targetDate: off(100) });           // just created -> grace -> 1
  await call(A, 'POST', '/goals', { title: 'Done', targetAmount: 100, savedAmount: 100 });                      // completed -> 1
  const late = (await call(A, 'POST', '/goals', { title: 'Late', targetAmount: 1000, savedAmount: 250, targetDate: off(30) })).data.goal.id;
  await call(A, 'POST', '/goals', { title: 'No date', targetAmount: 500, savedAmount: 10 });                    // skipped: no date, not complete
  // backdate "Late" so it is overdue: created 100 days ago, target 10 days ago, 25% saved -> fraction 0.25
  const prisma = require('../../src/config/prisma');
  await prisma.savingsGoal.update({ where: { id: late }, data: { createdAt: new Date(Date.now() - 100 * 86400000), targetDate: new Date(Date.now() - 10 * 86400000) } });
  await call(A, 'PUT', `/goals/${late}`, { title: 'Late' }); // goes through the API so any cache is invalidated

  r = await call(A, 'GET', '/health-score');
  const D = r.data;
  eq('full: available, all 5 evaluated', [D.available, D.basedOn.componentsEvaluated, D.basedOn.evaluablePoints, D.partial], [true, 5, 100, false]);
  eq('budget: avg(1.0, 0) * 30 = 15', comp(r, 'budget').earned, 15);
  eq('budget explanation matches (1 within, 1 over)', /1 of 2 budgets are within the limit and 1 is over/.test(comp(r, 'budget').explanation), true);
  eq('tracking: 12/12 weeks => 10', [comp(r, 'tracking').earned, comp(r, 'tracking').details.weeksWithActivity, comp(r, 'tracking').details.weeksEvaluated], [10, 12, 12]);
  eq('goals: (1 + 1 + 0.25)/3 * 15 = 11.3 (round1 of 11.25)', [comp(r, 'goals').details.goals, comp(r, 'goals').earned], [3, 11.3]);
  eq('goals: "No date" goal skipped, overdue counted', [comp(r, 'goals').details.pastTargetDate, comp(r, 'goals').details.completed], [1, 1]);
  eq('stability: steady months => ~full 20', comp(r, 'stability').earned >= 19.5, true);
  eq('stability basis is expenses/income (all months have income)', comp(r, 'stability').details.basis, 'expenses/income');
  // savings rate cross-checked against the Analytics endpoint (independent code path)
  const from = d(m - 2, 1); const to = off(0);
  const an = (await call(A, 'GET', `/analytics/overview?period=custom&startDate=${from}&endDate=${to}`)).data.summary;
  const rate = ((an.income - an.expense) / an.income) * 100;
  const expectedSr = Math.round(Math.min(Math.max(rate / 20, 0), 1) * 25 * 10) / 10;
  eq('savings rate component == independent calc from analytics', [comp(r, 'savingsRate').earned, comp(r, 'savingsRate').details.savingsRatePercent], [expectedSr, Math.round(rate * 10) / 10]);
  const sum = D.components.reduce((s, c) => s + c.earned, 0);
  eq('all 5 evaluable: score == round(sum of earned points)', D.score, Math.round(sum));
  eq('level matches score band', D.level, D.score >= 80 ? 'Excellent' : D.score >= 60 ? 'Good' : D.score >= 40 ? 'Fair' : 'Needs Improvement');
  eq('every component explains itself + suggests', D.components.every((c) => c.explanation && c.suggestion && c.maxPoints > 0), true);
  eq('weights sum to 100', D.components.reduce((s, c) => s + c.maxPoints, 0), 100);
  eq('disclaimer present (educational, not advice)', /not professional financial advice/.test(D.disclaimer), true);

  // ---- history: only real, as-of scores ----
  const h = D.history;
  eq('history has several real points', h.length >= 2, true);
  eq('history ends with today == current score', [h[h.length - 1].label, h[h.length - 1].score], ['Today', D.score]);
  eq('history asOf dates ascending & not in the future', h.every((p, i) => (i === 0 || p.asOf > h[i - 1].asOf) && p.asOf <= off(0)), true);
  eq('history scores are 0-100 integers', h.every((p) => Number.isInteger(p.score) && p.score >= 0 && p.score <= 100), true);
  eq('past points never include the budgets created today (so <=4 of 5 components)', h.slice(0, -1).every((p) => p.componentsEvaluated <= 4), true);
  const earliestTx = d(m - 5, 1);
  eq('no history point before data could support it', h.every((p) => p.asOf >= earliestTx), true);
  // July-equivalent (m-4): too few transactions in the 90 days before it -> must not appear
  const julEnd = d(m - 3, 0);
  eq('month with <10 transactions in prior 90 days is omitted, not guessed', h.some((p) => p.asOf === julEnd), false);

  // ---- caching + recalculation on change ----
  const t0 = D.generatedAt;
  eq('repeat GET cached', (await call(A, 'GET', '/health-score')).data.generatedAt, t0);
  await new Promise((res) => setTimeout(res, 20));
  await tx(A, 'EXPENSE', 99999, 'Misc', off(0));
  r = await call(A, 'GET', '/health-score');
  eq('transaction write recalculates', r.data.generatedAt !== t0, true);
  eq('...and the score reflects it (savings rate dropped)', comp(r, 'savingsRate').earned < expectedSr, true);
  const t1 = r.data.generatedAt;
  const g = (await call(A, 'GET', '/goals')).data.goals.find((x) => x.title === 'On pace');
  await new Promise((res) => setTimeout(res, 20));
  await call(A, 'POST', `/goals/${g.id}/contributions`, { amount: 5 });
  eq('goal write recalculates', (await call(A, 'GET', '/health-score')).data.generatedAt !== t1, true);

  // ---- isolation / auth ----
  for (let i = 0; i < 12; i += 1) await tx(B, 'EXPENSE', 10, 'Food', off(-i));
  r = await call(B, 'GET', '/health-score');
  eq('B sees none of A: no budgets/goals evaluated', [comp(r, 'budget').eligible, comp(r, 'goals').eligible], [false, false]);
  eq('no token => 401', (await call(null, 'GET', '/health-score')).status, 401);
  await prisma.$disconnect();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
