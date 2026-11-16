const { call, register, tx, eq, done } = require('./lib');

(async () => {
  const A = await register('ga'); const B = await register('gb');
  const day = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);

  // ---- create ----
  let r = await call(A, 'POST', '/goals', { title: 'Laptop', targetAmount: 80000 });
  eq('create minimal goal', r.status, 201);
  const g1 = r.data.goal;
  eq('new goal: not_started, 0 saved, 0%', [g1.status, g1.savedAmount, g1.progress, g1.remaining], ['not_started', 0, 0, 80000]);
  eq('no targetDate/category by default', [g1.targetDate, g1.category, g1.description], [null, null, null]);
  eq('no daysRemaining without date', g1.daysRemaining, null);

  r = await call(A, 'POST', '/goals', { title: 'Emergency', targetAmount: 50000, savedAmount: 10000, targetDate: day(60), category: 'Safety', description: 'Six months' });
  const g2 = r.data.goal;
  eq('create full goal', r.status, 201);
  eq('initial amount => in_progress 20%', [g2.status, g2.savedAmount, g2.progress, g2.remaining], ['in_progress', 10000, 20, 40000]);
  eq('metadata saved', [g2.category, g2.description, g2.targetDate, g2.daysRemaining], ['Safety', 'Six months', day(60), 60]);
  r = await call(A, 'GET', `/goals/${g2.id}/contributions`);
  eq('initial amount recorded as 1 contribution', r.data.contributions.map((c) => [c.amount, c.note]), [[10000, 'Initial saved amount']]);

  // ---- create validation ----
  eq('zero target => 400', (await call(A, 'POST', '/goals', { title: 'x', targetAmount: 0 })).status, 400);
  eq('negative target => 400', (await call(A, 'POST', '/goals', { title: 'x', targetAmount: -5 })).status, 400);
  eq('empty title => 400', (await call(A, 'POST', '/goals', { title: ' ', targetAmount: 5 })).status, 400);
  eq('negative initial => 400', (await call(A, 'POST', '/goals', { title: 'x', targetAmount: 5, savedAmount: -1 })).status, 400);
  eq('initial > target => 400', (await call(A, 'POST', '/goals', { title: 'x', targetAmount: 5, savedAmount: 6 })).status, 400);
  eq('past target date => 400', (await call(A, 'POST', '/goals', { title: 'x', targetAmount: 5, targetDate: day(-1) })).status, 400);
  eq('bad date format => 400', (await call(A, 'POST', '/goals', { title: 'x', targetAmount: 5, targetDate: '31/12/2030' })).status, 400);
  eq('initial == target is allowed (completed)', (await call(A, 'POST', '/goals', { title: 'Done', targetAmount: 100, savedAmount: 100 })).data.goal.status, 'completed');
  eq('today as target date allowed', (await call(A, 'POST', '/goals', { title: 'T', targetAmount: 100, targetDate: day(0) })).status, 201);

  // ---- contributions ----
  r = await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 20000, note: 'Bonus' });
  eq('contribute 201', r.status, 201);
  eq('saved 20000, 25%, in_progress', [r.data.goal.savedAmount, r.data.goal.progress, r.data.goal.status], [20000, 25, 'in_progress']);
  eq('contribution has date today + note', [r.data.contribution.date, r.data.contribution.note], [day(0), 'Bonus']);
  r = await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 0.1, date: day(-3) });
  r = await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 0.2 });
  eq('decimal amounts add exactly (no float drift)', r.data.goal.savedAmount, 20000.3);
  eq('zero contribution => 400', (await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 0 })).status, 400);
  eq('negative contribution => 400', (await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: -5 })).status, 400);
  eq('non-number => 400', (await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 'abc' })).status, 400);
  eq('future date => 400', (await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 5, date: day(2) })).status, 400);
  eq('legacy /deposit alias works', (await call(A, 'POST', `/goals/${g1.id}/deposit`, { amount: 1 })).status, 201);
  r = await call(A, 'GET', `/goals/${g1.id}/contributions`);
  eq('history count (4 valid)', r.data.contributions.length, 4);
  eq('history newest-first by date', r.data.contributions[r.data.contributions.length - 1].date, day(-3));
  eq('sum(history) == savedAmount', Math.round(r.data.contributions.reduce((s, c) => s + c.amount, 0) * 100) / 100, r.data.goal.savedAmount);
  eq('contributionCount on goal', (await call(A, 'GET', `/goals/${g1.id}`)).data.goal.contributionCount, 4);

  // ---- no double counting ----
  await tx(A, 'INCOME', 1000, 'Salary', day(0));
  r = await call(A, 'GET', '/analytics/overview?period=this_month');
  eq('contributions do NOT appear as expenses/income', [r.data.summary.income, r.data.summary.expense], [1000, 0]);
  eq('transactions list has no contribution rows', (await call(A, 'GET', '/transactions')).data.transactions.length, 1);

  // ---- completion / excess ----
  r = await call(A, 'POST', `/goals/${g1.id}/contributions`, { amount: 70000 });
  const done1 = r.data.goal;
  eq('over-saved: completed', done1.status, 'completed');
  eq('bar capped at 100 but actual shown', [done1.progress, done1.actualProgress > 100], [100, true]);
  eq('excess separate, remaining 0', [done1.excess, done1.remaining], [Math.round((done1.savedAmount - 80000) * 100) / 100, 0]);

  // ---- overdue: cannot create past, so create with today then edit isn't possible; use DB-level via PUT of past date ----
  r = await call(A, 'PUT', `/goals/${g2.id}`, { targetDate: day(-5) });
  eq('edit to past date allowed (existing goal)', r.status, 200);
  eq('overdue + partly saved => overdue (not completed)', [r.data.goal.status, r.data.goal.daysRemaining], ['overdue', -5]);
  r = await call(A, 'POST', `/goals/${g2.id}/contributions`, { amount: 1 });
  eq('still overdue after contribution', r.data.goal.status, 'overdue');
  r = await call(A, 'POST', `/goals/${g2.id}/contributions`, { amount: 40000 });
  eq('overdue goal that reaches target => completed', r.data.goal.status, 'completed');
  r = await call(A, 'PUT', `/goals/${g2.id}`, { targetDate: null });
  eq('clear target date', r.data.goal.targetDate, null);

  // ---- update ----
  r = await call(A, 'PUT', `/goals/${g1.id}`, { title: 'Laptop Pro', targetAmount: 200000, description: 'new', category: 'Tech' });
  eq('update fields', [r.data.goal.title, r.data.goal.targetAmount, r.data.goal.category], ['Laptop Pro', 200000, 'Tech']);
  eq('raising target un-completes goal', r.data.goal.status, 'in_progress');
  eq('saved untouched by edit', r.data.goal.savedAmount, done1.savedAmount);
  eq('PUT savedAmount rejected', (await call(A, 'PUT', `/goals/${g1.id}`, { savedAmount: 1 })).status, 400);
  eq('PUT empty => 400', (await call(A, 'PUT', `/goals/${g1.id}`, {})).status, 400);
  eq('PUT target 0 => 400', (await call(A, 'PUT', `/goals/${g1.id}`, { targetAmount: 0 })).status, 400);

  // ---- summary ----
  r = await call(A, 'GET', '/goals/summary');
  const s = r.data;
  eq('summary counts', [s.totalCount, s.completedCount, s.activeCount], [4, 2, 2]);
  eq('summary upcoming only active w/ date', s.upcoming.map((g) => g.title), ['T']);
  eq('summary has no full goal list', s.goals, undefined);
  const list = (await call(A, 'GET', '/goals')).data.goals;
  eq('summary totalSaved == sum of goals', Math.round(s.totalSaved * 100) / 100, Math.round(list.reduce((a, g) => a + g.savedAmount, 0) * 100) / 100);

  // ---- isolation: B cannot touch A's goals ----
  eq('B list empty', (await call(B, 'GET', '/goals')).data.goals.length, 0);
  eq('B summary empty', (await call(B, 'GET', '/goals/summary')).data.totalCount, 0);
  eq('B get A goal => 404', (await call(B, 'GET', `/goals/${g1.id}`)).status, 404);
  eq('B put A goal => 404', (await call(B, 'PUT', `/goals/${g1.id}`, { title: 'hax' })).status, 404);
  eq('B delete A goal => 404', (await call(B, 'DELETE', `/goals/${g1.id}`)).status, 404);
  eq('B contribute to A goal => 404', (await call(B, 'POST', `/goals/${g1.id}/contributions`, { amount: 5 })).status, 404);
  eq('B read A history => 404', (await call(B, 'GET', `/goals/${g1.id}/contributions`)).status, 404);
  eq('A goal unchanged', (await call(A, 'GET', `/goals/${g1.id}`)).data.goal.title, 'Laptop Pro');
  eq('no token => 401', (await call(null, 'GET', '/goals')).status, 401);

  // ---- delete ----
  eq('delete ok', (await call(A, 'DELETE', `/goals/${g1.id}`)).status, 200);
  eq('deleted goal 404', (await call(A, 'GET', `/goals/${g1.id}`)).status, 404);
  eq('history gone with goal', (await call(A, 'GET', `/goals/${g1.id}/contributions`)).status, 404);
  eq('summary updates after delete', (await call(A, 'GET', '/goals/summary')).data.totalCount, 3);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
