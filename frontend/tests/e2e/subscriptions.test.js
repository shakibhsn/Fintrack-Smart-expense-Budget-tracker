const { call, register, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setv = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(v));
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText);
const noToast = (page) => page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 9000 });

(async () => {
  const srv = await serve();
  const now = new Date(); const dd = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10);

  // ---- empty ----
  const Z = await register('sbui-z');
  { const { browser, page, errors } = await open(Z, { hash: '/subscriptions' }); await wait(1200);
    const t = await txt(page, '#main');
    eq('empty: honest empty state, no example subscriptions, zero totals', [t.includes('No subscriptions yet'), /Netflix|Spotify/.test(t), (await txt(page, '#sb-summary')).includes('৳0')], [true, false, true]);
    eq('empty: no console errors', errors, []);
    await browser.close(); }

  for (const vp of ['desktop', 'mobile']) {
    const T = await register('sbui-' + vp);
    const { browser, page, errors } = await open(T, { hash: '/subscriptions', viewport: vp }); await wait(1200);
    // validation
    await page.click('#main [data-action="add"]'); await wait(300);
    await page.click('button[form="sb-form"]'); await wait(200);
    eq(`[${vp}] form: name + amount required (inline)`, [(await txt(page, '#sb-name-error')).length > 0, (await txt(page, '#sb-amount-error')).length > 0], [true, true]);
    await setv(page, '#sb-frequency', 'CUSTOM');
    eq('form: custom interval field appears for Custom', await page.$eval('#sb-custom-wrap', (e) => !e.hidden), true);
    await page.type('#sb-name', 'Video streaming'); await setv(page, '#sb-amount', 500);
    await page.click('button[form="sb-form"]'); await wait(200);
    eq('form: custom billing needs the interval', (await txt(page, '#sb-interval-error')).length > 0, true);
    await setv(page, '#sb-frequency', 'MONTHLY'); await setv(page, '#sb-start', dd(-10)); await setv(page, '#sb-end', dd(-20));
    await page.click('button[form="sb-form"]'); await wait(200);
    eq('form: end before start => inline error', (await txt(page, '#sb-end-error')).includes('on or after'), true);
    await setv(page, '#sb-end', ''); await setv(page, '#sb-next', dd(0)); await page.select('#sb-category', 'Entertainment');
    await page.click('button[form="sb-form"]'); await wait(1500);
    const card = await txt(page, '[data-sub]');
    eq('created: card shows price, Active, due-today warning (NOT assumed paid), estimate', [card.includes('Video streaming'), card.includes('Active'), card.includes('Renewal date reached: confirm payment'), card.includes('৳500')], [true, true, true, true]);
    eq('no payment or expense was created just because the date arrived', [(await call(T, 'GET', '/transactions')).data.transactions.length, (await call(T, 'GET', '/subscriptions/summary')).data.actualPayments.last12Months], [0, 0]);
    const sm = await txt(page, '#sb-summary');
    eq('summary: 1 active, monthly 500 / yearly 6,000 labelled ESTIMATE', [/ACTIVE SUBSCRIPTIONS\s*1/i.test(sm), sm.includes('৳500'), sm.includes('৳6,000'), (sm.match(/ESTIMATE/g) || []).length >= 2], [true, true, true, true]);
    eq('upcoming widget lists it with a Confirm action; category chart drawn', [(await txt(page, '#sb-upcoming')).includes('Video streaming'), (await page.$$('#sb-cat-chart')).length], [true, 1]);

    // more subscriptions via API to exercise filters/summary
    await call(T, 'POST', '/subscriptions', { name: 'Cloud storage', category: 'Cloud Services', amount: 1200, frequency: 'YEARLY', startDate: dd(-5), nextRenewalDate: dd(20) });
    const p = (await call(T, 'POST', '/subscriptions', { name: 'Paused plan', category: 'Software', amount: 99, frequency: 'MONTHLY', startDate: dd(-5), nextRenewalDate: dd(9) })).data.subscription;
    await call(T, 'POST', `/subscriptions/${p.id}/pause`);
    const c = (await call(T, 'POST', '/subscriptions', { name: 'Old gym app', category: 'Other', amount: 50, frequency: 'MONTHLY', startDate: dd(-60), nextRenewalDate: dd(3) })).data.subscription;
    await call(T, 'POST', `/subscriptions/${c.id}/cancel`);
    await call(T, 'POST', '/subscriptions', { name: 'Ended plan', category: 'Education', amount: 20, frequency: 'MONTHLY', startDate: dd(-80), endDate: dd(-30) });
    await page.reload({ waitUntil: 'networkidle0' }); await wait(1500);
    const names = async () => page.$$eval('[data-sub] h3', (h) => h.map((x) => x.textContent.trim()).sort());
    eq('filter Active (default): only active plans', await names(), ['Cloud storage', 'Video streaming']);
    for (const [f, expected] of [['paused', ['Paused plan']], ['cancelled', ['Old gym app']], ['expired', ['Ended plan']], ['all', ['Cloud storage', 'Ended plan', 'Old gym app', 'Paused plan', 'Video streaming']], ['upcoming', ['Cloud storage', 'Video streaming']]]) {
      await page.click(`[data-chip="status"][data-value="${f}"]`); await wait(900);
      eq(`filter ${f}`, await names(), expected);
    }
    const sm2 = await txt(page, '#sb-summary');
    eq('summary after changes: paused/cancelled/expired are NOT in the cost (monthly 600 = 500 + 100)', [sm2.includes('৳600'), sm2.includes('1 paused') && sm2.includes('1 cancelled') && sm2.includes('1 expired')], [true, true]);
    eq('recently cancelled + most expensive widgets', [(await txt(page, '#sb-cancelled')).includes('Old gym app'), (await txt(page, '#sb-top')).includes('Video streaming')], [true, true]);

    // actions
    await page.click('[data-chip="status"][data-value="all"]'); await wait(900);
    const act = (name, a) => page.evaluate((n, x) => { const card = [...document.querySelectorAll('[data-sub]')].find((c) => c.querySelector('h3').textContent.trim() === n); card.querySelector(`[data-action="${x}"]`).click(); }, name, a);
    await noToast(page).catch(() => {});
    await act('Paused plan', 'resume'); await wait(1200);
    eq('resume: becomes active, nothing charged', [(await call(T, 'GET', '/subscriptions?status=paused')).data.subscriptions.length, (await call(T, 'GET', '/transactions')).data.transactions.length], [0, 0]);
    await noToast(page).catch(() => {});
    await act('Cloud storage', 'cancel'); await wait(300);
    eq('cancel asks first and explains it only updates FinTrack', (await txt(page, '[role=dialog]')).includes('cancel the plan with the provider too'), true);
    await page.click('[data-confirm="no"]'); await wait(200);
    eq('declining keeps it active', (await call(T, 'GET', '/subscriptions?status=active')).data.subscriptions.some((s) => s.name === 'Cloud storage'), true);
    await noToast(page).catch(() => {});
    await act('Video streaming', 'pay'); await wait(300);
    eq('mark-paid dialog states the amount and renewal, offers an optional expense', [(await txt(page, '[role=dialog]')).includes('৳500'), await page.$eval('#sp-tx', (e) => e.checked)], [true, true]);
    await page.click('#sp-submit'); await wait(1500);
    const txs = (await call(T, 'GET', '/transactions')).data.transactions;
    eq('payment confirmed: ONE expense (500, Entertainment) recorded; next renewal moved a month on', [txs.length, txs[0] && txs[0].amount, txs[0] && txs[0].category, (await call(T, 'GET', '/subscriptions?status=active')).data.subscriptions.find((s) => s.name === 'Video streaming').nextRenewalDate > dd(20)], [1, 500, 'Entertainment', true]);
    await noToast(page).catch(() => {});
    await act('Video streaming', 'details'); await wait(900);
    const dt = await txt(page, '[role=dialog]');
    eq('details: estimate vs ACTUAL history clearly labelled, payment listed', [dt.includes('ESTIMATE'), dt.includes('ACTUAL'), dt.includes('Confirmed by you'), dt.includes('expense recorded')], [true, true, true, true]);
    await page.keyboard.press('Escape'); await wait(200);
    await noToast(page).catch(() => {});
    await act('Ended plan', 'delete'); await wait(300);
    eq('delete asks first; expenses are kept', (await txt(page, '[role=dialog]')).includes('stay in your transactions'), true);
    await page.click('[data-confirm="yes"]'); await wait(1200);
    eq('deleted', (await call(T, 'GET', '/subscriptions?status=expired')).data.subscriptions.length, 0);
    eq('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    eq('no console errors', errors, []);
    await browser.close(); }

  // ---- error isolation: one summary widget request fails ----
  { const T = await register('sbui-err');
    const { browser, page } = await open(T, { hash: '/subscriptions', failMatch: '/api/subscriptions/summary' }); await wait(1500);
    eq('summary API failure => each summary widget shows its own error + Retry; the list still works', [(await txt(page, '#sb-summary')).includes('Try again'), (await txt(page, '#sb-list')).includes('No subscriptions yet'), (await page.$$('.nav-link')).length > 10], [true, true, true]);
    await browser.close(); }
  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
