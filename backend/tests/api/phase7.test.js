const { call, register, tx, eq, done } = require('./lib');

(async () => {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth(); const today = now.getUTCDate();
  if (today < 5 || today > 26) { console.log('Run between the 5th and the 26th'); process.exit(2); }
  const d = (mm, dd) => new Date(Date.UTC(y, mm, dd)).toISOString().slice(0, 10);
  const off = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const A = await register('ia'); const B = await register('ib'); const C = await register('ic'); const Z = await register('iz'); const N = await register('in');

  // ---- insufficient data ----
  let r = await call(Z, 'GET', '/insights');
  eq('empty user: not sufficient', r.data.sufficient, false);
  eq('empty user: required message', r.data.message, 'Not enough financial data to generate insights yet.');
  eq('empty user: no insights', r.data.insights, []);
  for (let i = 0; i < 4; i += 1) await tx(N, 'EXPENSE', 100, 'Food', d(m, 2));
  r = await call(N, 'GET', '/insights');
  eq('4 transactions: still insufficient', [r.data.sufficient, r.data.insights.length], [false, 0]);
  eq('requirement explains the minimum', /at least 5 transactions/.test(r.data.requirement), true);
  await tx(N, 'EXPENSE', 100, 'Food', d(m, 2));
  eq('5 transactions: sufficient', (await call(N, 'GET', '/insights')).data.sufficient, true);

  // ---- user A: hand-computed scenario ----
  // this period (1st..today): income 50000; Food 3000, Shopping 1500, Transport 500 => expense 5000
  await tx(A, 'INCOME', 50000, 'Salary', d(m, 1)); await tx(A, 'EXPENSE', 3000, 'Food', d(m, 2));
  await tx(A, 'EXPENSE', 1500, 'Shopping', d(m, 3)); await tx(A, 'EXPENSE', 500, 'Transport', d(m, 4));
  // previous like-for-like window (1st..same #days of last month): income 40000; Food 1000, Shopping 2700, Transport 500 => 4200
  await tx(A, 'INCOME', 40000, 'Salary', d(m - 1, 1)); await tx(A, 'EXPENSE', 1000, 'Food', d(m - 1, 2));
  await tx(A, 'EXPENSE', 2700, 'Shopping', d(m - 1, 3)); await tx(A, 'EXPENSE', 500, 'Transport', d(m - 1, 4));
  await tx(A, 'EXPENSE', 1000, 'Food', d(m - 1, 27)); // later in October: outside the window, inside October total (5200)
  // Sep (2700) and Aug (2500) full months -> rising trend 2500 < 2700 < 5200
  await tx(A, 'INCOME', 40000, 'Salary', d(m - 2, 1)); await tx(A, 'EXPENSE', 1200, 'Food', d(m - 2, 5));
  await tx(A, 'EXPENSE', 1000, 'Shopping', d(m - 2, 6)); await tx(A, 'EXPENSE', 500, 'Transport', d(m - 2, 7));
  await tx(A, 'EXPENSE', 1000, 'Food', d(m - 3, 5)); await tx(A, 'EXPENSE', 1000, 'Shopping', d(m - 3, 6)); await tx(A, 'EXPENSE', 500, 'Transport', d(m - 3, 7));
  // repeated small spending (3x similar amounts) outside the compared windows
  await tx(A, 'EXPENSE', 120, 'Snacks', d(m - 1, 27), 'Coffee'); await tx(A, 'EXPENSE', 120, 'Snacks', d(m - 2, 20), 'Coffee'); await tx(A, 'EXPENSE', 125, 'Snacks', d(m - 3, 25), 'Coffee');
  // budgets for the current month
  const monthStart = d(m, 1); const monthEnd = d(m + 1, 0);
  await call(A, 'POST', '/budgets', { category: 'Food', limit: 3500, startDate: monthStart, endDate: monthEnd });      // 3000/3500 = 86% warning
  await call(A, 'POST', '/budgets', { category: 'Shopping', limit: 1500, startDate: monthStart, endDate: monthEnd });  // 100% critical (not over)
  await call(A, 'POST', '/budgets', { category: 'Transport', limit: 400, startDate: monthStart, endDate: monthEnd });  // 500/400 over by 100
  // goals
  const g1 = (await call(A, 'POST', '/goals', { title: 'Laptop', targetAmount: 10000, savedAmount: 6000, targetDate: off(60) })).data.goal;
  await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 1000, date: off(-45) });
  await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 1000, date: off(-20) });
  await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 500, date: off(-2) });
  const g2 = (await call(A, 'POST', '/goals', { title: 'Course', targetAmount: 10000, targetDate: off(20) })).data.goal;
  for (const o of [-50, -30, -1]) await call(A, 'POST', `/goals/${g2.id}/contributions`, { amount: 100, date: off(o) });
  const g3 = (await call(A, 'POST', '/goals', { title: 'Phone', targetAmount: 5000 })).data.goal;
  for (const o of [-40, -1]) await call(A, 'POST', `/goals/${g3.id}/contributions`, { amount: 100, date: off(o) });

  r = await call(A, 'GET', '/insights');
  const ins = r.data.insights; const by = (id) => ins.find((i) => i.id === id);
  const find = (re) => ins.find((i) => re.test(i.id));
  eq('sufficient', r.data.sufficient, true);
  eq('top category', by('spending.top-category').message, 'Food is your highest spending category this month (৳3,000, 60% of your expenses).');
  eq('lowest category', by('spending.lowest-category').message, 'Transport is your lowest spending category this month (৳500).');
  eq('overall: 19% more (5000 vs 4200)', by('spending.total-change').message, 'You spent 19% more this month than in the previous period (৳5,000 vs ৳4,200).');
  eq('overall type warning when higher', by('spending.total-change').type, 'warning');
  eq('Food change +2000 (200%)', by('spending.category-change.Food').message, 'Your Food expenses increased by ৳2,000 (200%) compared with the previous period.');
  eq('Shopping change -1200 (44.4%)', by('spending.category-change.Shopping').message, 'Your Shopping expenses decreased by ৳1,200 (44.4%) compared with the previous period.');
  eq('decrease is positive tone', by('spending.category-change.Shopping').type, 'positive');
  eq('unchanged Transport not mentioned', by('spending.category-change.Transport'), undefined);
  // budgets
  const bi = ins.filter((i) => i.category === 'budget');
  eq('Food budget 86% warning', bi.find((i) => /Food/.test(i.message)).message, 'You have used 86% of your Food budget (৳500 left).');
  eq('Shopping at 100% is "almost exhausted" not exceeded', bi.find((i) => /Shopping/.test(i.message)).message, 'Your Shopping budget is almost exhausted (100% used, ৳0 left).');
  eq('Transport exceeded by 500-400=100', bi.find((i) => /Transport/.test(i.message)).message, 'You exceeded your Transport budget by ৳100.');
  eq('no "within budget" when some are strained', by('budget.all-healthy'), undefined);
  eq('one budget insight per budget', bi.length, 3);
  // savings
  eq('savings amount change: 45000 vs 35800 = +9200', by('savings.amount-change').message, 'You saved ৳9,200 more than in the previous period (৳45,000 vs ৳35,800).');
  eq('savings rate change <1 point is not reported', by('savings.rate-change'), undefined);
  eq('no negative savings message', by('savings.negative'), undefined);
  eq('goal progress 85% (6000+2500 of 10000)', by(`savings.goal-progress.${g1.id}`).message, 'Your savings goal "Laptop" is 85% complete (৳8,500 of ৳10,000).');
  // pace: initial 6000 excluded; contributions 2500 over 45 days = 55.56/day; remaining 1500 => 27 days => before target (60d)
  const pace1 = by(`savings.goal-pace.${g1.id}`);
  eq('pace (initial balance excluded) ahead of target date', /may reach "Laptop" around .*before your target date/.test(pace1.message), true);
  eq('pace reason states it is an estimate', /estimate/.test(pace1.reason) && /3 contributions totalling ৳2,500 over the last 45 days/.test(pace1.reason), true);
  const pace2 = by(`savings.goal-pace.${g2.id}`);
  eq('slow pace => may need more time (warning)', [pace2.type, /may need more time to reach "Course"/.test(pace2.message)], ['warning', true]);
  eq('only 2 contributions => no pace estimate', by(`savings.goal-pace.${g3.id}`), undefined);
  // habits
  eq('rising spending 3 months', by('habits.spending-rising').message.startsWith('Your monthly spending rose for 3 months in a row: ৳2,625'), true);
  const unusual = by('habits.unusual-increase.Food');
  eq('unusual Food: 3000 vs avg(1000+1200 /... ) flagged neutrally', unusual && /already \d+% above your recent monthly average/.test(unusual.message), true);
  eq('unusual wording is not accusatory', /suspicious|fraud|anomal/i.test(JSON.stringify(ins)), false);
  eq('repeated spending', by('habits.repeat.Snacks.Coffee').message, 'You spent on "Coffee" (Snacks) 3 times in the last 90 days, about ৳121.67 each (৳365 in total).');
  // recommendations
  eq('recommendation: review Food', by('rec.review-category.Food').message, 'Consider reviewing your Food expenses this month.');
  eq('recommendation: adjust a strained budget', !!find(/^rec\.adjust-budget\./), true);
  eq('no "set budget" rec (budgets exist)', by('rec.set-budget'), undefined);
  eq('no "create goal" rec (goals exist)', by('rec.create-goal'), undefined);
  eq('recommendations are suggestions, no guarantees', ins.filter((i) => i.category === 'recommendations').every((i) => i.type === 'suggestion' && !/will |guarantee|definitely/i.test(i.message)), true);
  // quality
  eq('every insight has a reason', ins.every((i) => i.reason && i.reason.length > 10), true);
  eq('no duplicate ids', new Set(ins.map((i) => i.id)).size, ins.length);
  eq('no duplicate messages', new Set(ins.map((i) => i.message)).size, ins.length);
  eq('groups cover all 5 categories', Object.keys(r.data.groups), ['spending', 'budget', 'savings', 'habits', 'recommendations']);
  eq('groups hold the same insights', Object.values(r.data.groups).reduce((s, g) => s + g.length, 0), ins.length);
  eq('period metadata present', [!!r.data.period.start, !!r.data.previousPeriod.start], [true, true]);

  // ---- caching + invalidation ----
  const first = r.data.generatedAt;
  eq('repeat GET served from cache (same generatedAt)', (await call(A, 'GET', '/insights')).data.generatedAt, first);
  await new Promise((res) => setTimeout(res, 20));
  await tx(A, 'EXPENSE', 500, 'Food', d(m, 4)); // Food now 3500 = 100% of budget
  r = await call(A, 'GET', '/insights');
  eq('after a transaction write: recalculated', r.data.generatedAt !== first, true);
  eq('insights reflect the new data (Food budget critical/at limit)', /Food budget is almost exhausted \(100% used/.test(r.data.insights.find((i) => i.id.startsWith('budget.') && /Food/.test(i.message)).message), true);
  const second = r.data.generatedAt;
  await call(A, 'POST', `/goals/${g3.id}/contributions`, { amount: 50 });
  eq('after a goal write: recalculated', (await call(A, 'GET', '/insights')).data.generatedAt !== second, true);
  const third = (await call(A, 'GET', '/insights')).data.generatedAt;
  await call(A, 'POST', '/budgets', { category: 'Health', limit: 100, startDate: monthStart, endDate: monthEnd });
  eq('after a budget write: recalculated', (await call(A, 'GET', '/insights')).data.generatedAt !== third, true);

  // ---- zero income / no previous data (user C) ----
  for (const [amt, cat, dd] of [[100, 'Food', 1], [200, 'Food', 2], [300, 'Transport', 3], [50, 'Food', 4], [50, 'Shopping', 4]]) await tx(C, 'EXPENSE', amt, cat, d(m, dd));
  r = await call(C, 'GET', '/insights');
  eq('zero income: sufficient & no savings-rate/negative insights', [r.data.sufficient, r.data.insights.some((i) => /^savings\.(rate-change|negative|amount-change)/.test(i.id))], [true, false]);
  eq('no previous data: no comparison insights', r.data.insights.some((i) => /^spending\.(total|category)-change/.test(i.id)), false);
  eq('no income: no savings target rec (rate unknown)', r.data.insights.some((i) => i.id === 'rec.savings-target'), false);
  eq('no budgets => suggests a budget for the largest category', r.data.insights.find((i) => i.id === 'rec.set-budget').message.includes('Food'), true);

  // ---- isolation ----
  for (let i = 0; i < 5; i += 1) await tx(B, 'EXPENSE', 77, 'Rent', d(m, 2));
  r = await call(B, 'GET', '/insights');
  eq('user B insights never mention A data', JSON.stringify(r.data).includes('Laptop') || JSON.stringify(r.data).includes('Shopping'), false);
  eq('no token => 401', (await call(null, 'GET', '/insights')).status, 401);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
