const { call, register, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText);
const noToast = (page) => page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 9000 });
const clickEval = (page, sel) => page.$eval(sel, (b) => b.click());

(async () => {
  const srv = await serve();
  const now = new Date();
  const m1 = (off) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1)).toISOString().slice(0, 10);
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const mk = (T, type, amount, category, date, description) => call(T, 'POST', '/transactions', { type, amount, category, description, date });

  // ---- empty account ----
  const Z = await register('aiui-z');
  { const { browser, page, errors } = await open(Z, { hash: '/ai-assistant' }); await wait(2000);
    await page.$eval('#ai-q', (e) => { e.value = 'How much did I spend this month?'; });
    await clickEval(page, '#ai-form button[type="submit"]'); await wait(1500);
    const t = await txt(page, '#main');
    eq('empty account: honest "no transactions" answer flagged "Not enough data", recommendations say not enough data, no invented numbers', [t.includes('no transactions'), t.includes('Not enough data'), /Not enough data yet/.test(t)], [true, true, true]);
    eq('no console errors (empty)', errors, []);
    await browser.close(); }

  for (const vp of ['desktop', 'mobile']) {
    const T = await register('aiui-' + vp);
    await mk(T, 'INCOME', 50000, 'Salary', m1(0), 'Salary'); await mk(T, 'INCOME', 50000, 'Salary', m1(-1), 'Salary');
    for (let i = 0; i < 4; i += 1) await mk(T, 'EXPENSE', 1500, 'Food', m1(0), 'Lunch ' + i);
    for (let i = 0; i < 3; i += 1) await mk(T, 'EXPENSE', 1000, 'Shopping', m1(0), 'Shop');
    for (let i = 0; i < 2; i += 1) await mk(T, 'EXPENSE', 500, 'Transport', m1(0), 'Bus');
    await mk(T, 'EXPENSE', 12000, 'Rent', m1(0), 'Rent');
    for (let i = 0; i < 3; i += 1) await mk(T, 'EXPENSE', 1000, 'Food', m1(-1), 'Old food');
    await call(T, 'POST', '/budgets', { category: 'Food', limit: 6500, startDate: m1(0), endDate: lastDay });

    const { browser, page, errors } = await open(T, { hash: '/ai-assistant', viewport: vp }); await wait(2200);
    let t = await txt(page, '#main');
    eq(`[${vp}] page: disclaimer, empty conversation prompt, example chips, settings, recommendations`, [t.includes('not professional financial advice'), t.includes('Ask your first question'), (await page.$$('[data-example]')).length >= 8, t.includes('AI settings'), t.includes('Recommendations')], Array(5).fill(true));
    eq('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    eq('recommendations are real: Food +100% observation with evidence and an ESTIMATE label, budget at 92%', [t.includes('Food spending is up'), t.includes('ESTIMATE'), t.includes('Why am I seeing this?'), /92%/.test(t)], [true, true, true, true]);

    // ask via an example chip
    await clickEval(page, '[data-example="How much did I spend this month?"]'); await wait(1800);
    t = await txt(page, '#ai-log');
    eq('answer: exact figure, labelled "Calculated by FinTrack" (not AI), explanation available, estimate-free', [t.includes('৳22,000'), t.includes('Calculated by FinTrack'), !t.includes('AI-worded'), t.includes('How was this calculated?'), t.includes('Savings rate')], [true, true, true, true, true]);
    // type a question + UI period filter
    await page.$eval('#ai-range', (el) => { el.value = 'last_month'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.$eval('#ai-q', (e) => { e.value = 'How much did I spend?'; });
    await clickEval(page, '#ai-form button[type="submit"]'); await wait(1500);
    t = await txt(page, '#ai-log');
    eq('period filter applied (last month: 3,000 spent)', t.includes('৳3,000'), true);
    // unsupported
    await page.$eval('#ai-range', (el) => { el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.$eval('#ai-q', (e) => { e.value = 'Who won the football match yesterday?'; });
    await clickEval(page, '#ai-form button[type="submit"]'); await wait(1500);
    t = await txt(page, '#ai-log');
    eq('unsupported question: polite refusal with examples, no made-up answer', [t.includes('only answer questions about your own FinTrack data'), t.includes('Examples you can ask')], [true, true]);
    // validation
    await page.$eval('#ai-q', (e) => { e.value = 'hi'; });
    await clickEval(page, '#ai-form button[type="submit"]'); await wait(300);
    eq('too-short question: inline validation, nothing sent', (await txt(page, '#ai-q-error')).includes('at least 3'), true);

    // error + retry (offline)
    await page.setOfflineMode(true);
    await page.$eval('#ai-q', (e) => { e.value = 'How much did I spend this month?'; });
    await clickEval(page, '#ai-form button[type="submit"]'); await wait(2500);
    eq('network failure: friendly error with Try again, page still alive', [(await txt(page, '#ai-log')).includes('Could not get an answer'), (await page.$$('[data-action="retry"]')).length >= 1], [true, true]);
    await page.setOfflineMode(false);
    await noToast(page);
    await page.$eval('#ai-log [data-action="retry"]', (b) => b.click()); await wait(2000);
    eq('retry succeeds after reconnecting', (await txt(page, '#ai-log')).split('৳22,000').length >= 3, true);
    await page.$eval('[data-action="clear"]', (b) => b.click()); await wait(300);
    eq('clear conversation', (await txt(page, '#ai-log')).includes('Ask your first question'), true);

    // dismiss a recommendation
    const nrec = (await page.$$('#ai-recs [data-action="dismiss"]')).length;
    await page.$eval('#ai-recs [data-action="dismiss"]', (b) => b.click()); await wait(1800);
    eq('dismiss removes one recommendation and it stays gone after reload', [(await page.$$('#ai-recs [data-action="dismiss"]')).length, (await call(T, 'GET', '/ai/recommendations')).data.recommendations.length], [nrec - 1, nrec - 1]);

    // settings: switch off
    await noToast(page);
    await page.$eval('[data-set="enabled"]', (c) => c.click()); await wait(1500);
    eq('assistant off: banner shown, input disabled, server refuses (403)', [(await txt(page, '#ai-state')).includes('switched off'), await page.$eval('#ai-q', (e) => e.disabled), (await call(T, 'POST', '/ai/ask', { question: 'How much did I spend?' })).status], [true, true, 403]);
    await noToast(page);
    await page.$eval('[data-set="enabled"]', (c) => c.click()); await wait(1500);
    eq('assistant on again', [await page.$eval('#ai-q', (e) => e.disabled), (await call(T, 'POST', '/ai/ask', { question: 'How much did I spend?' })).status], [false, 200]);
    eq('external AI switch is available (server configured) but OFF by default, privacy text shown', [await page.$eval('[data-set="externalAi"]', (c) => c.checked), (await txt(page, '#ai-settings')).includes('sent to that provider')], [false, true]);
    eq(`[${vp}] no console errors`, errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|Cannot reach the server/i.test(e)), []);
    await browser.close();
  }
  srv.close && srv.close();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
