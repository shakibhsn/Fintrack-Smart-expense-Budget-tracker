const fs = require('fs');
const os = require('os');
const path = require('path');
const { call, register, eq, done } = require('./lib');
const { serve, open } = require('./harness');
const ExcelJS = require(path.join(__dirname, '../../../backend/node_modules/exceljs'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText);
const noToast = (page) => page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 9000 });
const setv = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(v));
const tmp = (name, content) => { const p = path.join(os.tmpdir(), `fintrack-e2e-${Date.now()}-${name}`); fs.writeFileSync(p, content); return p; };
const count = async (T) => (await call(T, 'GET', '/transactions?limit=500')).data.pagination?.total ?? (await call(T, 'GET', '/transactions?limit=500')).data.transactions.length;

// Replaces the anchor click so a "download" can be observed without a file dialog (the helper still fetches with the real token).
const spyDownloads = (page) => page.evaluate(() => { window.__dl = []; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push({ name: this.download, blob: this.href.startsWith('blob:') }); }; });

(async () => {
  const srv = await serve();
  const now = new Date(); const dd = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10);

  for (const vp of ['desktop', 'mobile']) {
    const T = await register('ieui-' + vp);
    await call(T, 'POST', '/transactions', { type: 'EXPENSE', amount: 500, category: 'Food', description: 'Existing lunch', date: dd(-3) });
    const { browser, page, errors } = await open(T, { hash: '/import', viewport: vp }); await wait(1800);
    await spyDownloads(page);
    eq(`[${vp}] import page: rules, template button, empty history`, [(await txt(page, '#main')).includes('YYYY-MM-DD'), (await page.$$('[data-action="template"]')).length, (await txt(page, '#imp-history')).includes('No imports yet')], [true, 1, true]);
    eq('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);

    await page.click('[data-action="template"]'); await wait(800);
    eq('template downloads as a real csv file', await page.evaluate(() => window.__dl.map((d) => d.name)), ['fintrack-import-template.csv']);

    // wrong files rejected before upload
    const input = await page.$('#imp-file');
    await input.uploadFile(tmp('notes.txt', 'hello')); await wait(500);
    eq('non-csv rejected with a clear message', (await txt(page, '#imp-error')).includes('.csv'), true);
    await input.uploadFile(tmp('old.xls', 'x')); await wait(500);
    eq('legacy .xls rejected with instructions to save as .xlsx or CSV', (await txt(page, '#imp-error')).includes('not supported') && (await txt(page, '#imp-error')).includes('.xlsx'), true);
    await input.uploadFile(tmp('fake.xlsx', 'PK-not-really-a-workbook')); await wait(1200);
    eq('a fake .xlsx is rejected by the server with a clear message (no crash)', /could not be read|not a valid .xlsx/.test(await txt(page, '#imp-error')), true);
    // a REAL Excel workbook: Excel date cell, numbers, one invalid row
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Bank');
    ws.addRow(['date', 'type', 'amount', 'category', 'description', 'notes']);
    ws.addRow([new Date(dd(-2) + 'T00:00:00Z'), 'EXPENSE', 250.75, 'Food', 'Excel groceries', '']);
    ws.addRow([dd(-1), 'INCOME', 9000, 'Salary', 'Excel pay', 'bonus']);
    ws.addRow([dd(-1), 'EXPENSE', 'oops', 'Food', 'bad amount in excel', '']);
    const xlPath = path.join(os.tmpdir(), 'fintrack-e2e-' + Date.now() + '-bank.xlsx'); await wb.xlsx.writeFile(xlPath);
    const xlBefore = await count(T);
    await (await page.$('#imp-file')).uploadFile(xlPath); await wait(1800);
    const xt = await txt(page, '#imp-body');
    eq('real .xlsx: preview shows 3 rows, 2 ready, 1 invalid (values read from Excel), nothing saved', [/ROWS IN FILE\s*3/i.test(xt), /READY TO IMPORT\s*2/i.test(xt), xt.includes('plain positive number'), xt.includes('Excel groceries'), await count(T)], [true, true, true, true, xlBefore]);
    await page.$eval('[data-action="confirm"]', (b) => b.click()); await page.waitForSelector('[data-confirm="yes"]', { timeout: 5000 });
    await page.$eval('[data-confirm="yes"]', (b) => b.click()); await wait(2200);
    eq('real .xlsx imported (valid rows only) and listed in history as bank.xlsx', [await count(T), (await txt(page, '#imp-history')).includes('.xlsx')], [xlBefore + 2, true]);
    await noToast(page);
    await page.$eval('#imp-history [data-action="undo"]', (b) => b.click()); await page.waitForSelector('[data-confirm="yes"]', { timeout: 5000 });
    await page.$eval('[data-confirm="yes"]', (b) => b.click()); await wait(1800);
    eq('Excel import undone cleanly', await count(T), xlBefore);
    await noToast(page);
    await input.uploadFile(tmp('empty.csv', '')); await wait(500);
    eq('empty file rejected', (await txt(page, '#imp-error')).includes('empty'), true);
    await input.uploadFile(tmp('nohead.csv', 'a,b\n1,2')); await wait(1200);
    eq('server-side column error shown inline (no crash)', (await txt(page, '#imp-error')).includes('Missing required column'), true);

    // real preview: 2 valid, 2 invalid, 1 duplicate of the existing transaction
    const csv = ['date,type,amount,category,description,notes', `${dd(-2)},EXPENSE,1200.50,Food,Groceries,`, `${dd(-1)},INCOME,50000,Salary,Pay day,monthly`, '2024-02-30,EXPENSE,10,Food,impossible date,', `${dd(-1)},EXPENSE,abc,Food,bad amount,`, `${dd(-3)},EXPENSE,500,Food,existing LUNCH,`].join('\n');
    const csvPath = tmp('bank.csv', csv);
    const before = await count(T);
    await (await page.$('#imp-file')).uploadFile(csvPath); await wait(1500);
    const t = await txt(page, '#imp-body');
    eq('preview: tiles (5 rows, 2 ready, 2 invalid, 1 duplicate), nothing saved yet', [/ROWS IN FILE\s*5/i.test(t), /READY TO IMPORT\s*2/i.test(t), /INVALID[^\n]*\s*2/i.test(t), /POSSIBLE DUPLICATES\s*1/i.test(t), await count(T)], [true, true, true, true, before]);
    eq('preview: invalid reasons and duplicate reason are visible', [t.includes('real day'), t.includes('plain positive number'), t.includes('Already in your transactions')], [true, true, true]);
    await noToast(page); await page.$eval('[data-action="error-report"]', (b) => b.click()); await wait(1500);
    eq('error report downloads', (await page.evaluate(() => window.__dl.map((d) => d.name))).includes('fintrack-import-errors.csv'), true);
    eq('confirm button says how many (duplicate skipped by default)', (await txt(page, '[data-action="confirm"]')).trim(), 'Import 2 transactions');

    // confirm -> modal -> done
    await page.$eval('[data-action="confirm"]', (b) => b.click()); await page.waitForSelector('[data-confirm="yes"]', { timeout: 5000 });
    await page.$eval('[data-confirm="yes"]', (b) => b.click()); await wait(2200);
    const d = await txt(page, '#imp-body');
    eq('import finished: summary + saved for real (valid only; invalid & duplicate not saved)', [/IMPORTED\s*2/i.test(d), /SKIPPED DUPLICATES\s*1/i.test(d), await count(T)], [true, true, before + 2]);
    eq('history lists it with Undo', [(await page.$$('#imp-history [data-action="undo"]')).length, (await txt(page, '#imp-history')).includes('bank.csv')], [1, true]);

    // same file again: warned, duplicates flagged, user picks one
    await noToast(page);
    await (await page.$('#imp-file')).uploadFile(csvPath); await wait(1500);
    const t2 = await txt(page, '#imp-body');
    eq('re-upload: "already imported" warning, 3 possible duplicates, nothing ready', [t2.includes('already imported'), /POSSIBLE DUPLICATES\s*3/i.test(t2), /READY TO IMPORT\s*0/i.test(t2), (await txt(page, '[data-action="confirm"]')).includes('Nothing to import')], [true, true, true, true]);
    await page.$eval('[data-dup]', (e) => e.click()); await wait(400);
    eq('ticking one duplicate enables importing exactly that row', (await txt(page, '[data-action="confirm"]')).trim(), 'Import 1 transaction');
    await page.$eval('[data-action="confirm"]', (b) => b.click()); await page.waitForSelector('[data-confirm="yes"]', { timeout: 5000 });
    await page.$eval('[data-confirm="yes"]', (b) => b.click()); await wait(2200);
    eq('chosen duplicate imported (+1), others skipped', await count(T), before + 3);

    // undo from history (confirm dialog, only that import's rows)
    await noToast(page);
    await page.waitForSelector('#imp-history [data-action="undo"]', { timeout: 5000 });
    await page.$eval('#imp-history [data-action="undo"]', (b) => b.click()); await page.waitForSelector('[data-confirm="yes"]', { timeout: 5000 });
    await page.$eval('[data-confirm="yes"]', (b) => b.click()); await wait(1800);
    eq('undo removed only the import-created transactions (manual one stays)', [await count(T), (await txt(page, '#imp-history')).includes('Undone')], [before + 2, true]);
    eq('no console errors on the import page (the 400 the browser itself logs for the rejected file is expected)', errors.filter((e) => !/status of 400/.test(e)), []);
    await browser.close();
  }

  // ------------------- export & backup -------------------
  for (const vp of ['desktop', 'mobile']) {
    const S = await register('exui-' + vp);
    await call(S, 'POST', '/transactions', { type: 'INCOME', amount: 1000, category: 'Salary', description: 'Pay', date: dd(-5) });
    await call(S, 'POST', '/transactions', { type: 'EXPENSE', amount: 40, category: 'Food', description: 'Lunch', date: dd(-4) });
    await call(S, 'POST', '/budgets', { category: 'Food', limit: 900, startDate: dd(-10), endDate: dd(10) });
    const g = (await call(S, 'POST', '/goals', { title: 'Trip', targetAmount: 500 })).data.goal; await call(S, 'POST', `/goals/${g.id}/contributions`, { amount: 100 });
    await call(S, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 300, frequency: 'MONTHLY', startDate: dd(-20), nextRenewalDate: dd(8) });
    await call(S, 'POST', '/recurring', { title: 'Rent', type: 'EXPENSE', amount: 100, category: 'Rent', frequency: 'MONTHLY', startDate: dd(2) });

    const { browser, page, errors } = await open(S, { hash: '/export', viewport: vp }); await wait(1800);
    await spyDownloads(page);
    eq(`[${vp}] export page: filters, CSV buttons, backup, restore, no overflow`, [(await page.$$('#ex-form')).length, (await page.$$('[data-action="csv"]')).length, (await page.$$('[data-action="backup"]')).length, (await page.$$('#rs-file')).length, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)], [1, 4, 1, 1, true]);
    await setv(page, '#ex-from', dd(0)); await setv(page, '#ex-to', dd(-5));
    await page.click('#ex-form button[type="submit"]'); await wait(400);
    eq('reversed dates => inline error, nothing downloaded', [(await txt(page, '#ex-error')).includes('on or after'), (await page.evaluate(() => window.__dl.length))], [true, 0]);
    await setv(page, '#ex-from', ''); await setv(page, '#ex-to', ''); await setv(page, '#ex-type', 'EXPENSE');
    await page.click('#ex-form button[type="submit"]'); await wait(1000);
    eq('filtered transactions CSV downloads (named -filtered-)', (await page.evaluate(() => window.__dl)).map((x) => /fintrack-transactions-filtered-.*\.csv$/.test(x.name) && x.blob), [true]);
    await noToast(page);
    await page.click('[data-action="csv"][data-kind="budgets"]'); await wait(800);
    await noToast(page);
    await page.click('[data-action="backup"]'); await wait(1200);
    eq('budgets CSV and full backup JSON downloaded', (await page.evaluate(() => window.__dl.map((x) => x.name))).slice(1).map((n) => n.replace(/\d{4}-\d{2}-\d{2}/, 'DATE')), ['fintrack-budgets-DATE.csv', 'fintrack-backup-DATE.json']);

    // restore into a clean second account
    const backupRes = await fetch('http://localhost:5055/api/export/backup', { headers: { Authorization: `Bearer ${S}` } });
    const backupText = await backupRes.text(); const bp = tmp('backup.json', backupText);
    const D = await register('exui-dst-' + vp);
    const w2 = await open(D, { hash: '/export', viewport: vp }); await wait(1800);
    const p2 = w2.page;
    const inp = await p2.$('#rs-file');
    await inp.uploadFile(tmp('bad.json', '{ not json')); await wait(500);
    eq('invalid JSON rejected', (await txt(p2, '#rs-error')).includes('not valid JSON'), true);
    const tampered = JSON.parse(backupText); tampered.data.transactions[0].amount = 777777;
    await (await p2.$('#rs-file')).uploadFile(tmp('tampered.json', JSON.stringify(tampered))); await wait(1500);
    eq('tampered backup rejected with the checksum message', (await txt(p2, '#rs-error')).includes('damaged or was edited'), true);
    await (await p2.$('#rs-file')).uploadFile(bp); await wait(1800);
    const pv = await txt(p2, '#rs-body');
    eq('restore preview: table shows file counts and what will be added; merge is the default; nothing written yet', [pv.includes('Merge (recommended)'), pv.includes('Savings goals'), await p2.$eval('[name="rs-mode"]:checked', (e) => e.value), (await call(D, 'GET', '/transactions')).data.transactions.length], [true, true, 'merge', 0]);
    eq('preview says recurring comes back paused', pv.includes('paused'), true);
    // replace needs the typed phrase
    await p2.click('[name="rs-mode"][value="replace"]'); await wait(1500);
    eq('replace mode: warning about permanent deletion, phrase field, restore disabled until typed', [(await txt(p2, '#rs-body')).includes('permanently delete'), (await p2.$('#rs-phrase')) !== null, await p2.$eval('[data-action="restore"]', (b) => b.disabled)], [true, true, true]);
    await setv(p2, '#rs-phrase', 'replace my data');
    eq('wrong phrase keeps it disabled', await p2.$eval('[data-action="restore"]', (b) => b.disabled), true);
    await setv(p2, '#rs-phrase', 'REPLACE MY DATA');
    eq('exact phrase enables it', await p2.$eval('[data-action="restore"]', (b) => b.disabled), false);
    await p2.click('[name="rs-mode"][value="merge"]'); await wait(1500);
    await p2.click('[data-action="restore"]'); await wait(500);
    await p2.click('[data-confirm="yes"]'); await wait(2500);
    const fin = await txt(p2, '#rs-body');
    eq('restore complete message; data really restored in the account', [fin.includes('Restore complete'), (await call(D, 'GET', '/transactions')).data.transactions.length, (await call(D, 'GET', '/budgets')).data.budgets.length, (await call(D, 'GET', '/goals')).data.goals.length, (await call(D, 'GET', '/subscriptions')).data.subscriptions.length, (await call(D, 'GET', '/recurring')).data.recurring.map((r) => r.status)], [true, 2, 1, 1, 1, ['paused']]);
    eq('source account untouched', (await call(S, 'GET', '/transactions')).data.transactions.length, 2);
    eq('no console errors on the export page', [errors, w2.errors.filter((e) => !/status of 400/.test(e))], [[], []]);
    await w2.browser.close();
    await browser.close();
  }
  srv.close && srv.close();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
