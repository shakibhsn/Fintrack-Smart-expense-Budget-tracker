const { call, register, tx, eq, done } = require('./lib');
const { serve, open, hits } = require('./harness');
const fs = require('fs'); const path = require('path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const go = async (page, hash, ms = 1100) => { await page.evaluate((h) => { location.hash = '#' + h; }, hash); await wait(ms); };
const PAGES = ['/dashboard', '/transactions', '/budgets', '/analytics', '/savings-goals', '/insights', '/forecast', '/health-score', '/anomaly-detection', '/simulator', '/recurring', '/subscriptions', '/ai-assistant', '/reports', '/import', '/export', '/notifications', '/settings'];

(async () => {
  const srv = await serve();
  const now = new Date(); const d = (back, day) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, day)).toISOString().slice(0, 10);
  const T = await register('quality');
  for (let b = 0; b <= 4; b++) { await tx(T, 'INCOME', 50000, 'Salary', d(b, 1)); for (let i = 0; i < 4; i++) await tx(T, 'EXPENSE', 1500 + i * 300 + b * 50, ['Food', 'Transport', 'Shopping', 'Bills'][i], d(b, 2 + i), 'a long description to stress wrapping ' + i); }
  await call(T, 'POST', '/budgets', { category: 'Food', limit: 1700, startDate: d(0, 1), endDate: d(-1, 0) });
  await call(T, 'POST', '/goals', { title: 'A goal with quite a long title to test truncation', targetAmount: 10000, savedAmount: 2500, targetDate: d(-3, 1) });
  await call(T, 'POST', '/recurring', { title: 'Monthly Rent with a long name', type: 'EXPENSE', amount: 1200, category: 'Bills', frequency: 'MONTHLY', startDate: d(-1, 5) });

  // ============== RESPONSIVE: 1440 / 1280 / 768 / 390 ==============
  for (const vp of ['desktop', 'laptop', 'tablet', 'mobile']) {
    const { browser, page, errors } = await open(T, { hash: '/dashboard', viewport: vp }); await wait(1400);
    const w = await page.evaluate(() => innerWidth);
    const isDrawer = w < 1024;
    eq(`[${w}px] sidebar: ${isDrawer ? 'hidden drawer + hamburger' : 'visible'}`, await page.evaluate((drawer) => { const s = document.getElementById('sidebar').getBoundingClientRect(); const h = document.querySelector('[data-action="open-drawer"]'); return drawer ? (s.right <= 1 && getComputedStyle(h).display !== 'none') : (s.left >= 0 && s.width > 60 && getComputedStyle(h).display === 'none'); }, isDrawer), true);
    const bad = [];
    for (const p of PAGES) {
      await go(page, p, 1250);
      const r = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, tiny: [...document.querySelectorAll('button, a.btn, [role=tab], input:not([type=hidden]), select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24) && !e.closest('[hidden]') && !e.classList.contains('sr-only') && !(e.type === 'checkbox' || e.type === 'radio' || e.type === 'range'); }).length, chartsBlank: [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width < 40).length }));
      if (r.over > 1) bad.push(`${p} overflow ${r.over}px`);
      if (r.tiny) bad.push(`${p} ${r.tiny} controls < 24px`);
      if (r.chartsBlank) bad.push(`${p} ${r.chartsBlank} blank charts`);
    }
    eq(`[${w}px] all 12 pages: no overflow, targets >= 24px, charts sized`, bad, []);
    // modals + dropdowns fit the viewport
    await go(page, '/transactions', 1100);
    await page.evaluate(() => document.querySelector('[data-action="quick-add"]').click()); await wait(400);
    const m = await page.evaluate(() => { const r = document.querySelector('.modal').getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, scrollable: getComputedStyle(document.querySelector('.modal-body')).overflowY }; });
    eq(`[${w}px] modal fits inside the viewport (body scrolls if tall)`, [m.fits, m.scrollable], [true, 'auto']);
    await page.keyboard.press('Escape'); await wait(200);
    await page.click('#notif-trigger'); await wait(500);
    eq(`[${w}px] notifications dropdown stays on screen`, await page.evaluate(() => { const r = document.getElementById('notif-menu').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }), true);
    await page.click('#profile-trigger'); await wait(300);
    eq(`[${w}px] profile menu stays on screen`, await page.evaluate(() => { const r = document.getElementById('profile-menu').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }), true);
    eq(`[${w}px] no console errors`, errors, []);
    if (vp === 'mobile' || vp === 'tablet') { await page.keyboard.press('Escape'); await go(page, '/dashboard', 1300); await page.screenshot({ path: path.join(__dirname, `m-q-${vp}.png`) }); }
    await browser.close(); }

  // ============== COLOUR CONTRAST (WCAG 2.1 AA), computed from the actual tokens ==============
  { const { browser, page } = await open(T, { hash: '/settings' }); await wait(1000);
    const results = await page.evaluate(() => {
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
      const out = {};
      for (const theme of ['light', 'dark']) {
        document.documentElement.setAttribute('data-theme', theme);
        const cs = getComputedStyle(document.documentElement);
        const v = (n) => cs.getPropertyValue(`--${n}`).trim().split(/\s+/).map(Number);
        const pairs = { 'body text / page bg': ['ink', 'bg'], 'body text / card': ['ink', 'surface'], 'muted text / card': ['mute', 'surface'], 'muted text / page bg': ['mute', 'bg'], 'muted text / input bg': ['mute', 'surface-2'], 'brand text / card': ['brand-text', 'surface'], 'brand text / brand tint': ['brand-text', 'brand-tint'], 'button text / button fill': ['on-brand', 'brand-fill'], 'danger text / card': ['danger', 'surface'], 'danger text / danger tint': ['danger', 'danger-soft'], 'warning text / card': ['warning', 'surface'], 'warning text / warning tint': ['warning', 'warning-soft'], 'income text / card': ['income', 'surface'], 'expense text / card': ['expense', 'surface'] };
        out[theme] = Object.fromEntries(Object.entries(pairs).map(([k, [a, b]]) => [k, Math.round(ratio(v(a), v(b)) * 100) / 100]));
        out[theme]['focus ring / card (non-text, needs 3)'] = Math.round(ratio(v('focus'), v('surface')) * 100) / 100;
      }
      document.documentElement.setAttribute('data-theme', 'light');
      return out;
    });
    for (const theme of ['light', 'dark']) for (const [k, r] of Object.entries(results[theme])) { const need = /non-text/.test(k) ? 3 : 4.5; eq(`contrast ${theme}: ${k} = ${r}:1 (>= ${need})`, r >= need, true); }
    await browser.close(); }

  // ============== MEMORY / LEAKS: repeated navigation ==============
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1500);
    const snap = () => page.evaluate(() => ({ nodes: document.querySelectorAll('*').length, charts: window.Chart ? Object.keys(Chart.instances).length : 0, modals: document.querySelectorAll('.modal-backdrop').length, toasts: document.querySelectorAll('.toast').length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : 0 }));
    const cycle = async () => { for (const p of PAGES) await go(page, p, 650); await go(page, '/dashboard', 900); };
    await cycle(); const s1 = await snap();
    await cycle(); await cycle(); await cycle(); const s2 = await snap();
    eq(`leaks: Chart instances do not accumulate (after 1 cycle ${s1.charts}, after 4 cycles ${s2.charts})`, s2.charts <= s1.charts, true);
    eq(`leaks: DOM node count does not grow (${s1.nodes} -> ${s2.nodes}, < +10%)`, s2.nodes <= s1.nodes * 1.1, true);
    eq('leaks: no orphan modals/backdrops', s2.modals, 0);
    eq(`leaks: JS heap does not balloon (${s1.heap}MB -> ${s2.heap}MB, < +60%)`, s1.heap === 0 || s2.heap < s1.heap * 1.6, true);
    // listeners: re-render the same page many times and make sure one click triggers one action
    await go(page, '/budgets', 1000); for (let i = 0; i < 5; i++) { await go(page, '/transactions', 500); await go(page, '/budgets', 500); }
    await page.evaluate(() => document.querySelector('#main [data-action="add"]').click()); await wait(300);
    eq('listeners: after 5 re-visits one click opens exactly ONE dialog (no duplicated handlers)', await page.$$eval('[role=dialog]', (d) => d.length), 1);
    await page.keyboard.press('Escape'); await wait(200);
    eq('theme change re-themes live charts', await (async () => { await go(page, '/dashboard', 1500); const before = await page.evaluate(() => Chart.defaults.color); await page.click('[data-action="toggle-theme"]'); await wait(500); return before !== (await page.evaluate(() => Chart.defaults.color)); })(), true);
    await browser.close(); }

  // ============== PERFORMANCE ==============
  { hits.length = 0;
    const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1800);
    const perf = await page.evaluate(() => { const nav = performance.getEntriesByType('navigation')[0]; const res = performance.getEntriesByType('resource'); const mods = res.filter((r) => r.name.includes('/src/') && r.name.endsWith('.js')); return { dcl: Math.round(nav.domContentLoadedEventEnd), titleAt: Math.round(performance.now()), moduleCount: mods.length, moduleBytes: mods.reduce((s, r) => s + (r.encodedBodySize || r.transferSize || 0), 0) }; });
    const srcRoot = path.join(__dirname, '..', '..', 'src', 'features');
    const pageFiles = fs.readdirSync(srcRoot).flatMap((dir) => fs.readdirSync(path.join(srcRoot, dir)).filter((f) => f.endsWith('Page.js')).map((f) => path.join(srcRoot, dir, f)));
    const allPagesBytes = pageFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
    const loadedPages = pageFiles.filter((f) => hits.some((h) => h.endsWith('/' + path.basename(f)))).reduce((s, f) => s + fs.statSync(f).size, 0);
    console.log(`INFO first dashboard load: ${perf.moduleCount} app modules, ~${Math.round(perf.moduleBytes / 1024)} KB of app JS; page code loaded ${Math.round(loadedPages / 1024)} KB of ${Math.round(allPagesBytes / 1024)} KB total (${Math.round(100 - (loadedPages / allPagesBytes) * 100)}% deferred); DOMContentLoaded ${perf.dcl} ms`);
    eq('performance: first load defers most page code (< 50% of all page modules downloaded)', loadedPages / allPagesBytes < 0.5, true);
    eq('performance: dashboard interactive (title rendered, DOMContentLoaded) in under 3s on localhost', perf.dcl < 3000, true);
    const t0 = Date.now(); await go(page, '/forecast', 0); await page.waitForSelector('#fc-body canvas, #fc-body .state', { timeout: 8000 }); const fcMs = Date.now() - t0;
    console.log(`INFO first visit of a lazy page (forecast, incl. code download + API + charts): ${fcMs} ms`);
    eq('performance: lazy page ready in under 3s', fcMs < 3000, true);
    await browser.close(); }

  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
