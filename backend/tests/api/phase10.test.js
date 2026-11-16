const { call, register, tx, eq, done } = require('./lib');
const A = require('../../src/services/anomalyService');

(async () => {
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth(); const dd = now.getUTCDate();
  const off = (n) => new Date(Date.UTC(y, m, dd - n)).toISOString().slice(0, 10);
  const dm = (back, day = 10) => new Date(Date.UTC(y, m - back, day)).toISOString().slice(0, 10);
  const U = (T, s = 'active') => call(T, 'GET', `/unusual-spending?status=${s}`);
  const MSG = 'Not enough transaction history to identify unusual spending patterns.';

  // ================= pure rule tests =================
  const D = A.DEFAULTS;
  const mk = (id, amount, category, daysAgo) => ({ id, amount, category, date: new Date(Date.UTC(y, m, dd - daysAgo)), description: id });
  const hist = (cat, amts, startAgo = 40) => amts.map((a, i) => mk(`${cat}${i}`, a, cat, startAgo + i * 5));
  const filler = hist('Filler', Array(12).fill(10), 60); // pads the minimum-data requirement
  const run = (extra, th = D) => A.detect({ expenses: [...filler, ...extra], firstExpenseDate: new Date(Date.UTC(y, m, dd - 150)) }, th, now);
  const typical = [80, 90, 100, 110, 120, 100, 95, 105];
  let r = run([...hist('Shop', typical), mk('big', 250, 'Shop', 2)]);
  eq('IQR+median rule flags 250 (typical ~100)', r.detections.filter((d) => d.type === 'LARGE_TRANSACTION').map((d) => d.transactionId), ['big']);
  r = run([...hist('Shop', typical), mk('mid', 150, 'Shop', 2)]);
  eq('150 is above the IQR fence but < 2x median => NOT flagged (no blind threshold)', r.detections.filter((d) => d.type === 'LARGE_TRANSACTION').length, 0);
  r = run([...hist('Shop', typical), mk('mid', 150, 'Shop', 2)], { ...D, large: { ...D.large, minMedianRatio: 1.3 } });
  eq('thresholds are configurable (ratio 1.3 flags 150)', r.detections.filter((d) => d.type === 'LARGE_TRANSACTION').length, 1);
  r = run([...hist('Rent', [5000, 5200, 4900, 5100, 5000, 5300, 4800, 5050]), mk('rent', 5400, 'Rent', 2)]);
  eq('5400 is NORMAL for a user whose typical Rent is ~5000', r.detections.filter((d) => d.type === 'LARGE_TRANSACTION').length, 0);
  r = run([...hist('Few', [100, 100, 100, 100, 100]), mk('x', 900, 'Few', 2)]);
  eq('category with < 8 other transactions => no per-category baseline, no alert', r.detections.filter((d) => d.type === 'LARGE_TRANSACTION').length, 0);
  r = run([...hist('Shop', typical), mk('future', 9000, 'Shop', -3)]);
  eq('future-dated expense ignored', r.detections.filter((d) => d.transactionId === 'future').length, 0);
  eq('quantile (linear interpolation)', [A.quantile([1, 2, 3, 4], 0.25), A.quantile([1, 2, 3, 4], 0.5), A.quantile([1, 2, 3, 4], 0.75)], [1.75, 2.5, 3.25]);

  // ================= minimum data =================
  const Z = await register('a10z');
  let res = await U(Z);
  eq('new user: sufficient=false + exact message', [res.status, res.data.sufficient, res.data.message, res.data.detections], [200, false, MSG, []]);
  const S = await register('a10short');
  for (let i = 0; i < 20; i++) await tx(S, 'EXPENSE', 100 * (i % 3 + 1), 'Food', off(i % 10));
  res = await U(S);
  eq('20 transactions but only ~10 days of history => insufficient', [res.data.sufficient, res.data.message], [false, MSG]);
  eq('no token => 401', (await call(null, 'GET', '/unusual-spending')).status, 401);
  eq('bad status filter => 400', (await U(Z, 'weird')).status, 400);

  // ================= main scenario =================
  const T = await register('a10main');
  for (const o of [32, 38, 44, 50, 62, 68, 74, 80, 92, 98, 104, 110, 130, 150]) await tx(T, 'EXPENSE', 100, 'Food', off(o));
  const big = (await tx(T, 'EXPENSE', 1500, 'Food', off(3), 'Wedding gift')).data.transaction;
  const small = (await tx(T, 'EXPENSE', 120, 'Food', off(4))).data.transaction;
  for (const o of [35, 65, 95]) await tx(T, 'EXPENSE', 1000, 'Shopping', off(o));
  await tx(T, 'EXPENSE', 2000, 'Shopping', off(5));
  for (const [o, a] of [[100, 100], [70, 150], [40, 250], [10, 400]]) await tx(T, 'EXPENSE', a, 'Transport', off(o));
  await tx(T, 'INCOME', 90000, 'Salary', off(2));

  res = await U(T);
  const list = res.data.detections;
  eq('sufficient data', res.data.sufficient, true);
  const large = list.find((d) => d.type === 'LARGE_TRANSACTION');
  eq('LARGE: the 1500 Food transaction, baseline = median 100', [large.transactionId, large.actualAmount, large.baselineAmount, large.difference, large.category], [big.id, 1500, 100, 1400, 'Food']);
  eq('LARGE: explanation from real numbers', large.explanation.includes('৳1,500') && large.explanation.includes('৳1,400 higher than your typical Food transaction'), true);
  eq('the 120 Food tx (normal) is not flagged', list.some((d) => d.transactionId === small.id), false);
  const cat = list.find((d) => d.type === 'CATEGORY_INCREASE');
  eq('CATEGORY: Shopping 2000 vs avg 1000 = +100%', [cat.category, cat.actualAmount, cat.baselineAmount, cat.difference, cat.percentChange], ['Shopping', 2000, 1000, 1000, 100]);
  eq('CATEGORY: explanation', cat.explanation.includes('100% (৳1,000) higher than your recent 30-day average of ৳1,000'), true);
  const rep = list.find((d) => d.type === 'REPEATED_INCREASE');
  eq('REPEATED: Transport 100 -> 150 -> 250 -> 400', [rep.category, rep.details.periods, rep.actualAmount, rep.baselineAmount], ['Transport', [100, 150, 250, 400], 400, 100]);
  eq('Transport has no separate CATEGORY_INCREASE (no double alert)', list.filter((d) => d.category === 'Transport').length, 1);
  const foodCat = list.find((d) => d.category === 'Food' && d.type === 'CATEGORY_INCREASE');
  eq('Food 30-day total 1620 (1500+120) vs avg 400 is a real +305% category increase', [foodCat.actualAmount, foodCat.baselineAmount, foodCat.percentChange], [1620, 400, 305]);
  eq('every detection has type/amounts/date/explanation', list.every((d) => d.type && d.actualAmount >= 0 && d.detectedAt && d.explanation.length > 20 && d.status === 'NEW'), true);
  eq('wording never claims fraud', list.every((d) => !/fraud|suspicious|stolen|hack/i.test(d.explanation)) && /not accusations/.test(res.data.disclaimer), true);

  // ---- duplicates ----
  const ids1 = list.map((d) => d.id).sort();
  const ids2 = (await U(T)).data.detections.map((d) => d.id).sort();
  await tx(T, 'EXPENSE', 90, 'Food', off(1)); // unrelated write => cache invalidated => detection re-run
  const ids3 = (await U(T)).data.detections.map((d) => d.id).sort();
  eq('same findings, same ids, no duplicates across reloads and re-detection', [ids1.length === new Set(ids1).size, JSON.stringify(ids2) === JSON.stringify(ids1), JSON.stringify(ids3) === JSON.stringify(ids1)], [true, true, true]);
  const N = list.length;
  eq('detection rows keyed: stored count equals findings count', (await U(T, 'all')).data.detections.length, N);

  // ---- review / dismiss ----
  const txBefore = (await call(T, 'GET', '/transactions?limit=500')).data.pagination.total;
  eq('dismiss', (await call(T, 'PATCH', `/unusual-spending/${cat.id}`, { status: 'DISMISSED' })).data.status, 'DISMISSED');
  eq('mark reviewed', (await call(T, 'PATCH', `/unusual-spending/${rep.id}`, { status: 'REVIEWED' })).data.status, 'REVIEWED');
  res = await U(T);
  eq('active list excludes the dismissed + reviewed ones; counts correct', [res.data.detections.some((d) => d.id === cat.id || d.id === rep.id), res.data.counts], [false, { new: N - 2, reviewed: 1, dismissed: 1 }]);
  eq('dismissed list has it, with statusUpdatedAt', [(await U(T, 'dismissed')).data.detections.map((d) => d.id), !!(await U(T, 'dismissed')).data.detections[0].statusUpdatedAt], [[cat.id], true]);
  await tx(T, 'EXPENSE', 55, 'Food', off(1)); // re-run detection
  res = await U(T);
  eq('dismissed/reviewed findings do NOT come back after recalculation', [res.data.detections.length, res.data.counts.dismissed, res.data.counts.reviewed, res.data.counts.new], [N - 2, 1, 1, N - 2]);
  eq('transactions untouched by dismiss/review', (await call(T, 'GET', '/transactions?limit=500')).data.pagination.total, txBefore + 1);
  eq('restore to NEW works', (await call(T, 'PATCH', `/unusual-spending/${cat.id}`, { status: 'NEW' })).data.status, 'NEW');
  eq('bad status => 400', (await call(T, 'PATCH', `/unusual-spending/${cat.id}`, { status: 'FRAUD' })).status, 400);
  eq('extra fields rejected', (await call(T, 'PATCH', `/unusual-spending/${cat.id}`, { status: 'NEW', actualAmount: 1 })).status, 400);

  // ---- related transactions ----
  eq('related (LARGE) = the transaction itself', (await call(T, 'GET', `/unusual-spending/${large.id}/transactions`)).data.transactions.map((t) => t.id), [big.id]);
  const relCat = (await call(T, 'GET', `/unusual-spending/${cat.id}/transactions`)).data.transactions;
  eq('related (CATEGORY) = that category\'s expenses in the window', [relCat.length, relCat.every((t) => t.category === 'Shopping')], [1, true]);

  // ---- recalculation when a transaction changes ----
  await call(T, 'DELETE', `/transactions/${big.id}`);
  res = await U(T);
  eq('deleting the unusual transaction removes its (unreviewed) detection', res.data.detections.some((d) => d.type === 'LARGE_TRANSACTION'), false);

  // ================= monthly rule =================
  const B = await register('a10month');
  [[5, 1000], [4, 1100], [3, 900], [2, 1000], [1, 2000]].forEach(() => {});
  for (const [back, total] of [[5, 1000], [4, 1100], [3, 900], [2, 1000], [1, 2000]]) {
    for (let c = 1; c <= 4; c++) await tx(B, 'EXPENSE', total / 4, `Cat${c}`, dm(back, 10));
  }
  res = await U(B);
  const mo = res.data.detections.find((d) => d.type === 'UNUSUAL_MONTH');
  eq('MONTH: last complete month 2000 vs mean 1000 of the 4 earlier months', [mo.actualAmount, mo.baselineAmount, mo.difference, mo.percentChange], [2000, 1000, 1000, 100]);
  eq('MONTH: explanation + prior months listed', mo.explanation.includes('৳2,000') && mo.explanation.includes('100%') && mo.details.priorMonths.length === 4, true);
  const B2 = await register('a10flat');
  for (const total of [1000, 1100, 900, 1000, 1050]) { const back = 5 - [1000, 1100, 900, 1000, 1050].indexOf(total); for (let c = 1; c <= 4; c++) await tx(B2, 'EXPENSE', total / 4, `Cat${c}`, dm(back, 10)); }
  eq('steady spending => no alerts', (await U(B2)).data.detections.length, 0);

  // ================= isolation =================
  const O = await register('a10other');
  eq('other user: nothing from T', (await U(O, 'all')).data.detections.length, 0);
  eq('other user cannot patch T\'s detection (404)', (await call(O, 'PATCH', `/unusual-spending/${cat.id}`, { status: 'DISMISSED' })).status, 404);
  eq('other user cannot read related transactions (404)', (await call(O, 'GET', `/unusual-spending/${cat.id}/transactions`)).status, 404);
  eq('T\'s detection unchanged by that attempt', (await U(T, 'all')).data.detections.find((d) => d.id === cat.id).status, 'NEW');
  done();
})().catch((e) => { console.error(e); process.exit(1); });
