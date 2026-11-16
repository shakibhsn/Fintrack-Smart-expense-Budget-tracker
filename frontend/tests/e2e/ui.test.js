// Phase 18: design system consistency, dark mode, theme persistence, responsive layout, accessibility, on EVERY page.
const fs = require('fs');
const path = require('path');
const { call, register, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const { inPage } = require('./uiAudit');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const routes = [...fs.readFileSync(path.join(__dirname, '../../src/core/routes.js'), 'utf8').matchAll(/\{ path: '(\/[a-z-]+)'/g)].map((m) => m[1]);
const noToast = (page) => page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 9000 });

(async () => {
  const srv = await serve();
  const T = await register('ui18');
  const now = new Date(); const m1 = (o) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + o, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const mk = (type, amount, category, date, description) => call(T, 'POST', '/transactions', { type, amount, category, description, date });
  await mk('INCOME', 50000, 'Salary', m1(0), 'Salary'); await mk('INCOME', 50000, 'Salary', m1(-1), 'Salary');
  for (let i = 0; i < 6; i += 1) await mk('EXPENSE', 900 + i * 50, ['Food', 'Shopping', 'Transport'][i % 3], m1(0), 'Item with a rather long description number ' + i);
  for (let i = 0; i < 4; i += 1) await mk('EXPENSE', 800, ['Food', 'Shopping'][i % 2], m1(-1), 'Old ' + i);
  await mk('EXPENSE', 12000, 'Rent', m1(-1), 'Rent');
  await call(T, 'POST', '/budgets', { category: 'Food', limit: 2000, startDate: m1(0), endDate: last });
  const g = (await call(T, 'POST', '/goals', { title: 'Emergency fund', targetAmount: 10000 })).data.goal; await call(T, 'POST', `/goals/${g.id}/contributions`, { amount: 2500 });
  await call(T, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 600, frequency: 'MONTHLY', startDate: m1(0), nextRenewalDate: last });
  await call(T, 'POST', '/recurring', { title: 'Gym', type: 'EXPENSE', amount: 100, category: 'Health', frequency: 'MONTHLY', startDate: m1(1) });

  // ---------- theme switching, persistence, no flash ----------
  { const { browser, page, errors } = await open(T, { hash: '/dashboard' }); await wait(1500);
    const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.classList.contains('dark'), localStorage.getItem('fintrack_theme')]);
    await page.evaluate(() => localStorage.setItem('fintrack_theme', 'light')); await page.reload({ waitUntil: 'networkidle0' }); await wait(800);
    eq('explicit light preference => light', (await theme()).slice(0, 2), ['light', false]);
    await page.click('[data-action="toggle-theme"]'); await wait(500);
    eq('toggle => dark, class + attribute + stored preference all set', await theme(), ['dark', true, 'dark']);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(800);
    eq('theme persists across a reload', (await theme()).slice(0, 2), ['dark', true]);
    eq('native controls follow the theme (color-scheme: dark)', await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
    await page.evaluate(() => { location.hash = '#/login-does-not-exist'; }); await wait(600);
    await page.click('[data-action="toggle-theme"]'); await wait(300);
    eq('toggle back => light and stored', (await theme()).slice(0, 3).join(), 'light,false,light');
    eq('no console errors while switching', errors, []);
    await browser.close(); }
  { // no flash: the saved theme is applied before first paint
    const { browser, page } = await open(T, { hash: '/dashboard' });
    await page.evaluate(() => localStorage.setItem('fintrack_theme', 'dark'));
    await page.evaluateOnNewDocument(() => { window.__first = null; const mo = new MutationObserver(() => { if (document.body && window.__first === null) { window.__first = { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor }; } }); mo.observe(document, { childList: true, subtree: true }); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const first = await page.evaluate(() => window.__first);
    const [r, g2, b] = (/\d+/g.exec ? first.body.match(/\d+/g) : []).map(Number);
    eq('first paint is already dark (no white flash): data-theme dark when the body appears, background dark', [first.theme, r < 60 && g2 < 60 && b < 60], ['dark', true]);
    await browser.close(); }
  { // OS preference when nothing is stored; explicit choice beats the OS
    const { browser, page } = await open(T, { hash: '/dashboard' });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.evaluate(() => localStorage.removeItem('fintrack_theme')); await page.reload({ waitUntil: 'networkidle0' }); await wait(600);
    const a = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.evaluate(() => localStorage.setItem('fintrack_theme', 'light')); await page.reload({ waitUntil: 'networkidle0' }); await wait(600);
    const b = await page.evaluate(() => document.documentElement.dataset.theme);
    eq('no stored preference + OS dark => dark; stored "light" overrides the OS', [a, b], ['dark', 'light']);
    await browser.close(); }
  { // login page honours the theme too
    const { browser, page } = await open(T, { hash: '/dashboard' });
    await page.evaluate(() => localStorage.setItem('fintrack_theme', 'dark'));
    await page.goto(page.url().replace(/fintrack_application\.html.*/, 'login.html'), { waitUntil: 'networkidle0' }).catch(() => {});
    await wait(500);
    eq('login page applies the saved dark theme as well', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await browser.close(); }

  // ---------- every page x theme x viewport ----------
  const problems = { contrast: [], unlabeled: [], dupIds: [], lightInDark: [], tiny: [], overflow: [], h1: [] };
  let pages = 0;
  for (const theme of ['light', 'dark']) {
    for (const vp of ['desktop', 'mobile']) {
      const { browser, page } = await open(T, { hash: '/dashboard', viewport: vp === 'mobile' ? 'mobile' : undefined });
      await page.evaluate((t) => localStorage.setItem('fintrack_theme', t), theme);
      await page.reload({ waitUntil: 'networkidle0' }); await wait(700);
      for (const r of routes) {
        await page.evaluate((x) => { location.hash = `#${x}`; }, r); await wait(1500);
        const res = await page.evaluate(inPage); pages += 1;
        const tag = `${theme}/${vp}${r}`;
        if (res.contrast.length) problems.contrast.push(`${tag}: ${res.contrast.slice(0, 2).map((c) => `${c.el} "${c.text}" ${c.ratio}`).join('; ')}`);
        if (res.unlabeled.length) problems.unlabeled.push(`${tag}: ${[...new Set(res.unlabeled)].slice(0, 3).join(', ')}`);
        if (res.dupIds.length) problems.dupIds.push(`${tag}: ${res.dupIds.join(',')}`);
        if (res.lightInDark.length) problems.lightInDark.push(`${tag}: ${[...new Set(res.lightInDark)].slice(0, 3).join(', ')}`);
        if (res.tiny.length) problems.tiny.push(`${tag}: ${[...new Set(res.tiny)].slice(0, 3).join(', ')}`);
        if (res.overflow > 1) problems.overflow.push(`${tag}: ${res.overflow}px`);
        if (res.h1s !== 1) problems.h1.push(`${tag}: ${res.h1s} h1`);
      }
      await browser.close();
    }
  }
  eq(`audited ${pages} page renders (${routes.length} pages x light/dark x desktop/mobile)`, pages, routes.length * 4);
  eq('WCAG AA text contrast on every page, both themes, both sizes', problems.contrast, []);
  eq('every control has an accessible name', problems.unlabeled, []);
  eq('no duplicate ids', problems.dupIds, []);
  eq('dark mode: no light-coloured panels or inputs anywhere', problems.lightInDark, []);
  eq('mobile: no touch target under 24 px', problems.tiny, []);
  eq('no horizontal overflow on any page', problems.overflow, []);
  eq('exactly one h1 per page (consistent page headings)', problems.h1, []);

  // ---------- dialogs, dropdowns, toasts, validation in dark ----------
  { const { browser, page } = await open(T, { hash: '/transactions' });
    await page.evaluate(() => localStorage.setItem('fintrack_theme', 'dark')); await page.reload({ waitUntil: 'networkidle0' }); await wait(1200);
    await page.$eval('[data-action="quick-add"]', (b) => b.click()); await wait(700);
    const modal = await page.evaluate(() => { const m = document.querySelector('.modal, [role="dialog"]'); if (!m) return null; const s = getComputedStyle(m); return { bg: s.backgroundColor, color: s.color }; });
    const lum = (c) => { const [r, g2, b] = c.match(/\d+/g).map(Number); return (r + g2 + b) / 3; };
    eq('dialog is dark with light text in dark mode', [modal && lum(modal.bg) < 70, modal && lum(modal.color) > 150], [true, true]);
    await page.keyboard.press('Escape'); await wait(400);
    await page.$eval('[data-action="quick-add"]', (b) => b.click()); await wait(500);
    const submit = await page.$('.modal button[type="submit"], [role="dialog"] button[type="submit"], .modal-footer .btn-primary'); if (submit) { await submit.evaluate((b) => b.click()); await wait(400); }
    const err = await page.evaluate(() => { const e = [...document.querySelectorAll('.field-error')].find((x) => x.textContent.trim() && !x.hidden); if (!e) return null; const s = getComputedStyle(e); const bg = getComputedStyle(e.closest('.modal, [role=dialog]') || document.body).backgroundColor; return { color: s.color, bg }; });
    eq('validation message is visible and readable in dark (not dark-on-dark)', [!!err, err ? lum(err.color) > 110 : false], [true, true]);
    await browser.close(); }

  // ---------- accessibility: keyboard, focus, motion ----------
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1500);
    await page.keyboard.press('Tab'); await wait(450); // the skip link slides in with a short transition
    const first = await page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { text: a.textContent.trim(), visible: r.width > 0 && r.height > 0 && r.top >= 0 }; });
    eq('first Tab stop is the skip link and it is visible when focused', [/skip/i.test(first.text), first.visible], [true, true]);
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const a = document.activeElement; const s = getComputedStyle(a); return { outline: parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none', shadow: s.boxShadow !== 'none' }; });
    eq('keyboard focus shows a visible focus indicator', ring.outline || ring.shadow, true);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => { location.hash = '#/budgets'; }); await wait(1200);
    const dur = await page.evaluate(() => { const el = document.querySelector('.page-enter') || document.getElementById('main'); return parseFloat(getComputedStyle(el).animationDuration) * (/ms/.test(getComputedStyle(el).animationDuration) ? 1 : 1000); });
    eq('prefers-reduced-motion: page animation is effectively off', dur <= 1, true);
    eq('html declares a language and the page has a labelled main landmark', await page.evaluate(() => [document.documentElement.lang, !!document.querySelector('main#main'), !!document.querySelector('nav[aria-label], aside nav, nav')]), ['en', true, true]);
    await browser.close(); }

  // ---------- dashboard alerts strip: real unread notifications only ----------
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(2500);
    const strip = await page.$eval('#db-alerts', (e) => ({ hidden: e.hidden, text: e.innerText }));
    eq('dashboard shows a "Needs your attention" strip with the real budget alert (Food nearly used up)', [strip.hidden, strip.text.includes('Needs your attention'), /Food/.test(strip.text)], [false, true, true]);
    await call(T, 'PATCH', '/notifications/read-all'); await page.reload({ waitUntil: 'networkidle0' }); await wait(2000);
    eq('after reading them the strip disappears (nothing invented, dashboard stays focused)', await page.$eval('#db-alerts', (e) => e.hidden), true);
    await browser.close(); }
  { const Zc = await register('ui18z'); const { browser, page } = await open(Zc, { hash: '/dashboard' }); await wait(2000);
    eq('a brand-new user sees no alerts strip', await page.$eval('#db-alerts', (e) => e.hidden), true);
    await browser.close(); }

  // ---------- mobile navigation ----------
  { const { browser, page } = await open(T, { hash: '/dashboard', viewport: 'mobile' }); await wait(1500);
    const hidden = await page.evaluate(() => { const s = document.querySelector('aside, .sidebar'); const r = s.getBoundingClientRect(); return r.right <= 1 || r.left < -50 || getComputedStyle(s).visibility === 'hidden'; });
    eq('phone: sidebar is off-canvas by default (content gets the full width)', hidden, true);
    await page.$eval('[data-action="open-nav"], [data-action="toggle-nav"], #nav-toggle, button[aria-controls]', (b) => b.click()).catch(() => {}); await wait(600);
    const open2 = await page.evaluate(() => document.documentElement.dataset.drawer === 'open' || document.querySelector('aside, .sidebar').getBoundingClientRect().left >= 0);
    eq('phone: the menu button opens the drawer', open2, true);
    await page.keyboard.press('Escape'); await wait(500);
    eq('phone: Escape closes the drawer', await page.evaluate(() => document.documentElement.dataset.drawer !== 'open'), true);
    await browser.close(); }

  srv.close && srv.close();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
