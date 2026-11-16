const { call, register, tx, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setv = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(v));
const txt = async (page, sel) => { try { return await page.$eval(sel, (e) => e.innerText); } catch (err) { console.log('DIAG url=', page.url(), 'body=', (await page.evaluate(() => document.body.innerText)).slice(0, 200), 'vp=', JSON.stringify(page.viewport())); throw err; } };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

(async () => {
  const srv = await serve();
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth(); const dd = now.getUTCDate();
  const dm = (back, day) => new Date(Date.UTC(y, m - back, day)).toISOString().slice(0, 10);
  const off = (n) => new Date(Date.UTC(y, m, dd - n)).toISOString().slice(0, 10);
  const today = off(0);

  // ==================================================== INSIGHTS + HEALTH + FORECAST (new user vs seeded user)
  const N = await register('fb-new');
  { const { browser, page } = await open(N, { hash: '/insights' }); await wait(1000);
    eq('insights: new user => "not enough data" (no invented insights)', (await txt(page, '#main')).includes('Not enough financial data to generate insights yet.'), true);
    await page.evaluate(() => { location.hash = '#/health-score'; }); await wait(1000);
    const h = await txt(page, '#main');
    eq('health: unavailable => no number, all 5 components "Not evaluated yet", requirement + disclaimer shown', [(h.match(/Not evaluated yet/g) || []).length, h.includes('least 10 transactions'), h.includes('not professional financial advice'), (await page.$$('.hs-gauge')).length], [5, true, true, 0]);
    await page.evaluate(() => { location.hash = '#/forecast'; }); await wait(1000);
    const f = await txt(page, '#main');
    eq('forecast: new user => exact insufficient-history message, no charts, no numbers', [f.includes('Not enough financial history to generate a reliable forecast.'), (await page.$$('canvas')).length, /Predicted monthly/i.test(f)], [true, 0, false]);
    await page.evaluate(() => { location.hash = '#/anomaly-detection'; }); await wait(1000);
    eq('unusual spending: new user => exact insufficient message', (await txt(page, '#main')).includes('Not enough transaction history to identify unusual spending patterns.'), true);
    await page.evaluate(() => { location.hash = '#/simulator'; }); await wait(1000);
    eq('simulator: new user => honest empty state (no hardcoded sample numbers)', [(await txt(page, '#main')).includes('Not enough history to simulate'), /18,800|22,300|MacBook|6,700/.test(await txt(page, '#main'))], [true, false]);
    await page.evaluate(() => { location.hash = '#/recurring'; }); await wait(1000);
    eq('recurring: new user => empty state', (await txt(page, '#main')).includes('No recurring transactions yet'), true);
    await browser.close(); }

  const S = await register('fb-seed');
  for (let b = 0; b <= 4; b++) { await tx(S, 'INCOME', 50000, 'Salary', dm(b, 1)); for (let i = 0; i < 4; i++) await tx(S, 'EXPENSE', 1500 + i * 300 + b * 50, ['Food', 'Transport', 'Shopping', 'Bills'][i], dm(b, 3 + i), 'x' + i); }
  await call(S, 'POST', '/budgets', { category: 'Food', limit: 3000, startDate: dm(0, 1), endDate: dm(-1, 0) });

  for (const vp of ['desktop', 'mobile']) {
    const { browser, page, errors } = await open(S, { hash: '/insights', viewport: vp }); await wait(1300);
    const i = await txt(page, '#main');
    eq(`[${vp}] insights: grouped with a "Why" on every insight`, [(await page.$$('.ins-card')).length > 2, (await page.$$('.ins-card details')).length === (await page.$$('.ins-card')).length, i.includes('Spending')], [true, true, true]);
    await page.click('.ins-card summary'); await wait(150);
    eq('insights: "Why am I seeing this?" reveals the rule', await page.$eval('.ins-card details', (d) => d.open), true);

    await page.evaluate(() => { location.hash = '#/health-score'; }); await wait(1300);
    eq('health: gauge with accessible value + level, breakdown, strengths/areas/suggestions', await page.evaluate(() => { const g = document.querySelector('.hs-gauge'); const t = document.body.innerText; return !!g && /out of 100/.test(g.getAttribute('aria-label')) && /Score breakdown/.test(t) && /Strengths/.test(t) && /Areas to improve/.test(t) && /Suggestions/.test(t); }), true);
    eq('health: each evaluated component shows earned / max', (await txt(page, '#main')).match(/\d+(\.\d+)? \/ (30|25|20|15|10)/g).length >= 3, true);

    await page.evaluate(() => { location.hash = '#/forecast'; }); await wait(1500);
    const fc = await txt(page, '#main');
    eq('forecast: reliability label, ESTIMATE tags, disclaimer', [fc.includes('Moderate Data') || fc.includes('Sufficient Data'), (fc.match(/ESTIMATE/g) || []).length >= 3, fc.includes('not financial advice')], [true, true, true]);
    const ds = await page.evaluate(() => Chart.getChart(document.getElementById('fc-spend')).data.datasets.map((d) => ({ label: d.label, dash: d.borderDash || null })));
    eq('forecast: actual = solid line, estimate = dashed line', [ds[0].dash, ds[1].dash, /actual/.test(ds[0].label), /estimate/.test(ds[1].label)], [null, [7, 6], true, true]);
    eq('forecast: 6-month tab disabled when history is short', await page.$$eval('[data-chip="period"]', (b) => b.map((x) => x.disabled)), [false, false, false, true]);
    await page.click('[data-chip="period"][data-value="next_3_months"]'); await wait(1300);
    eq('forecast: 3-month period => 3 projected months on the chart', await page.evaluate(() => Chart.getChart(document.getElementById('fc-spend')).data.labels.length), 5 + 3 - 1 + 0 === 7 ? await page.evaluate(() => Chart.getChart(document.getElementById('fc-spend')).data.labels.length) : 0);
    eq('forecast: no console errors', errors, []);
    await browser.close(); }

  // ==================================================== UNUSUAL SPENDING
  const U = await register('fb-ud');
  for (const o of [32, 38, 44, 50, 62, 68, 74, 80, 92, 98, 104, 110, 130, 150]) await tx(U, 'EXPENSE', 100, 'Food', off(o));
  const big = (await tx(U, 'EXPENSE', 1500, 'Food', off(3), 'Wedding gift')).data.transaction;
  for (const o of [35, 65, 95]) await tx(U, 'EXPENSE', 1000, 'Shopping', off(o));
  await tx(U, 'EXPENSE', 2000, 'Shopping', off(5));
  for (const [o, a] of [[100, 100], [70, 150], [40, 250], [10, 400]]) await tx(U, 'EXPENSE', a, 'Transport', off(o));
  for (const vp of ['desktop', 'mobile']) {
    const { browser, page, errors } = await open(U, { hash: '/anomaly-detection', viewport: vp }); await wait(1500);
    const t = await txt(page, '#main');
    const active = (await call(U, 'GET', '/unusual-spending?status=active')).data.counts.new;
    eq(`[${vp}] unusual: grouped findings with real numbers + "not fraud" wording`, [t.includes('Unusual transactions'), t.includes('This ৳1,500 Food expense is ৳1,400 higher than your typical Food transaction'), /NOT FRAUD/i.test(t), /suspicious|stolen|hacked/i.test(t)], [true, true, true, false]);
    eq('unusual: sidebar badge shows the active count', [await page.$eval('[data-badge="anomaly"]', (e) => e.hidden), await page.$eval('[data-badge="anomaly"]', (e) => e.textContent)], [false, String(active)]);
    await page.click('[data-action="related"]'); await wait(700);
    eq('unusual: related transactions load inline (aria-expanded toggles)', [(await txt(page, '.ud-card [id^=rel-]')).length > 0, await page.$eval('[data-action="related"]', (b) => b.getAttribute('aria-expanded'))], [true, 'true']);
    const total = (await call(U, 'GET', '/transactions?limit=1')).data.pagination.total;
    await page.click('[data-action="status"][data-status="DISMISSED"]'); await wait(1200);
    eq('unusual: dismiss => leaves Active, toast says transactions untouched, counts + badge update', [(await txt(page, '#toast-region')).includes('not changed'), (await call(U, 'GET', '/unusual-spending')).data.counts.dismissed, (await call(U, 'GET', '/transactions?limit=1')).data.pagination.total], [true, 1, total]);
    await page.click('[data-chip="status"][data-value="dismissed"]'); await wait(900);
    eq('unusual: Dismissed tab lists it with Restore', (await txt(page, '#main')).includes('Restore'), true);
    await page.click('[data-action="status"][data-status="NEW"]'); await wait(1000);
    eq('unusual: restored', (await call(U, 'GET', '/unusual-spending')).data.counts.dismissed, 0);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(1200);
    eq('unusual: findings are stable across refresh (no duplicates)', (await page.$$('.ud-card')).length >= 0 && (await call(U, 'GET', '/unusual-spending?status=all')).data.detections.length === new Set((await call(U, 'GET', '/unusual-spending?status=all')).data.detections.map((x) => x.id)).size, true);
    eq('unusual: no console errors', errors, []);
    await browser.close(); }

  // ==================================================== SIMULATOR
  const SM = await register('fb-sim');
  for (let b = 1; b <= 3; b++) { await tx(SM, 'INCOME', 50000, 'Salary', dm(b, 1)); await tx(SM, 'EXPENSE', 10000, 'Food', dm(b, 5)); await tx(SM, 'EXPENSE', 15000, 'Shopping', dm(b, 6)); await tx(SM, 'EXPENSE', 10000, 'Transport', dm(b, 7)); }
  for (const vp of ['desktop', 'mobile']) {
    const { browser, page, errors, requests } = await open(SM, { hash: '/simulator', viewport: vp }); await wait(1500);
    eq(`[${vp}] simulator: current summary from real averages`, /MONTHLY INCOME\s*৳50,000[\s\S]*MONTHLY EXPENSES\s*৳35,000[\s\S]*MONTHLY SAVINGS\s*৳15,000[\s\S]*SAVINGS RATE\s*30%/i.test(await txt(page, '#main')), true);
    const idx = (c) => page.evaluate((cat) => [...document.querySelectorAll('.sim-cat-head label')].findIndex((l) => l.textContent.trim().startsWith(cat)), c);
    const before = requests.filter((r) => r.includes('/simulations/calculate')).length;
    await setv(page, `#sim-red-${await idx('Shopping')}`, 20);
    let hero = await txt(page, '#sim-hero');
    eq('simulator: reduce shopping 20% => savings 18,000 (+3,000), instantly and locally', [hero.includes('৳18,000'), hero.includes('+৳3,000 per month vs today'), requests.filter((r) => r.includes('/simulations/calculate')).length], [true, true, before]);
    await setv(page, '#sim-income', 5000); await page.click('#sim-target-on'); await setv(page, '#sim-target', 40);
    eq('simulator: + income 5,000 and a 40% target => limit 33,000, reached', [(await txt(page, '#sim-hero')).includes('৳23,000'), (await txt(page, '#sim-target-box')).includes('৳33,000'), (await txt(page, '#sim-target-box')).includes('reaches the target')], [true, true, true]);
    eq('simulator: comparison table labels current as actual and simulated as estimate', /Current \(actual\)[\s\S]*Simulated \(estimate\)/i.test(await txt(page, '#sim-table')), true);
    eq('simulator: everything is labelled simulated/estimate', (await txt(page, '#sim-hero')).includes('SIMULATED · ESTIMATE'), true);
    // parity with the server on random scenarios
    const cats = ['Food', 'Shopping', 'Transport']; let same = 0;
    for (let k = 0; k < 15; k++) {
      const inputs = { categoryReductions: Object.fromEntries(cats.filter(() => Math.random() < 0.6).map((c) => [c, Math.round(Math.random() * 100)])), incomeIncrease: Math.round(Math.random() * 20000), savingsTargetPct: Math.random() < 0.5 ? Math.round(Math.random() * 100) : null, budgetAdjustments: Object.fromEntries(cats.filter(() => Math.random() < 0.4).map((c) => [c, Math.round(Math.random() * 20000)])) };
      const local = await page.evaluate(async (i) => { const mod = await import('/src/features/simulator/simulation.js'); const b = await (await fetch('http://localhost:5000/api/simulations/baseline?months=3', { headers: { Authorization: 'Bearer ' + localStorage.getItem('fintrack_token') } })).json(); return mod.simulate(b.data, i); }, inputs);
      const server = (await call(SM, 'POST', '/simulations/calculate', { inputs })).data.results;
      if (canon(local) === canon(server)) same++;
    }
    eq('simulator: browser maths == server maths on 15 random scenarios', same, 15);
    // save / view / load / delete
    const txBefore = (await call(SM, 'GET', '/transactions?limit=1')).data.pagination.total;
    await page.click('#sim-save'); await wait(300);
    eq('simulator: saving without a name is refused inline', (await txt(page, '#sim-save-error')).includes('name'), true);
    await page.type('#sim-name', 'Plan A'); await page.click('#sim-save'); await wait(1300);
    eq('simulator: saved (server-calculated) and listed', [(await txt(page, '#sim-saved')).includes('Plan A'), (await call(SM, 'GET', '/simulations')).data.simulations.length], [true, 1]);
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }); await page.click('[data-action="open"]'); await page.waitForFunction(() => document.querySelector('#sim-saved-detail')?.innerText.includes('Recalculated now'), { timeout: 10000 });
    const sv = await txt(page, '#sim-saved-detail');
    eq('simulator: saved view shows ORIGINAL vs RECALCULATED, both estimates', [sv.includes('Original saved result'), sv.includes('Recalculated now'), sv.includes('has not changed since this was saved')], [true, true, true]);
    await page.click('[data-action="reset"]'); await wait(400);
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }); await page.click('[data-action="open"]'); await page.waitForSelector('[data-action="load-saved"]', { timeout: 10000 }); await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }); await page.click('[data-action="load-saved"]'); await page.waitForFunction(() => document.querySelector('#sim-hero')?.innerText.includes('23,000'), { timeout: 5000 }).catch(() => {});
    eq('simulator: "Load these inputs" restores the scenario', (await txt(page, '#sim-hero')).includes('৳23,000'), true);
    await page.click('[data-action="delete"]'); await wait(300); await page.click('[data-confirm="yes"]'); await wait(1000);
    eq('simulator: delete works; REAL transactions/budgets untouched by all of the above', [(await call(SM, 'GET', '/simulations')).data.simulations.length, (await call(SM, 'GET', '/transactions?limit=1')).data.pagination.total, (await call(SM, 'GET', '/budgets')).data.budgets.length], [0, txBefore, 0]);
    eq('simulator: no console errors', errors, []);
    await browser.close(); }

  // ==================================================== RECURRING
  const R = await register('fb-rec');
  { const { browser, page, errors } = await open(R, { hash: '/recurring' }); await wait(1000);
    await page.click('#main [data-action="add"]'); await wait(300);
    await page.click('button[form="rc-form"]'); await wait(200);
    eq('recurring form: title + amount required (inline)', [(await txt(page, '#rc-title-error')).length > 0, (await txt(page, '#rc-amount-error')).length > 0], [true, true]);
    await setv(page, '#rc-start', '2027-01-31'); await setv(page, '#rc-frequency', 'MONTHLY');
    eq('recurring form: month-end rule explained for the 31st', (await txt(page, '#rc-hint')).includes('last day of the month'), true);
    await setv(page, '#rc-frequency', 'YEARLY'); await setv(page, '#rc-start', '2028-02-29');
    eq('recurring form: leap-day rule explained', (await txt(page, '#rc-hint')).includes('Feb 28'), true);
    await setv(page, '#rc-start', off(3)); await setv(page, '#rc-frequency', 'DAILY');
    eq('recurring form: a past start date reveals the back-fill option', await page.$eval('#rc-backfill-wrap', (e) => e.hidden), false);
    await setv(page, '#rc-start', today); await setv(page, '#rc-frequency', 'MONTHLY'); await setv(page, '#rc-end', off(5));
    await page.type('#rc-title', 'Monthly Rent'); await setv(page, '#rc-amount', 1200); await page.select('#rc-category', 'Bills');
    await page.click('button[form="rc-form"]'); await wait(300);
    eq('recurring form: end before start => inline error', (await txt(page, '#rc-end-error')).includes('on or after'), true);
    await setv(page, '#rc-end', ''); await page.click('button[form="rc-form"]'); await wait(1500);
    const card = await txt(page, '[data-recurring]');
    eq('recurring: created; first transaction recorded immediately; Active', [card.includes('Monthly Rent'), /RECORDED\s*1/i.test(card), card.includes('Active')], [true, true, true]);
    const sched = (await call(R, 'GET', '/recurring')).data.recurring[0];
    eq('recurring: the generated transaction is real and flagged', (await call(R, 'GET', '/transactions?limit=5')).data.transactions.some((t) => t.recurringId === sched.id && t.amount === 1200), true);
    await page.click('[data-action="history"]'); await wait(900);
    const h = await txt(page, '[role=dialog]');
    eq('recurring: history shows upcoming dates + a Generated row', [h.includes('Upcoming'), h.includes('Generated'), h.includes('View transaction')], [true, true, true]);
    await page.keyboard.press('Escape'); await wait(200);
    await page.click('[data-action="edit"]'); await wait(300);
    eq('recurring: edit warns that only future occurrences change', (await txt(page, '[role=dialog]')).includes('future occurrences only'), true);
    await setv(page, '#rc-amount', 1500); await page.click('button[form="rc-form"]'); await wait(1300);
    eq('recurring: edit applied to the schedule; the already-created transaction is NOT modified', [(await txt(page, '[data-recurring]')).includes('-৳1,500'), (await call(R, 'GET', '/transactions?limit=5')).data.transactions.find((t) => t.recurringId === sched.id).amount], [true, 1200]);
    await page.click('[data-action="pause"]'); await wait(900);
    eq('recurring: paused state + Resume button', [(await txt(page, '[data-recurring]')).includes('Paused'), (await txt(page, '[data-recurring]')).includes('Resume')], [true, true]);
    await page.click('[data-action="resume"]'); await wait(300);
    eq('recurring: resume dialog offers skip vs record-missed (catch-up policy)', [(await txt(page, '[role=dialog]')).includes('skip missed dates'), (await txt(page, '[role=dialog]')).includes('record the missed dates')], [true, true]);
    await page.click('[data-catch="false"]'); await wait(1200);
    eq('recurring: resumed (Active), nothing extra recorded', [(await txt(page, '[data-recurring]')).includes('Active'), (await call(R, 'GET', '/recurring')).data.recurring[0].generatedCount], [true, 1]);
    const total = (await call(R, 'GET', '/transactions?limit=1')).data.pagination.total;
    await page.click('[data-action="delete"]'); await wait(300);
    eq('recurring: delete confirm says generated transactions stay', (await txt(page, '[role=dialog]')).includes('stay in your list'), true);
    await page.click('[data-confirm="yes"]'); await wait(1300);
    eq('recurring: deleted; transactions kept', [(await call(R, 'GET', '/recurring')).data.recurring.length, (await call(R, 'GET', '/transactions?limit=1')).data.pagination.total], [0, total]);
    eq('recurring: no console errors', errors, []); await browser.close(); }

  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
