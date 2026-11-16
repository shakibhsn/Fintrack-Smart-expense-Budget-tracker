const path = require('path');
const { call, register, eq, done } = require('./lib');
const { startSink, decode } = require(path.join(__dirname, '../../../backend/tests/api/smtpSink'));
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText);
const noToast = (page) => page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 9000 });

(async () => {
  const sink = await startSink(2525); // the test backend is configured to send its e-mail here
  const srv = await serve();
  const now = new Date(); const dd = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10);

  // ---- empty: only the welcome message at most; honest state, no fake alerts ----
  const Z = await register('ncui-z');
  { const { browser, page, errors } = await open(Z, { hash: '/notifications' }); await wait(1500);
    const items = await page.$$eval('.nc-item', (e) => e.map((x) => x.innerText));
    eq('new user: no budget/goal/subscription alerts invented', items.some((t) => /Budget|Goal|Subscription|Unusual/.test(t)), false);
    eq('empty: no console errors', errors, []);
    await browser.close(); }

  for (const vp of ['desktop', 'mobile']) {
    const T = await register('ncui-' + vp);
    // real events create real notifications
    await call(T, 'POST', '/budgets', { category: 'Food', limit: 1000, startDate: dd(-5), endDate: dd(25) });
    await call(T, 'POST', '/transactions', { type: 'EXPENSE', amount: 750, category: 'Food', description: 'groceries', date: dd(0) });
    const g = (await call(T, 'POST', '/goals', { title: 'Laptop', targetAmount: 1000 })).data.goal;
    await call(T, 'POST', `/goals/${g.id}/contributions`, { amount: 300 });
    await call(T, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 500, frequency: 'MONTHLY', startDate: dd(-20), nextRenewalDate: dd(2) });

    const { browser, page, errors } = await open(T, { hash: '/notifications', viewport: vp }); await wait(1800);
    const titles = () => page.$$eval('.nc-item .nc-title', (e) => e.map((x) => x.textContent.replace('(unread)', '').trim()));
    let t = await titles();
    eq(`[${vp}] shows budget, goal and subscription notifications`, [t.some((x) => x.startsWith('Budget at 70%')), t.some((x) => x.startsWith('Goal created')), t.some((x) => x.startsWith('25% of your goal')), t.some((x) => x.startsWith('Upcoming renewal'))], [true, true, true, true]);
    eq('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    const navBadge = async () => page.$eval('[data-badge="notifications"]', (b) => (b.hidden ? '' : b.textContent.trim()));
    const unread0 = (await call(T, 'GET', '/notifications/unread-count')).data.unreadCount;
    eq('sidebar badge = unread count', await navBadge(), unread0 > 9 ? '9+' : String(unread0));

    // category filter
    await page.click('[data-chip="category"][data-value="BUDGET"]'); await wait(900);
    t = await titles();
    eq('category filter: only budget', [t.length > 0, t.every((x) => /Budget/.test(x))], [true, true]);
    await page.click('[data-chip="category"][data-value=""]'); await wait(700);

    // mark one read -> unread tab loses it, read tab has it
    const firstId = await page.$eval('.nc-item', (e) => e.dataset.id);
    await page.click(`.nc-item[data-id="${firstId}"] [data-action="read"]`); await wait(900);
    await page.click('[data-chip="status"][data-value="read"]'); await wait(900);
    eq('Read tab has the item', (await page.$$eval('.nc-item', (e) => e.map((x) => x.dataset.id))).includes(firstId), true);
    await page.click(`.nc-item[data-id="${firstId}"] [data-action="unread"]`); await wait(900);
    eq('mark unread removes it from Read', (await page.$$eval('.nc-item', (e) => e.map((x) => x.dataset.id))).includes(firstId), false);
    await page.click('[data-chip="status"][data-value="unread"]'); await wait(900);
    eq('Unread tab contains it again, API agrees', [(await page.$$eval('.nc-item', (e) => e.map((x) => x.dataset.id))).includes(firstId), (await call(T, 'GET', '/notifications?status=unread')).data.notifications.some((n) => n.id === firstId)], [true, true]);

    // delete (the request must really remove it)
    const before = (await call(T, 'GET', '/notifications?limit=100')).data.notifications.length;
    await page.click(`.nc-item[data-id="${firstId}"] [data-action="delete"]`); await wait(1000);
    eq('delete removes it for real', [(await call(T, 'GET', '/notifications?limit=100')).data.notifications.length, (await page.$$eval('.nc-item', (e) => e.map((x) => x.dataset.id))).includes(firstId)], [before - 1, false]);
    await noToast(page);

    // related link navigates + marks read
    await page.click('[data-chip="status"][data-value="all"]'); await wait(800);
    const linkInfo = await page.$eval('[data-open]', (a) => ({ href: a.getAttribute('href'), id: a.dataset.open }));
    await page.click(`[data-open="${linkInfo.id}"]`); await wait(1200);
    eq('related link opens the target page and marks it read', [await page.evaluate(() => location.hash), (await call(T, 'GET', '/notifications?limit=100')).data.notifications.find((n) => n.id === linkInfo.id).isRead], [linkInfo.href, true]);
    await page.evaluate(() => { location.hash = '#/notifications'; }); await wait(1200);

    // preferences: switch Goals off -> new goal creates nothing; persisted after reload
    await page.click('[data-pref="goals"]'); await wait(700);
    eq('preference saved on the server', (await call(T, 'GET', '/notifications/preferences')).data.preferences.goals, false);
    const n0 = (await call(T, 'GET', '/notifications?limit=100')).data.notifications.length;
    await call(T, 'POST', '/goals', { title: 'Silent goal', targetAmount: 50 });
    eq('category off => nothing created', (await call(T, 'GET', '/notifications?limit=100')).data.notifications.length, n0);
    await page.reload({ waitUntil: 'networkidle0' }); await wait(1500);
    eq('preference still off after reload', await page.$eval('[data-pref="goals"]', (c) => c.checked), false);
    await page.$eval('#nc-days', (el) => { el.value = '99'; el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(700);
    eq('invalid reminder days rejected (server value unchanged)', (await call(T, 'GET', '/notifications/preferences')).data.preferences.renewalReminderDays, 3);
    await page.$eval('#nc-days', (el) => { el.value = '5'; el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(700);
    eq('reminder days saved', (await call(T, 'GET', '/notifications/preferences')).data.preferences.renewalReminderDays, 5);

    // e-mail section (desktop run): the server is configured, the user starts opted out, switching on really sends mail
    if (vp === 'desktop') {
      const sec = await txt(page, '#nc-prefs');
      eq('e-mail section: available, masked address shown, starts OFF, honest wording about delivery', [sec.includes('E-mail'), /\*+@/.test(sec), await page.$eval('[data-pref="emailEnabled"]', (c) => c.checked), sec.includes('cannot guarantee inbox delivery')], [true, true, false, true]);
      await page.click('[data-pref="emailEnabled"]'); await wait(900);
      eq('opt-in saved on the server', (await call(T, 'GET', '/notifications/preferences')).data.preferences.emailEnabled, true);
      await call(T, 'PUT', '/notifications/preferences', { goals: true }); // earlier in this test the Goals category was switched off on purpose
      await call(T, 'POST', '/goals', { title: 'Emailed goal', targetAmount: 100 });
      for (let i = 0; i < 50 && !sink.messages.some((m) => /Emailed goal/.test(decode(m.raw))); i += 1) await wait(100);
      eq('creating the goal sent exactly one mail through the SMTP server', sink.messages.filter((m) => /Emailed goal/.test(decode(m.raw))).length, 1);
      await page.reload({ waitUntil: 'networkidle0' }); await wait(1800);
      eq('the notification shows an "E-mail sent" badge (and the checkbox is still on)', [(await txt(page, '#nc-body')).includes('E-mail sent'), await page.$eval('[data-pref="emailEnabled"]', (c) => c.checked)], [true, true]);
      const n0 = sink.messages.length;
      await noToast(page); await page.$eval('[data-action="test-email"]', (b) => b.click()); await wait(1500);
      eq('test e-mail button sends one real message and says so', [sink.messages.length - n0, (await txt(page, '#toast-region')).includes('Test e-mail handed to the mail server')], [1, true]);
      await noToast(page);
      await call(T, 'PUT', '/notifications/preferences', { emailEnabled: false });
    }

    // mark all read -> badge disappears
    await page.click('[data-action="read-all"]'); await wait(1200);
    eq('mark all read: server unread 0, sidebar badge hidden, no unread rows', [(await call(T, 'GET', '/notifications/unread-count')).data.unreadCount, await navBadge(), (await page.$$('.nc-item[data-unread="true"]')).length], [0, '', 0]);

    // bell shows the same data + link to the page
    await page.click('#notif-trigger'); await wait(500);
    eq('bell dropdown lists notifications and links to the page', [(await page.$$('#notif-list [data-notif]')).length > 0, await page.$eval('[data-notif-all]', (a) => a.getAttribute('href'))], [true, '#/notifications']);
    eq('no console errors', errors, []);
    await browser.close();
  }
  await sink.close();
  srv.close && srv.close();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
