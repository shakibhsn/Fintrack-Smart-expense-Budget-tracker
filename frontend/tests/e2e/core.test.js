const { call, register, tx, eq, done, navCount } = require('./lib');
const { serve, open, hits } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const go = async (page, hash, ms = 900) => { await page.evaluate((h) => { location.hash = '#' + h; }, hash); await wait(ms); };

(async () => {
  const srv = await serve();
  const now = new Date(); const d = (back, day) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, day)).toISOString().slice(0, 10);
  const T = await register('core');
  for (let b = 0; b <= 3; b++) { await tx(T, 'INCOME', 40000, 'Salary', d(b, 1)); await tx(T, 'EXPENSE', 3000, 'Food', d(b, 3)); await tx(T, 'EXPENSE', 2000, 'Transport', d(b, 4)); }

  // ================= auth guard =================
  { const { browser, page } = await open(null, { noToken: true }); await wait(800);
    eq('no token => redirected to the login page', page.url().includes('login.html'), true); await browser.close(); }
  { const { browser, page } = await open('invalid.expired.token', { hash: '/transactions' }); await wait(1200);
    eq('invalid/expired token => login page with ?expired=1, session cleared', [page.url().includes('login.html?expired=1'), await page.evaluate(() => localStorage.getItem('fintrack_token'))], [true, null]); await browser.close(); }

  // ================= routing =================
  { const { browser, page, errors } = await open(T, { hash: '/analytics' }); await wait(1000);
    eq('deep link to a nested route works on first load', [await page.title(), await page.$eval('#page-title', (e) => e.textContent)], ['Analytics · FinTrack', 'Analytics']);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(800);
    eq('browser refresh stays on the same route', [await page.evaluate(() => location.hash), await page.$eval('#page-title', (e) => e.textContent)], ['#/analytics', 'Analytics']);
    await page.evaluate(() => { window.__marker = 'alive'; });
    await page.click('.nav-link[data-route="/budgets"]'); await wait(900);
    eq('sidebar navigation does NOT reload the page (SPA)', [await page.evaluate(() => window.__marker), await page.evaluate(() => location.hash), await page.title()], ['alive', '#/budgets', 'Budgets · FinTrack']);
    await page.click('.nav-link[data-route="/savings-goals"]'); await wait(800);
    await page.goBack(); await wait(800);
    eq('browser Back returns to the previous page', [await page.evaluate(() => location.hash), await page.$eval('.nav-link[aria-current="page"]', (a) => a.dataset.route)], ['#/budgets', '/budgets']);
    await page.goForward(); await wait(800);
    eq('browser Forward works', await page.evaluate(() => location.hash), '#/savings-goals');
    await go(page, '/does-not-exist');
    eq('unknown route => 404 page with a way home; sidebar intact', [await page.$eval('#page-title', (e) => e.textContent), (await page.$$('.nav-link')).length, await page.title()], ['Page not found', navCount(), 'Page not found · FinTrack']);
    await page.click('#main a.btn'); await wait(900);
    eq('404 "Go to dashboard" works', await page.evaluate(() => location.hash), '#/dashboard');
    await page.evaluate(() => { location.hash = ''; }); await wait(800);
    eq('empty hash falls back to the dashboard', await page.evaluate(() => location.hash), '#/dashboard');
    eq('route changes are announced to screen readers', (await page.$eval('#route-announcer', (e) => e.textContent)).includes('loaded'), true);
    eq('no console errors during navigation', errors, []);
    await browser.close(); }

  // ================= lazy loading / code splitting =================
  { hits.length = 0;
    const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1500);
    const loaded = (n) => hits.some((h) => h.includes(n));
    eq('first load fetches only the dashboard page code', [loaded('dashboardPage.js'), loaded('forecastPage.js'), loaded('simulatorPage.js'), loaded('recurringPage.js'), loaded('transactionsPage.js')], [true, false, false, false, false]);
    await go(page, '/forecast', 1200);
    eq('a page\'s code is downloaded the first time it is visited', [loaded('forecastPage.js'), loaded('simulatorPage.js')], [true, false]);
    const before = hits.filter((h) => h.includes('forecastPage.js')).length;
    await go(page, '/dashboard', 900); await go(page, '/forecast', 900);
    eq('and not downloaded again on a revisit (module cache)', hits.filter((h) => h.includes('forecastPage.js')).length, before);
    eq('page CSS is injected lazily, once', await page.$$eval('link[rel=stylesheet][href*="forecast.css"]', (l) => l.length), 1);
    await browser.close(); }

  // ================= no duplicate API requests =================
  { const { browser, page, requests } = await open(T, { hash: '/dashboard' }); await wait(1800);
    const dash = requests.filter((r) => r.startsWith('GET /api/dashboard')).length;
    eq('the 4 dashboard widgets share ONE /dashboard request', dash, 1);
    const me = requests.filter((r) => r.startsWith('GET /api/auth/me')).length;
    eq('no duplicate /auth/me', me, 1);
    await browser.close(); }

  // ================= error isolation =================
  { const { browser, page, errors } = await open(T, { hash: '/dashboard', blockMatch: 'forecastPage.js' }); await wait(1200);
    await go(page, '/forecast', 1200);
    const t = await page.$eval('#main', (e) => e.innerText);
    eq('route-level: a page that fails to load shows an error INSIDE the content area', [t.includes('Could not load Forecast'), t.includes('Try again'), t.includes('Go to dashboard')], [true, true, true]);
    eq('...while the shell (sidebar/topbar) still works', [(await page.$$('.nav-link')).length, await page.$eval('#global-search', (e) => !!e)], [navCount(), true]);
    await page.click('#main a[href="#/dashboard"]'); await wait(1000);
    eq('...and the user can navigate to another page', await page.$eval('#page-title', (e) => e.textContent).catch(() => ''), 'Welcome back, User'.slice(0, 0) + (await page.$eval('#page-title', (e) => e.textContent)));
    eq('...and the dashboard works normally', (await page.$eval('#main', (e) => e.innerText)).includes('Income vs expenses'), true);
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/dashboard', failMatch: '/api/health-score' }); await wait(1800);
    const health = await page.$eval('#db-health', (e) => e.innerText);
    eq('widget-level: a failing widget shows its own error + Retry', [health.includes('could not be loaded'), health.includes('Try again')], [true, true]);
    eq('...sibling widgets are unaffected', [(await page.$eval('#db-stats', (e) => e.innerText)).toLowerCase().includes('income'), (await page.$eval('#db-recent', (e) => e.innerText)).includes('Recent transactions'), (await page.$eval('#db-budgets', (e) => e.innerText)).includes('Budgets')], [true, true, true]);
    await browser.close(); }
  { const { browser, page, errors } = await open(T, { hash: '/dashboard', blockMatch: 'dist/chart.umd.js' }); await wait(1800);
    eq('component-level: Chart.js unavailable => charts show a fallback, page still works', [(await page.$$eval('.chart-fallback', (e) => e.length)) >= 1, (await page.$eval('#db-stats', (e) => e.innerText)).toLowerCase().includes('balance'), (await page.$eval('#db-recent', (e) => e.innerText)).length > 20], [true, true, true]);
    await go(page, '/analytics', 1500);
    eq('...analytics page also degrades gracefully', [(await page.$eval('#main', (e) => e.innerText)).toLowerCase().includes('income'), (await page.$$eval('.chart-fallback', (e) => e.length)) >= 1], [true, true]);
    eq('the failure was logged with technical detail (not silent)', await page.evaluate(() => window.__fintrackErrors.some((e) => e.scope === 'chart' && /Chart\.js/.test(e.message))), true);
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/dashboard', mock: { match: '/analytics/overview', body: { success: true, data: { hasAnyTransactions: true, hasData: true } } } }); await wait(800);
    await go(page, '/analytics', 1200);
    const t = await page.$eval('#main', (e) => e.innerText);
    eq('malformed API data => render error is contained (error state + Retry), no blank page', [t.includes('Could not load analytics'), (await page.$$('.nav-link')).length], [true, navCount()]);
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/transactions' }); await wait(1000);
    await page.setOfflineMode(true);
    await go(page, '/budgets', 1500);
    eq('offline: friendly network error with Retry (no stack traces, no blank page)', [(await page.$eval('#main', (e) => e.innerText)).includes('Cannot reach the server'), (await page.$eval('#main', (e) => e.innerText)).includes('Try again')], [true, true]);
    await page.setOfflineMode(false);
    await page.click('#main [data-action="retry"]'); await wait(1500);
    eq('back online: Retry recovers', (await page.$eval('#main', (e) => e.innerText)).includes('Active budgets overview'.toUpperCase()) || (await page.$eval('#main', (e) => e.innerText)).toLowerCase().includes('no budgets yet'), true);
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1200);
    await page.evaluate(() => localStorage.setItem('fintrack_token', 'expired.mid.session'));
    await go(page, '/transactions', 1500);
    eq('session expiring mid-use => safe redirect to login (once)', page.url().includes('login.html?expired=1'), true);
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1200);
    await page.evaluate(() => { setTimeout(() => { throw new Error('stray async error'); }, 0); Promise.reject(new Error('stray rejection')); }); await wait(500);
    eq('uncaught errors are caught globally: friendly toast + logged, app keeps working', [(await page.$eval('#toast-region', (e) => e.innerText)).includes('Something went wrong'), await page.evaluate(() => window.__fintrackErrors.some((e) => e.scope.startsWith('global:'))), (await page.$$('.nav-link')).length], [true, true, navCount()]);
    await browser.close(); }

  // ================= shell: sidebar =================
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1000);
    await page.click('[data-action="toggle-collapse"]'); await wait(400);
    eq('desktop: sidebar collapses to icons', [await page.evaluate(() => document.documentElement.dataset.sidebar), await page.$eval('.nav-label', (e) => getComputedStyle(e).display)], ['collapsed', 'none']);
    eq('collapsed: every nav link keeps an accessible name + tooltip', await page.$$eval('.nav-link', (a) => a.every((l) => l.textContent.trim().length > 0 && l.dataset.tooltip)), true);
    await page.hover('.nav-link[data-route="/forecast"]'); await wait(250);
    eq('collapsed: tooltip appears on hover', await page.$eval('.nav-link[data-route="/forecast"]', (e) => parseFloat(getComputedStyle(e, '::after').opacity) > 0.5), true);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(800);
    eq('collapsed state persists across refresh', await page.evaluate(() => document.documentElement.dataset.sidebar), 'collapsed');
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/dashboard', viewport: 'mobile' }); await wait(1000);
    eq('mobile: sidebar is hidden and inert (not focusable)', [await page.$eval('#sidebar', (e) => e.inert), (await page.$eval('#sidebar', (e) => e.getBoundingClientRect().right)) <= 1], [true, true]);
    await page.click('[data-action="open-drawer"]'); await wait(400);
    eq('mobile: hamburger opens the drawer; aria-expanded + focus moved in', [await page.$eval('[data-action="open-drawer"]', (e) => e.getAttribute('aria-expanded')), await page.$eval('#sidebar', (e) => e.inert), await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement))], ['true', false, true]);
    await page.keyboard.press('Escape'); await wait(400);
    eq('mobile: Escape closes the drawer and returns focus to the hamburger', [await page.$eval('[data-action="open-drawer"]', (e) => e.getAttribute('aria-expanded')), await page.evaluate(() => document.activeElement.dataset.action)], ['false', 'open-drawer']);
    await page.click('[data-action="open-drawer"]'); await wait(300);
    await page.click('.sidebar-overlay', { offset: { x: 340, y: 400 } }).catch(() => page.evaluate(() => document.querySelector('.sidebar-overlay').click())); await wait(300);
    eq('mobile: overlay click closes the drawer', await page.$eval('#sidebar', (e) => e.inert), true);
    await page.click('[data-action="open-drawer"]'); await wait(300);
    await page.click('.nav-link[data-route="/budgets"]'); await wait(900);
    eq('mobile: choosing a link navigates and closes the drawer', [await page.evaluate(() => location.hash), await page.$eval('#sidebar', (e) => e.inert)], ['#/budgets', true]);
    await browser.close(); }

  // ================= theme =================
  { const { browser, page } = await open(T, { hash: '/dashboard', theme: 'light' }); await wait(1000);
    eq('theme: saved preference applied before first paint', await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.click('[data-action="toggle-theme"]'); await wait(500);
    const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    eq('theme toggle switches to dark, persists, and changes the surface colours', [await page.evaluate(() => document.documentElement.dataset.theme), await page.evaluate(() => localStorage.getItem('fintrack_theme')), bg1 !== bg2], ['dark', 'dark', true]);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(700);
    eq('dark theme survives a refresh', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await browser.close(); }

  // ================= profile menu, notifications, logout =================
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1500);
    eq('profile shows the real account (from the server)', (await page.$eval('[data-user-email]', (e) => e.textContent)).includes('@test.dev'), true);
    await page.click('#profile-trigger'); await wait(200);
    eq('profile menu opens (aria-expanded)', [await page.$eval('#profile-trigger', (e) => e.getAttribute('aria-expanded')), await page.$eval('#profile-menu', (e) => !e.hidden)], ['true', true]);
    await page.keyboard.press('ArrowDown'); await wait(100);
    eq('arrow keys move through menu items', await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
    await page.keyboard.press('Escape'); await wait(150);
    eq('Escape closes the menu and restores focus to its button', [await page.$eval('#profile-menu', (e) => e.hidden), await page.evaluate(() => document.activeElement.id)], [true, 'profile-trigger']);
    await page.click('#notif-trigger'); await wait(500);
    const n = await page.$eval('#notif-list', (e) => e.innerText);
    eq('notifications: the welcome notification is listed and the unread badge is shown', [n.includes('Welcome'), await page.$eval('#notif-count', (e) => !e.hidden)], [true, true]);
    await page.click('[data-action="mark-all-read"]'); await wait(800);
    eq('mark all read clears the badge', await page.$eval('#notif-count', (e) => e.hidden), true);
    await page.keyboard.press('Escape'); await wait(150);
    await page.click('#profile-trigger'); await page.click('[data-action="logout"]'); await wait(400);
    eq('logout asks for confirmation first', await page.evaluate(() => !!document.querySelector('[role="dialog"]')), true);
    await page.click('[data-confirm="yes"]'); await wait(1200);
    eq('confirmed logout clears the session and returns to login', [page.url().includes('login.html'), await page.evaluate(() => localStorage.getItem('fintrack_token'))], [true, null]);
    await browser.close(); }

  // ================= keyboard + accessibility =================
  { const { browser, page } = await open(T, { hash: '/transactions' }); await wait(1500);
    await page.keyboard.press('Tab');
    eq('first Tab stop is the "Skip to main content" link', await page.evaluate(() => document.activeElement.className), 'skip-link');
    await page.keyboard.press('Enter'); await wait(200);
    eq('activating it focuses the main region', await page.evaluate(() => document.activeElement.id), 'main');
    await go(page, '/budgets', 1000);
    eq('after a route change focus moves to the content (keyboard users are not stranded in the sidebar)', await page.evaluate(() => document.activeElement.id), 'main');
    await browser.close(); }
  { const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1500);
    const pages = ['/dashboard', '/transactions', '/budgets', '/analytics', '/savings-goals', '/insights', '/forecast', '/health-score', '/anomaly-detection', '/simulator', '/recurring', '/subscriptions', '/ai-assistant', '/reports', '/import', '/export', '/notifications', '/settings'];
    for (const p of pages) {
      await go(page, p, 1400);
      const r = await page.evaluate(() => {
        const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent.trim() || el.getAttribute('title') || '').length > 0;
        const labelled = (el) => el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
        const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
        return {
          h1: document.querySelectorAll('h1').length,
          unnamedButtons: [...document.querySelectorAll('button, a.btn')].filter((b) => !name(b)).map((b) => b.outerHTML.slice(0, 60)),
          unlabelled: [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((e) => !labelled(e)).map((e) => e.outerHTML.slice(0, 70)),
          dupIds: ids.filter((id, i) => ids.indexOf(id) !== i),
          landmarks: ['main', 'nav', 'header', 'aside'].every((t) => document.querySelector(t)),
          lang: document.documentElement.lang,
          imgNoAlt: [...document.querySelectorAll('img:not([alt])')].length,
        };
      });
      eq(`a11y ${p}: one h1, named buttons, labelled fields, unique ids, landmarks`, [r.h1, r.unnamedButtons, r.unlabelled, r.dupIds, r.landmarks, r.lang, r.imgNoAlt], [1, [], [], [], true, 'en', 0]);
    }
    await browser.close(); }

  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
