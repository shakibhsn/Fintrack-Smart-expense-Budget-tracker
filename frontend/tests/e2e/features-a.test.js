const { call, register, tx, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setv = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(v));
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText);

(async () => {
  const srv = await serve();
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth(); const dd = now.getUTCDate();
  const d = (back, day) => new Date(Date.UTC(y, m - back, day)).toISOString().slice(0, 10);
  const today = d(0, dd); const monthStart = d(0, 1); const monthEnd = d(-1, 0);

  // ==================================================== BUDGETS
  const B0 = await register('fa-b0');
  { const { browser, page, errors } = await open(B0, { hash: '/budgets' }); await wait(1000);
    eq('budgets: empty state with a create action', (await txt(page, '#main')).includes('No budgets yet'), true);
    await page.click('#main [data-action="add"]'); await wait(300);
    await page.click('#bg-submit'); await wait(200);
    eq('budgets form: empty limit => inline error + focus', [(await txt(page, '#bg-limit-error')).length > 0, await page.evaluate(() => document.activeElement.id)], [true, 'bg-limit']);
    await setv(page, '#bg-limit', '1000'); await setv(page, '#bg-start', monthEnd); await setv(page, '#bg-end', monthStart);
    await page.click('#bg-submit'); await wait(200);
    eq('budgets form: end before start => inline error, nothing sent', [(await txt(page, '#bg-end-error')).includes('on or after'), (await call(B0, 'GET', '/budgets')).data.budgets.length], [true, 0]);
    await setv(page, '#bg-start', monthStart); await setv(page, '#bg-end', monthEnd); await page.select('#bg-category', 'Food');
    await page.click('#bg-submit'); await wait(1200);
    eq('budgets: created via the form, card shown with tier text + status', await page.evaluate(() => { const c = document.querySelector('article'); return !!c && /Food/.test(c.innerText) && /0% used · Healthy/.test(c.innerText) && /Active/.test(c.innerText); }), true);
    await page.click('#main [data-action="add"]'); await wait(300);
    await page.select('#bg-category', 'Food'); await setv(page, '#bg-limit', '500'); await page.click('#bg-submit'); await wait(900);
    eq('budgets: overlapping budget => server message shown inside the dialog (dialog stays open)', [(await txt(page, '#bg-form-error')).length > 0, await page.evaluate(() => !!document.querySelector('[role=dialog]'))], [true, true]);
    await page.keyboard.press('Escape'); await wait(200);
    // tiers from real spending
    await tx(B0, 'EXPENSE', 750, 'Food', today); await page.evaluate(() => { location.hash = '#/dashboard'; }); await wait(500); await page.evaluate(() => { location.hash = '#/budgets'; }); await wait(1000);
    eq('budgets: 75% => Warning tier (text, not just colour)', (await txt(page, 'article')).includes('75% used · Warning'), true);
    await tx(B0, 'EXPENSE', 200, 'Food', today); await page.evaluate(() => { location.hash = '#/budgets?x=1'; }); await wait(1000);
    eq('budgets: 95% => Critical', (await txt(page, 'article')).includes('95% used · Critical'), true);
    await tx(B0, 'EXPENSE', 300, 'Food', today); await page.evaluate(() => { location.hash = '#/budgets?x=2'; }); await wait(1000);
    eq('budgets: 125% => Over budget with the overshoot amount', [(await txt(page, 'article')).includes('Over budget'), (await txt(page, 'article')).includes('Over by ৳250')], [true, true]);
    await page.click('[data-action="edit"]'); await wait(300);
    eq('budgets: edit dialog prefilled', await page.$eval('#bg-limit', (e) => e.value), '1000');
    await setv(page, '#bg-limit', '5000'); await page.click('#bg-submit'); await wait(1200);
    eq('budgets: edit saved (back to Healthy at 25%)', (await txt(page, 'article')).includes('25% used · Healthy'), true);
    await page.click('[data-action="delete"]'); await wait(300);
    eq('budgets: delete confirm says transactions are not affected', (await txt(page, '[role=dialog]')).includes('Your transactions are not affected'), true);
    await page.click('[data-confirm="yes"]'); await wait(1200);
    eq('budgets: deleted, transactions untouched', [(await call(B0, 'GET', '/budgets')).data.budgets.length, (await call(B0, 'GET', '/transactions?limit=1')).data.pagination.total], [0, 3]);
    eq('budgets: no console errors (the deliberate 409 is expected)', errors.filter((e) => !/status of 409/.test(e)), []); await browser.close(); }

  // ==================================================== SAVINGS GOALS
  const G0 = await register('fa-g0');
  { const { browser, page, errors } = await open(G0, { hash: '/savings-goals' }); await wait(1000);
    eq('goals: empty state', (await txt(page, '#main')).includes('No savings goals yet'), true);
    await page.click('#main [data-action="add"]'); await wait(300);
    await page.click('button[form="gf-form"]'); await wait(200);
    eq('goals form: name + target required (inline)', [(await txt(page, '#gf-title-error')).length > 0, (await txt(page, '#gf-target-error')).length > 0], [true, true]);
    await page.type('#gf-title', 'Trip to Cox'); await setv(page, '#gf-target', '1000'); await setv(page, '#gf-saved', '2000');
    await page.click('button[form="gf-form"]'); await wait(200);
    eq('goals form: already-saved > target is rejected inline', (await txt(page, '#gf-saved-error')).includes('more than the target'), true);
    eq('goals form: target date cannot be in the past (min >= the UTC today used by the server)', (await page.$eval('#gf-date', (e) => e.min)) >= today, true);
    await setv(page, '#gf-saved', '250'); await page.select('#gf-icon', 'fa-plane');
    await page.click('button[form="gf-form"]'); await wait(1300);
    const card = await txt(page, 'article');
    eq('goals: created; shows saved/target/progress/status', [card.includes('Trip to Cox'), card.includes('৳250 saved'), card.includes('25%'), card.includes('In progress'), card.includes('Remaining: ৳750')], [true, true, true, true, true]);
    eq('goals: summary cards from real totals', /TOTAL SAVED[\s\S]*৳250/i.test(await txt(page, '#goal-summary')), true);
    await page.click('[data-action="contribute"]'); await wait(300);
    eq('contribution dialog: date capped at today, labelled', [await page.$eval('#gc-date', (e) => e.max), (await txt(page, '[role=dialog]')).includes('Trip to Cox')], [today, true]);
    await page.click('button[form="gc-form"]'); await wait(200);
    eq('contribution: amount required (inline)', (await txt(page, '#gc-amount-error')).length > 0, true);
    await setv(page, '#gc-amount', '500'); await page.type('#gc-note', 'Bonus'); await page.click('button[form="gc-form"]'); await wait(1300);
    eq('contribution: progress updates to 75%', (await txt(page, 'article')).includes('৳750 saved') && (await txt(page, 'article')).includes('75%'), true);
    await page.click('[data-action="history"]'); await wait(700);
    const h = await txt(page, '[role=dialog]');
    eq('history lists the starting balance and the contribution', [h.includes('+৳250'), h.includes('+৳500'), h.includes('Bonus')], [true, true, true]);
    await page.keyboard.press('Escape'); await wait(200);
    await page.click('[data-action="contribute"]'); await wait(300); await setv(page, '#gc-amount', '600'); await page.click('button[form="gc-form"]'); await wait(1300);
    const c2 = await txt(page, 'article');
    eq('completed goal: Completed status + amount above target (bar capped)', [c2.includes('Completed'), c2.includes('above target'), await page.$eval('article [role=progressbar]', (e) => e.getAttribute('aria-valuenow'))], [true, true, '100']);
    await page.click('[data-action="edit"]'); await wait(300);
    eq('edit goal: no starting-balance field (saved money changes only via contributions)', (await page.$$('#gf-saved')).length, 0);
    await page.keyboard.press('Escape'); await wait(200);
    await page.click('[data-action="delete"]'); await wait(300);
    eq('delete goal: confirm mentions its contributions', (await txt(page, '[role=dialog]')).includes('contribution'), true);
    await page.click('[data-confirm="yes"]'); await wait(1200);
    eq('goal deleted', (await call(G0, 'GET', '/goals')).data.goals.length, 0);
    eq('goals: no console errors', errors, []); await browser.close(); }

  // ==================================================== ANALYTICS
  const A0 = await register('fa-a0');
  { const { browser, page } = await open(A0, { hash: '/analytics' }); await wait(1000);
    eq('analytics: brand-new user => honest empty state', (await txt(page, '#main')).includes('No analytics yet'), true); await browser.close(); }
  const A = await register('fa-a');
  for (let b = 0; b <= 3; b++) { await tx(A, 'INCOME', 40000, 'Salary', d(b, 1)); await tx(A, 'EXPENSE', 3000 + b * 100, 'Food', d(b, 2)); await tx(A, 'EXPENSE', 2000, 'Transport', d(b, 3)); }
  { const { browser, page, errors } = await open(A, { hash: '/analytics' }); await wait(1500);
    const t = await txt(page, '#main');
    eq('analytics: summary cards + range note', [/INCOME\s*৳40,000/i.test(t), /EXPENSES\s*৳/i.test(t), t.includes('This Month:')], [true, true, true]);
    eq('analytics: comparison with the previous period is shown', t.includes('Compared with the previous period'), true);
    eq('analytics: 5 charts drawn, each with an accessible description', [await page.$$eval('canvas', (c) => c.length), await page.$$eval('canvas', (c) => c.every((x) => x.getAttribute('aria-label')))], [5, true]);
    await page.select('#an-period', 'last_6_months'); await wait(1300);
    eq('analytics: period change reloads with the new label', (await txt(page, '#main')).includes('Last 6 Months'), true);
    await page.select('#an-period', 'custom'); await wait(300);
    await setv(page, '#an-start', d(0, 5)); await setv(page, '#an-end', d(0, 2));
    await page.click('[data-action="apply"]'); await wait(300);
    eq('analytics: custom range with end < start => inline message, no request', (await txt(page, '#an-custom-error')).includes('on or after'), true);
    await setv(page, '#an-start', d(1, 1)); await setv(page, '#an-end', today); await page.click('[data-action="apply"]'); await wait(1300);
    eq('analytics: valid custom range works', (await txt(page, '#main')).includes('Custom Range'), true);
    await page.select('#an-period', 'last_month'); await wait(1200);
    eq('analytics: charts are destroyed/recreated on change (still exactly 5 canvases)', await page.$$eval('canvas', (c) => c.length), 5);
    eq('analytics: no console errors', errors, []); await browser.close(); }
  { // zero income: savings rate is N/A, never a made-up number
    const Z = await register('fa-zero');
    await tx(Z, 'EXPENSE', 500, 'Food', today); await tx(Z, 'EXPENSE', 300, 'Transport', today);
    const { browser, page } = await open(Z, { hash: '/analytics' }); await wait(1500);
    const t = await txt(page, '#main');
    eq('analytics: zero income => Savings rate N/A + explanation; negative savings shown', [t.includes('N/A'), t.includes('No income in this period'), /SAVINGS\s*-৳800/i.test(t)], [true, true, true]); await browser.close(); }

  srv.close(); done();
})().catch((e) => { console.error(e); process.exit(1); });
