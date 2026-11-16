const { call, register, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const srv = await serve();
  const stamp = Date.now();
  const email = `login.${stamp}@test.dev`;
  await call(null, 'POST', '/auth/register', { name: 'Login User', email, password: 'secret123' });

  for (const vp of ['desktop', 'mobile']) {
    const { browser, page, errors } = await open(null, { noToken: true, viewport: vp }); await wait(1500);
    eq(`[${vp}] app without a session lands on the login page`, page.url().includes('login.html'), true);
    eq('login: title + one h1 + labelled fields', [await page.title(), (await page.$$('h1')).length, await page.$$eval('input', (i) => i.every((x) => document.querySelector(`label[for="${x.id}"]`)))], ['Sign in · FinTrack', 1, true]);
    eq('login: no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.click('#loginSubmit'); await wait(200);
    eq('login: empty submit => inline errors, focus on the first bad field', [(await page.$eval('#loginEmail-error', (e) => e.textContent)).length > 0, (await page.$eval('#loginPassword-error', (e) => e.textContent)).length > 0, await page.evaluate(() => document.activeElement.id)], [true, true, 'loginEmail']);
    await page.type('#loginEmail', email); await page.type('#loginPassword', 'wrong-password'); await page.click('#loginSubmit');
    await page.waitForFunction(() => { const e = document.querySelector('#authError'); const b = document.querySelector('#loginSubmit'); return e && e.textContent.trim() && b && !b.disabled; }, { timeout: 8000 }).catch(() => {}); // bcrypt takes a few hundred ms: wait for the outcome, not a fixed time
    eq('login: wrong password => server message in an alert, stays on the page, button usable again', [(await page.$eval('#authError', (e) => e.textContent)).length > 0, page.url().includes('login.html'), await page.$eval('#loginSubmit', (b) => !b.disabled)], [true, true, true]);
    await page.$eval('#loginPassword', (e) => { e.value = ''; }); await page.type('#loginPassword', 'secret123'); await page.click('#loginSubmit'); await wait(2000);
    eq('login: success => token stored and the app opens on the dashboard', [page.url().includes('fintrack_application.html'), await page.evaluate(() => !!localStorage.getItem('fintrack_token')), (await page.$eval('#page-title', (e) => e.textContent)).startsWith('Welcome back')], [true, true, true]);
    eq('login: no console errors (the deliberate 401 is expected)', errors.filter((e) => !/status of 401/.test(e)), []);
    await browser.close(); }

  { const { browser, page } = await open(null, { noToken: true }); await wait(1500);
    await page.click('#tab-register'); await wait(200);
    eq('register tab: panel switches, title changes', [await page.$eval('#registerForm', (f) => getComputedStyle(f).display !== 'none'), await page.$eval('#loginForm', (f) => getComputedStyle(f).display), await page.$eval('#auth-title', (e) => e.textContent)], [true, 'none', 'Create your account']);
    await page.type('#registerName', 'New Person'); await page.type('#registerEmail', 'bad-email'); await page.type('#registerPassword', '123'); await page.click('#registerSubmit'); await wait(200);
    eq('register: client validation (email, password length) is inline', [(await page.$eval('#registerEmail-error', (e) => e.textContent)).length > 0, (await page.$eval('#registerPassword-error', (e) => e.textContent)).includes('6')], [true, true]);
    await page.$eval('#registerEmail', (e) => { e.value = ''; }); await page.type('#registerEmail', `new.${stamp}@test.dev`);
    await page.$eval('#registerPassword', (e) => { e.value = ''; }); await page.type('#registerPassword', 'secret123'); await page.click('#registerSubmit'); await wait(2200);
    eq('register: creates the account and opens the app', page.url().includes('fintrack_application.html'), true);
    await browser.close(); }

  { const { browser, page } = await open('invalid.expired.token', { hash: '/dashboard' }); await wait(1800);
    eq('expired session => login page shows the expired notice', [page.url().includes('expired=1'), (await page.$eval('#notice', (e) => e.textContent)).includes('expired')], [true, true]);
    await browser.close(); }
  { const T = await register('login-already');
    const { browser, page } = await open(T, { hash: '/dashboard' }); await wait(1200);
    await page.goto('http://localhost:5600/login.html', { waitUntil: 'domcontentloaded' }); await wait(1500);
    eq('already signed in: login page forwards straight to the app', page.url().includes('fintrack_application.html'), true);
    await browser.close(); }
  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
