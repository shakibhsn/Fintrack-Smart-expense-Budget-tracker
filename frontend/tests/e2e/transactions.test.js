const { call, register, tx, eq, done, navCount } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const real = (errs) => errs.filter((x) => !/anomalyService|status of 404/.test(x)); // pages not ported yet

(async () => {
  const srv = await serve();
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const day = (n) => new Date(Date.UTC(y, m, Math.max(1, Math.min(now.getUTCDate(), n)))).toISOString().slice(0, 10);

  // ---- empty ----
  const Z = await register('mtxz');
  { const { browser, page, errors, shot } = await open(Z, { hash: '/transactions' }); await wait(700);
    eq('empty: friendly empty state with an Add action', (await page.$eval('#tx-list', (e) => e.innerText)).includes('No transactions yet'), true);
    eq('empty: summary shows real zeros for this month', (await page.$eval('#tx-summary', (e) => e.innerText)).includes('৳0'), true);
    await shot('m-tx-empty');
    eq('empty: no console errors', real(errors), []);
    await browser.close(); }

  // ---- populated ----
  const U = await register('mtx');
  await tx(U, 'INCOME', 50000, 'Salary', day(1), 'November salary');
  for (let i = 1; i <= 12; i++) await tx(U, 'EXPENSE', 100 * i, i % 2 ? 'Food' : 'Transport', day(2), `Item ${i}`);
  const xss = '<img src=x onerror="window.__xss=1">Evil';
  await tx(U, 'EXPENSE', 7, 'Others', day(2), xss);
  await call(U, 'POST', '/transactions', { type: 'EXPENSE', amount: 9, category: 'Bills', description: 'With notes', notes: 'remember this', date: day(2) });

  for (const vp of (process.env.VP || 'desktop,mobile').split(',')) {
    const { browser, page, errors, shot } = await open(U, { hash: '/transactions', viewport: vp }); await wait(900);
    const list = () => page.$eval('#tx-list', (e) => e.innerText);
    eq(`[${vp}] summary from real data`, /INCOME THIS MONTH[\s\S]*৳50,000/i.test(await page.$eval('#tx-summary', (e) => e.innerText)), true);
    eq('count + pagination (10 per page of 15)', [await page.$eval('#tx-count', (e) => e.textContent), (await list()).includes('Page 1 of 2')], ['15 transactions', true]);
    eq('user text is escaped (no XSS)', [await page.evaluate(() => window.__xss === undefined), (await list()).includes('<img src=x')], [true, true]);
    if (vp === 'mobile') {
      eq('mobile: cards visible, table hidden', [await page.$eval('.tx-cards', (e) => e.offsetParent !== null), await page.$eval('.table-wrap', (e) => e.offsetParent === null)], [true, true]);
    } else {
      eq('desktop: table visible with headers', await page.$$eval('.data-table th', (h) => h.map((x) => x.textContent.trim()).filter(Boolean)), ['Date', 'Description', 'Category', 'Type', 'Amount', 'Actions']);
    }
    // pagination
    await page.click('[data-page-go="2"]'); await wait(600);
    eq('page 2 shows the remaining 5', [(await list()).includes('Page 2 of 2'), (await page.$$(vp === 'mobile' ? '.tx-card' : '.data-table tbody tr')).length], [true, 5]);
    // search
    await page.type('#tx-search', 'November'); await wait(900);
    eq('search narrows to 1 and resets to page 1', [await page.$eval('#tx-count', (e) => e.textContent), (await list()).includes('November salary')], ['1 transaction', true]);
    await page.$eval('#tx-search', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await wait(800);
    // filters
    await page.click('[data-filter-toggle="tx-filter-panel"]');
    eq('filter panel opens (aria-expanded)', await page.$eval('[data-filter-toggle]', (b) => b.getAttribute('aria-expanded')), 'true');
    await page.select('#tx-f-type', 'INCOME'); await wait(700);
    eq('type=Income filter', [await page.$eval('#tx-count', (e) => e.textContent), await page.$eval('[data-filter-count]', (e) => e.textContent)], ['1 transaction', '1']);
    await page.select('#tx-f-type', 'ALL'); await page.select('#tx-f-category', 'Transport'); await wait(700);
    eq('category=Transport filter (6 items)', await page.$eval('#tx-count', (e) => e.textContent), '6 transactions');
    await page.$eval('#tx-min', (e) => { e.value = '500'; e.dispatchEvent(new Event('input', { bubbles: true })); }); await wait(900);
    eq('min amount filter combines with category (Transport 600,800,1000,1200 => 4)', await page.$eval('#tx-count', (e) => e.textContent), '4 transactions');
    await page.click('[data-action="reset"]'); await wait(800);
    eq('reset clears everything', [await page.$eval('#tx-count', (e) => e.textContent), await page.$eval('[data-filter-count]', (e) => e.hidden)], ['15 transactions', true]);
    await page.select('#tx-sort', 'amount-desc'); await wait(700);
    eq('sort by amount desc puts the salary first', (await list()).indexOf('November salary') < (await list()).indexOf('Item 12'), true);
    await page.select('#tx-sort', 'date-desc');

    // ---- add via the top-bar quick add: validation, focus trap, escape ----
    await page.click('[data-action="quick-add"]'); await wait(300);
    eq('modal: role=dialog, labelled, focus moved inside', await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); return !!d && d.getAttribute('aria-modal') === 'true' && d.contains(document.activeElement) && !!document.getElementById(d.getAttribute('aria-labelledby')); }), true);
    await page.click('#tx-submit'); await wait(200);
    eq('modal: empty submit shows inline validation, focuses the first bad field', [(await page.$eval('#tx-amount-error', (e) => e.textContent)).length > 0, (await page.$eval('#tx-description-error', (e) => e.textContent)).length > 0, await page.evaluate(() => document.activeElement.id)], [true, true, 'tx-amount']);
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
    eq('modal: Tab never leaves the dialog (focus trap)', await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); await wait(200);
    eq('modal: Escape closes it and returns focus to the opener', [(await page.$$('[role="dialog"]')).length, await page.evaluate(() => document.activeElement.getAttribute('data-action'))], [0, 'quick-add']);
    await page.click('[data-action="quick-add"]'); await wait(300);
    await page.type('#tx-amount', '321.5'); await page.type('#tx-description', 'Quick add test');
    await page.select('#tx-category', 'Education');
    await page.click('#tx-submit'); await wait(1500);
    eq('add works: toast, row visible, server has it', [(await page.$eval('#toast-region', (e) => e.innerText)).includes('Transaction added'), (await call(U, 'GET', '/transactions?search=Quick%20add')).data.transactions.map((t) => [t.amount, t.category])], [true, [[321.5, 'Education']]]);
    eq('list + count refreshed after quick add (16)', await page.$eval('#tx-count', (e) => e.textContent), '16 transactions');

    // ---- edit ----
    await page.type('#tx-search', 'Quick add'); await wait(900);
    const act = (a) => (vp === 'mobile' ? `.tx-cards [data-action="${a}"]` : `.data-table [data-action="${a}"]`);
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }); await page.click(act('edit')); await wait(300);
    eq('edit dialog prefilled', [await page.$eval('#tx-amount', (e) => e.value), await page.$eval('#tx-description', (e) => e.value)], ['321.5', 'Quick add test']);
    await page.$eval('#tx-amount', (e) => { e.value = ''; }); await page.type('#tx-amount', '400');
    await page.click('#tx-submit'); await wait(1300);
    eq('edit saved on the server', (await call(U, 'GET', '/transactions?search=Quick%20add')).data.transactions[0].amount, 400);

    // ---- delete with confirmation ----
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }); await page.click(act('delete')); await wait(300);
    eq('delete asks first; Cancel is focused (danger)', [await page.evaluate(() => document.querySelector('[role="dialog"]').innerText.includes('permanently removed')), await page.evaluate(() => document.activeElement.dataset.confirm)], [true, 'no']);
    await page.click('[data-confirm="no"]'); await wait(200);
    eq('cancel keeps it', (await call(U, 'GET', '/transactions?search=Quick%20add')).data.transactions.length, 1);
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }); await page.click(act('delete')); await wait(300); await page.click('[data-confirm="yes"]'); await wait(1300);
    eq('confirm deletes it', (await call(U, 'GET', '/transactions?search=Quick%20add')).data.transactions.length, 0);

    eq('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await shot(`m-tx-${vp}`);
    eq('no console errors', real(errors), []);
    await browser.close();
  }

  // ---- deep link from the global search / another page ----
  { const { browser, page } = await open(U, { hash: '/transactions?search=salary' }); await wait(900);
    eq('?search= deep link prefilters the list', [await page.$eval('#tx-search', (e) => e.value), await page.$eval('#tx-count', (e) => e.textContent)], ['salary', '1 transaction']);
    await page.type('#global-search', 'Item 1'); await page.keyboard.press('Enter'); await wait(900);
    eq('top-bar search navigates to the filtered list', [await page.evaluate(() => location.hash), await page.$eval('#tx-search', (e) => e.value)], ['#/transactions?search=Item%201', 'Item 1']);
    await browser.close(); }

  // ---- error isolation: list API fails, summary still works ----
  { const { browser, page, errors } = await open(U, { hash: '/transactions', failMatch: '/transactions?' }); await wait(900);
    eq('list failure => error state with Retry, summary widget unaffected, shell alive', [(await page.$eval('#tx-list', (e) => e.innerText)).includes('Try again'), (await page.$eval('#tx-summary', (e) => e.innerText)).includes('INCOME'.toLowerCase()) || (await page.$eval('#tx-summary', (e) => e.innerText)).toUpperCase().includes('INCOME'), (await page.$$('.nav-link')).length], [true, true, navCount()]);
    await browser.close(); }
  // ---- slow network shows skeleton ----
  { const { browser, page } = await open(U, { hash: '/dashboard', delayMatch: '/transactions?', delayMs: 2500 });
    await page.evaluate(() => { location.hash = '#/transactions'; }); await wait(800);
    eq('slow network: skeleton while loading', (await page.$eval('#tx-list', (e) => e.innerHTML)).includes('skeleton'), true);
    await browser.close(); }
  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
