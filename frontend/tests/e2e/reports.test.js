const { call, register, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const noToast = (page) => page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 9000 });
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText);
const setv = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(v));

(async () => {
  const srv = await serve();
  const now = new Date();
  const mStart = (off) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1)).toISOString().slice(0, 10);
  const mk = (T, type, amount, category, date, description) => call(T, 'POST', '/transactions', { type, amount, category, description, date });

  // ---- empty ----
  const Z = await register('rpui-z');
  { const { browser, page, errors } = await open(Z, { hash: '/reports' }); await wait(1500);
    const t = await txt(page, '#main');
    eq('empty: honest empty state, no invented figures, no export buttons for nothing', [t.includes('No report yet'), (await page.$$('[data-action="export"]')).length], [true, 0]);
    eq('empty: no console errors', errors, []);
    await browser.close(); }

  for (const vp of ['desktop', 'mobile']) {
    const T = await register('rpui-' + vp);
    await mk(T, 'INCOME', 50000, 'Salary', mStart(0), 'Salary');
    await mk(T, 'EXPENSE', 12000, 'Rent', mStart(0), 'Rent');
    await mk(T, 'EXPENSE', 4000, 'Food', mStart(0), '=HYPERLINK("http://evil")');
    await mk(T, 'INCOME', 40000, 'Salary', mStart(-1), 'Old salary');
    await mk(T, 'EXPENSE', 10000, 'Rent', mStart(-1), 'Old rent');
    await call(T, 'POST', '/budgets', { category: 'Food', limit: 5000, startDate: mStart(0), endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) });
    const g = (await call(T, 'POST', '/goals', { title: 'Laptop', targetAmount: 1000 })).data.goal;
    await call(T, 'POST', `/goals/${g.id}/contributions`, { amount: 250 });

    const { browser, page, errors } = await open(T, { hash: '/reports', viewport: vp }); await wait(2000);
    let t = await txt(page, '#main');
    eq(`[${vp}] live report: banner, summary numbers, sections`, [t.includes('Live report'), t.includes('৳50,000'), t.includes('৳34,000'), t.includes('68%'), t.includes('Budget performance'), t.includes('Savings goals'), t.includes('Subscriptions'), t.includes('ESTIMATE') || t.toUpperCase().includes('ESTIMATE')], Array(8).fill(true));
    eq('charts drawn (trend + category)', (await page.$$('#rp-ch-trend, #rp-ch-cat')).length, 2);
    eq('budget row (Food 80%) and goal row (25%)', [t.includes('80%'), t.includes('Laptop') && t.includes('25%')], [true, true]);
    eq('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);

    // period switch + custom validation
    await setv(page, '#rp-period', 'last_month'); await wait(1500);
    t = await txt(page, '#main');
    eq('previous month: income 40,000, no previous-data comparison invented', [t.includes('৳40,000'), t.includes('No previous data')], [true, true]);
    await setv(page, '#rp-period', 'custom'); await wait(300);
    await setv(page, '#rp-start', '2030-01-10'); await setv(page, '#rp-end', '2030-01-01');
    await page.click('[data-action="apply"]'); await wait(400);
    eq('custom: reversed dates => inline error, no request', (await txt(page, '#rp-error')).includes('on or after'), true);
    await setv(page, '#rp-start', '2001-01-01'); await setv(page, '#rp-end', '2001-01-31');
    await page.click('[data-action="apply"]'); await wait(1500);
    eq('custom: empty period => empty state', (await txt(page, '#main')).includes('No transactions in this period'), true);
    await setv(page, '#rp-period', 'this_month'); await wait(1500);

    // snapshot flow
    await noToast(page); await page.click('[data-action="save"]'); await wait(1500);
    eq('snapshot saved: appears in history', [(await page.$$('[data-snap]')).length, (await txt(page, '#rp-history')).includes('Saved reports')], [1, true]);
    await noToast(page); await page.click('[data-action="save"]'); await wait(1500);
    eq('saving the same report again creates no duplicate', [(await page.$$('[data-snap]')).length, (await call(T, 'GET', '/reports/snapshots')).data.snapshots.length], [1, 1]);
    await mk(T, 'EXPENSE', 500, 'Food', mStart(0), 'later');
    await noToast(page); await page.click('[data-action="open-snap"]'); await wait(1500);
    t = await txt(page, '#main');
    eq('snapshot view: labelled frozen, old figures (16,000 not 16,500), back-to-live', [t.includes('Saved snapshot'), t.includes('৳16,000'), t.includes('৳16,500'), (await page.$$('[data-action="live"]')).length], [true, true, false, 1]);
    await page.click('[data-action="live"]'); await wait(1500);
    eq('live report shows the new expense', (await txt(page, '#main')).includes('৳16,500'), true);

    // downloads (real files via the authenticated download helper)
    const dl = await page.evaluate(async () => {
      const { exportReport } = await import('/src/features/reports/reportService.js');
      const out = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { out.push({ name: this.download, blob: this.href.startsWith('blob:') }); };
      try {
        const a = await exportReport({ period: 'this_month' }, 'pdf'); const b = await exportReport({ period: 'this_month' }, 'csv');
        return { a, b, out };
      } finally { HTMLAnchorElement.prototype.click = orig; }
    });
    eq('PDF and CSV downloads: named files with content', [/\.pdf$/.test(dl.a.name), dl.a.size > 3000, /\.csv$/.test(dl.b.name), dl.b.size > 200, dl.out.every((o) => o.blob)], [true, true, true, true, true]);

    // delete snapshot
    await noToast(page); await page.click('[data-action="snap-delete"]'); await wait(500);
    await page.click('[data-confirm="yes"]'); await wait(1200);
    eq('snapshot deleted', (await call(T, 'GET', '/reports/snapshots')).data.snapshots.length, 0);
    eq('no console errors', errors, []);
    await browser.close();
  }
  srv.close && srv.close();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
