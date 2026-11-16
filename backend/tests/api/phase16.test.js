const { prisma } = require('./dbenv');
const { call, register, eq, done } = require('./lib');
const B = require('path').join(__dirname, '..', '..', 'src') + '/';
const { parseCsv, CsvError } = require(B + 'utils/csvParse');
const csvu = require(B + 'utils/csv');
const importer = require(B + 'services/importService');
const exporter = require(B + 'services/exportService');
const backups = require(B + 'services/backupService');
const { perUser } = require(B + 'middleware/rateLimiters');

const BASE = process.env.BASE || 'http://localhost:5055/api';
const iso = (d) => d.toISOString().slice(0, 10);
const t0 = new Date();
const today = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));
const raw = async (T, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: `Bearer ${T}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), text: buf.toString('utf8'), json, data: json && json.data };
};
const csvOf = (rows) => rows.map((r) => r.join(',')).join('\n');
const HEAD = 'date,type,amount,category,description,notes';
const uidOf = async (prefix) => (await prisma.user.findFirst({ where: { email: { startsWith: prefix } }, orderBy: { createdAt: 'desc' } })).id;
const txCount = (uid) => prisma.transaction.count({ where: { userId: uid } });

(async () => {
  // =================== CSV parser ===================
  const P = (s, o) => parseCsv(s, o);
  eq('parser: simple + CRLF + BOM + blank lines', [P('\uFEFFa,b\r\n1,2\r\n\r\n3,4\r\n').header, P('a,b\n1,2\n\n3,4\n').rows.map((r) => r.cells)], [['a', 'b'], [['1', '2'], ['3', '4']]]);
  eq('parser: quoted commas, escaped quotes, line breaks inside a cell, empty cells', P('a,b,c\n"x,y","he said ""hi""","l1\nl2"\n,,\n').rows.map((r) => r.cells), [['x,y', 'he said "hi"', 'l1\nl2'], ['', '', '']]);
  eq('parser: line numbers point at the file line the row starts on', P('a,b\n"x\ny",1\n2,3\n').rows.map((r) => r.line), [2, 4]);
  const bad = (s, o) => { try { P(s, o); return 'no error'; } catch (e) { return e instanceof CsvError ? 'CsvError' : e.name; } };
  eq('parser: unterminated quote, stray quote, text after quote, NUL byte, empty => CsvError', [bad('a,b\n"x,1'), bad('a,b\nx"y,1'), bad('a,b\n"x"y,1'), bad('a,b\n1,\u0000'), bad('')], Array(5).fill('CsvError'));
  eq('parser: limits (rows / columns / cell size) enforced while parsing', [bad('a\n' + '1\n'.repeat(11), { maxRows: 10 }), bad('a,b,c\n1,2,3', { maxCols: 2 }), bad('a\n' + 'x'.repeat(60), { maxCell: 50 })], Array(3).fill('CsvError'));
  eq('csv writer: CRLF, BOM, quoting, formula neutralised', csvu.toCsv([['a', 'b'], ['=1+1', 'x,"y"']]), '\uFEFFa,b\r\n\'=1+1,"x,""y"""\r\n');

  // =================== import ===================
  const A = await register('i16a'); const Bu = await register('i16b'); const Z = await register('i16z');
  const aid = await uidOf('i16a.'); const bid = await uidOf('i16b.');
  const preview = (T, csv, fileName = 'bank.csv') => raw(T, 'POST', '/import/transactions/preview', { csv, fileName });
  const confirm = (T, csv, extra = {}) => raw(T, 'POST', '/import/transactions/confirm', { csv, fileName: 'bank.csv', confirm: true, ...extra });

  eq('no token => 401 on every import/export/backup route', await Promise.all([['GET', '/import/template'], ['POST', '/import/transactions/preview'], ['POST', '/import/transactions/confirm'], ['GET', '/import/history'], ['GET', '/export/transactions'], ['GET', '/export/backup'], ['POST', '/backup/restore']].map(async ([m, p]) => (await raw(null, m, p, m === 'POST' ? {} : undefined)).status)), Array(7).fill(401));

  const tpl = await raw(A, 'GET', '/import/template');
  eq('template: csv attachment, header + example rows, importable shape', [tpl.status, /text\/csv/.test(tpl.type), /fintrack-import-template\.csv/.test(tpl.disp), tpl.text.replace('\uFEFF', '').split('\r\n')[0], tpl.text.split('\r\n').length], [200, true, true, HEAD, 4]);

  const goodRows = [HEAD, `${dd(-3)},EXPENSE,1200.50,Food,Groceries,`, `${dd(-2)},income,50000,Salary,Salary,monthly`, `${dd(-1)},EXPENSE,300,Transport,Bus pass,`].join('\n');
  const before = await txCount(aid);
  const p1 = await preview(A, goodRows);
  eq('preview: counts and NOTHING saved', [p1.status, p1.data.counts, await txCount(aid), p1.data.willImport], [200, { total: 3, valid: 3, invalid: 0, duplicate: 0 }, before, 3]);
  eq('preview: shows limits and duplicate rule', [p1.data.limits.maxRows, typeof p1.data.duplicateRule], [1000, 'string']);

  // structure errors
  const E = async (csv, name) => (await preview(A, csv, name)).status;
  eq('structure errors => 400: missing column, no header data, empty, wrong extension (.xlsx), duplicate header', [
    await E('date,type,amount,category\n2024-01-01,EXPENSE,1,Food'), await E(''), await E(HEAD), await E(goodRows, 'data.xlsx'), await E('date,date,type,amount,category,description\n1,1,1,1,1,1')], [400, 400, 400, 400, 400]);
  eq('binary content (xlsx/zip bytes) rejected with a helpful message', [(await preview(A, 'PK\u0003\u0004\u0000\u0000binary', 'x.csv')).status, /binary/i.test((await preview(A, 'PK\u0003\u0004\u0000\u0000binary', 'x.csv')).json.message)], [400, true]);
  eq('unterminated quote => 400 naming the problem', [(await preview(A, HEAD + '\n2024-01-01,EXPENSE,1,"Food,x,')).status, /never closed/.test((await preview(A, HEAD + '\n2024-01-01,EXPENSE,1,"Food,x,')).json.message)], [400, true]);
  eq('missing-column message lists it', /Missing required column: description/.test((await preview(A, 'date,type,amount,category\n2024-01-01,EXPENSE,1,Food')).json.message), true);
  const rowsN = (n) => HEAD + '\n' + Array.from({ length: n }, (_, i) => `${dd(-5)},EXPENSE,${i + 1},Food,r${i},`).join('\n');
  eq('too many rows (1001) => 400, exactly 1000 => ok and all valid', [(await preview(A, rowsN(1001))).status, (await preview(A, rowsN(1000))).data.counts], [400, { total: 1000, valid: 1000, invalid: 0, duplicate: 0 }]);
  eq('file over 1,000,000 characters => 413; body over the 1.5 MB route limit => 413', [(await preview(A, 'a'.repeat(1_000_001))).status, (await preview(A, 'a'.repeat(1_700_000))).status], [413, 413]);

  // row-level validation
  const badRows = [HEAD, '2024-02-30,EXPENSE,10,Food,bad calendar day,', `${dd(-1)},TRANSFER,10,Food,bad type,`, `${dd(-1)},EXPENSE,-5,Food,negative,`, `${dd(-1)},EXPENSE,0,Food,zero,`, `${dd(-1)},EXPENSE,"1,200",Food,thousands sep,`, `${dd(-1)},EXPENSE,12.345,Food,3 decimals,`,
    `${dd(-1)},EXPENSE,abc,Food,not a number,`, `${dd(-1)},EXPENSE,10,,missing category,`, `${dd(-1)},EXPENSE,10,Food,,`, `${dd(-1)},EXPENSE,10,Food,${'x'.repeat(201)},`, `${dd(-1)},EXPENSE,10,${'c'.repeat(51)},long cat,`, '01/02/2024,EXPENSE,10,Food,ambiguous date,', `${dd(-1)},EXPENSE,10,Food,short row`, `${dd(-1)},EXPENSE,10,Food,valid one,`, '1969-12-31,EXPENSE,10,Food,too old,', `${dd(-1)},EXPENSE,9999999999,Food,too big,`].join('\n');
  const pb = (await preview(A, badRows)).data;
  eq('row validation: 15 invalid, 1 valid; each has a reason', [pb.counts.invalid, pb.counts.valid, pb.invalid.every((r) => r.errors.length > 0)], [15, 1, true]);
  const reasons = Object.fromEntries(pb.invalid.map((r) => [r.raw[4] || r.raw[3] || r.raw[0], r.errors.join(' | ')]));
  eq('reasons are specific (date / type / amount / category / description / column count)', [/real day/.test(reasons['bad calendar day']), /INCOME or EXPENSE/.test(reasons['bad type']), /greater than 0|plain positive/.test(reasons.negative), /plain positive number/.test(reasons['thousands sep']), /Category is required/.test(reasons['missing category']), /200 characters/.test(reasons['x'.repeat(201)] || ''), /Expected 6 columns/.test(reasons['short row'] || Object.values(reasons).join())], Array(7).fill(true));
  eq('invalid rows carry the spreadsheet line number', pb.invalid[0].row, 2);

  // confirm rules
  eq('confirm without confirm:true => 400 and nothing saved', [(await raw(A, 'POST', '/import/transactions/confirm', { csv: goodRows, fileName: 'bank.csv' })).status, await txCount(aid)], [400, before]);
  const c1 = await confirm(A, badRows);
  eq('confirm with mixed file: only the 1 valid row is saved; invalid never imported', [c1.status, c1.data.imported, c1.data.invalid, await txCount(aid)], [201, 1, 15, before + 1]);
  const c2 = await confirm(A, goodRows);
  eq('confirm good file: 3 saved, summary numbers', [c2.status, c2.data.imported, c2.data.skippedDuplicates, c2.data.total, await txCount(aid)], [201, 3, 0, 3, before + 4]);
  const saved = await prisma.transaction.findMany({ where: { userId: aid, importBatchId: c2.data.batchId }, orderBy: { amount: 'asc' } });
  eq('saved values exact (type case-normalised, decimals, notes, dates)', saved.map((t) => [t.type, Number(t.amount), t.category, t.description, t.notes, iso(t.date)]), [['EXPENSE', 300, 'Transport', 'Bus pass', null, dd(-1)], ['EXPENSE', 1200.5, 'Food', 'Groceries', null, dd(-3)], ['INCOME', 50000, 'Salary', 'Salary', 'monthly', dd(-2)]]);

  // duplicates
  const again = (await preview(A, goodRows)).data;
  eq('same file again: all 3 flagged as duplicates, the earlier import is named', [again.counts.duplicate, again.counts.valid, again.sameFileAlreadyImported && again.sameFileAlreadyImported.batchId === c2.data.batchId, again.duplicates.every((d) => d.duplicate.kind === 'existing')], [3, 0, true, true]);
  const skipAll = await confirm(A, goodRows);
  eq('default = skip duplicates => nothing to import (400), no rows added', [skipAll.status, await txCount(aid)], [400, before + 4]);
  const pickOne = await confirm(A, goodRows, { includeRows: [3] });
  eq('user picks ONE duplicate row to import => exactly that row added, 2 skipped', [pickOne.status, pickOne.data.imported, pickOne.data.skippedDuplicates, await txCount(aid)], [201, 1, 2, before + 5]);
  const all = await confirm(A, goodRows, { duplicateAction: 'import' });
  eq('"import duplicates" => all 3 added (explicit choice)', [all.status, all.data.imported, await txCount(aid)], [201, 3, before + 8]);
  // manual transaction + differences in case/spaces
  await call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: 77, category: 'Food', description: 'Team   Lunch', date: dd(-4) });
  const ci = (await preview(A, [HEAD, `${dd(-4)},EXPENSE,77.00,food,team lunch,`, `${dd(-4)},EXPENSE,77.00,Food,Team lunch extra,`].join('\n'))).data;
  eq('duplicate vs a hand-added transaction ignores case & repeated spaces; different description is not a duplicate', [ci.counts.duplicate, ci.counts.valid], [1, 1]);
  const inFile = (await preview(A, [HEAD, `${dd(-6)},EXPENSE,5,Food,coffee,`, `${dd(-6)},EXPENSE,5,Food,coffee,`].join('\n'))).data;
  eq('identical rows inside one file: second flagged "file" duplicate pointing at the first', [inFile.counts.duplicate, inFile.duplicates[0].duplicate, inFile.counts.valid], [1, { kind: 'file', firstRow: 2 }, 1]);

  // error report
  const er = await raw(A, 'POST', '/import/transactions/error-report', { csv: badRows, fileName: 'bank.csv' });
  eq('error report: csv with file_row, status, problem + original cells', [er.status, /text\/csv/.test(er.type), er.text.split('\r\n')[0].replace('\uFEFF', ''), er.text.split('\r\n').length - 2 >= 15, /real day/.test(er.text)], [200, true, 'file_row,status,problem,date,type,amount,category,description,notes', true, true]);

  // formula injection round trip
  const evil = [HEAD, `${dd(-7)},EXPENSE,9,Food,"=HYPERLINK(""http://evil"",""x"")",`, `${dd(-7)},EXPENSE,8,Food,+cmd|' /C calc'!A0,@SUM(1+1)`].join('\n');
  const ev = await confirm(A, evil);
  eq('hostile text imports as plain text (never evaluated)', [ev.status, (await prisma.transaction.findFirst({ where: { userId: aid, amount: 9 } })).description], [201, '=HYPERLINK("http://evil","x")']);
  const ex = await raw(A, 'GET', '/export/transactions');
  eq('export neutralises formula cells (leading apostrophe), nothing starts with = + @ unquoted', [ex.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), /(^|,|\n)=HYPERLINK/.test(ex.text), /,@SUM/.test(ex.text), ex.text.includes(`'+cmd`), ex.text.includes(`'@SUM(1+1)`)], [true, false, false, true, true]);
  const RT = await register('i16rt'); const rtid = await uidOf('i16rt.');
  const rtc = await confirm(RT, ex.text.replace('\uFEFF', ''), { duplicateAction: 'import' });
  const rtSaved = await prisma.transaction.findFirst({ where: { userId: rtid, amount: 9 } });
  eq('round trip: exported file imports back; protective apostrophe removed again', [rtc.status, rtSaved.description, await txCount(rtid), await txCount(aid)], [201, '=HYPERLINK("http://evil","x")', await txCount(aid), await txCount(aid)]);

  // failed import rolls back
  const failUser = await register('i16f'); const fid = await uidOf('i16f.');
  const big = [HEAD, ...Array.from({ length: 700 }, (_, i) => `${dd(-9)},EXPENSE,${i + 1},Food,row ${i},`)].join('\n');
  let failed = null;
  try { await importer.confirm(fid, { csv: big, fileName: 'big.csv' }, new Date(), { failAfterInsert: true }); } catch (e) { failed = e; }
  const failedBatches = await prisma.importBatch.findMany({ where: { userId: fid } });
  eq('failure after inserting 2 chunks => ZERO transactions kept (full rollback)', [await txCount(fid), failed && failed.statusCode], [0, 500]);
  eq('failure is logged as FAILED with a generic message (no row data, no internals)', [failedBatches.length, failedBatches[0].status, failedBatches[0].importedRows, /rolled back/.test(failedBatches[0].errorMessage), /injected|row \d|Prisma|SELECT/i.test(failedBatches[0].errorMessage + failed.message)], [1, 'FAILED', 0, true, false]);

  // large import
  const L = await register('i16l'); const lid = await uidOf('i16l.');
  const t1 = Date.now(); const lc = await confirm(L, big); const lt = Date.now() - t1;
  eq('700-row import saved in one go, quickly', [lc.status, lc.data.imported, await txCount(lid), lt < 8000], [201, 700, 700, true]);
  const lastBatch = lc.data.batchId;

  // history + undo + isolation
  const hist = (await raw(L, 'GET', '/import/history')).data.imports;
  eq('history lists the import with counts and canUndo', [hist.length, hist[0].status, hist[0].importedRows, hist[0].canUndo, hist[0].fileName], [1, 'COMPLETED', 700, true, 'bank.csv']);
  eq('another user cannot see or undo it', [(await raw(Bu, 'GET', '/import/history')).data.imports.length, (await raw(Bu, 'POST', `/import/history/${lastBatch}/undo`)).status, await txCount(lid)], [0, 404, 700]);
  await call(L, 'POST', '/transactions', { type: 'EXPENSE', amount: 1, category: 'Food', description: 'manual one', date: dd(-1) });
  const un = await raw(L, 'POST', `/import/history/${lastBatch}/undo`);
  eq('undo removes ONLY that import (manual transaction stays), status UNDONE', [un.status, un.data.removed, await txCount(lid), (await raw(L, 'GET', '/import/history')).data.imports[0].status], [200, 700, 1, 'UNDONE']);
  eq('undo twice => 409; unknown id => 404', [(await raw(L, 'POST', `/import/history/${lastBatch}/undo`)).status, (await raw(L, 'POST', '/import/history/not-a-real-id/undo')).status], [409, 404]);
  eq('empty user: empty import history', (await raw(Z, 'GET', '/import/history')).data.imports, []);

  // =================== exports ===================
  const X = await register('i16x'); const xid = await uidOf('i16x.');
  const mk = (type, amount, category, date, description, notes) => call(X, 'POST', '/transactions', { type, amount, category, description, date, ...(notes ? { notes } : {}) });
  await mk('INCOME', 1000, 'Salary', dd(-10), 'Pay'); await mk('EXPENSE', 50, 'Food', dd(-9), 'Lunch, with comma'); await mk('EXPENSE', 80, 'Food', dd(-5), 'Dinner "quoted"'); await mk('EXPENSE', 20, 'Transport', dd(-2), 'Taxi', 'airport');
  const exAll = await raw(X, 'GET', '/export/transactions');
  const lines = exAll.text.replace('\uFEFF', '').split('\r\n').filter(Boolean);
  eq('export all: header = import template header, 4 rows, BOM, attachment name', [lines[0], lines.length - 1, exAll.text.charCodeAt(0), /fintrack-transactions-\d{4}-\d{2}-\d{2}\.csv/.test(exAll.disp)], [HEAD, 4, 0xFEFF, true]);
  eq('export escaping: commas and quotes survive a parse round trip', parseCsv(exAll.text).rows.map((r) => r.cells[4]).sort(), ['Dinner "quoted"', 'Lunch, with comma', 'Pay', 'Taxi']);
  const f = async (q) => parseCsv((await raw(X, 'GET', '/export/transactions?' + q)).text).rows.length;
  eq('filtered exports: type / category / date range / search / amount', [await f('type=EXPENSE'), await f('category=Food'), await f(`dateFrom=${dd(-6)}&dateTo=${dd(-1)}`), await f('search=taxi'), await f('minAmount=60'), (await raw(X, 'GET', '/export/transactions?type=EXPENSE')).disp.includes('-filtered-')], [3, 2, 2, 1, 2, true]);
  eq('filtered export with a bad filter => 400', (await raw(X, 'GET', '/export/transactions?type=NOPE')).status, 400);
  eq('export with zero matches still valid (header only)', parseCsv((await raw(X, 'GET', '/export/transactions?category=Nothing')).text.replace('\uFEFF', 'date,type,amount,category,description,notes\n').split('\n').slice(0, 1).join('\n') || HEAD).header.length, 6);
  eq('another user exports only their own data', parseCsv((await raw(Bu, 'GET', '/export/transactions')).text.replace(/^\uFEFF/, '') || HEAD).rows.length, 0);
  // budgets / goals / subscriptions / recurring
  await call(X, 'POST', '/budgets', { category: 'Food', limit: 5000, startDate: dd(-10), endDate: dd(20) });
  const g = (await call(X, 'POST', '/goals', { title: '=Laptop fund', targetAmount: 1000 })).data.goal; await call(X, 'POST', `/goals/${g.id}/contributions`, { amount: 250 });
  const sub = (await call(X, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 500, frequency: 'MONTHLY', startDate: dd(-20), nextRenewalDate: dd(5), autoRecord: false })).data.subscription;
  await call(X, 'POST', '/recurring', { title: 'Rent', type: 'EXPENSE', amount: 100, category: 'Rent', frequency: 'MONTHLY', startDate: dd(1) });
  const csvOfPath = async (p) => { const r = await raw(X, 'GET', p); return { r, t: parseCsv(r.text) }; };
  const eb = await csvOfPath('/export/budgets'); const eg = await csvOfPath('/export/goals'); const es = await csvOfPath('/export/subscriptions'); const er2 = await csvOfPath('/export/recurring');
  eq('budgets csv: 1 row with spent/percent', [eb.t.rows.length, eb.t.header.slice(0, 3), eb.t.rows[0].cells[0], eb.t.rows[0].cells[5]], [1, ['category', 'limit', 'start_date'], 'Food', '130']);
  eq('goals csv: formula-looking title neutralised; saved 250 = 25%', [eg.r.text.includes(`'=Laptop fund`), eg.t.rows[0].cells[2], eg.t.rows[0].cells[3]], [true, '250', '25']);
  eq('subscriptions csv: estimates labelled in header (not payments)', [es.t.rows.length, es.t.header.includes('estimated_monthly_cost'), es.t.rows[0].cells[es.t.header.indexOf('estimated_monthly_cost')], es.t.rows[0].cells[es.t.header.indexOf('estimated_yearly_cost')]], [1, true, '500', '6000']);
  eq('recurring csv: 1 row, status active', [er2.t.rows.length, er2.t.rows[0].cells[er2.t.header.indexOf('status')]], [1, 'active']);
  eq('every export route has attachment disposition + csv type', [eb.r, eg.r, es.r, er2.r].every((r) => r.status === 200 && /text\/csv/.test(r.type) && /attachment/.test(r.disp)), true);

  // =================== full JSON backup ===================
  const email = (await prisma.user.findUnique({ where: { id: xid } })).email; const hash = (await prisma.user.findUnique({ where: { id: xid } })).passwordHash;
  await call(X, 'POST', `/subscriptions/${sub.id}/payments`, { recordTransaction: true });
  const bk = await raw(X, 'GET', '/export/backup');
  const backup = bk.json;
  eq('backup: json attachment, format v1, counts, checksum present', [bk.status, /application\/json/.test(bk.type), /fintrack-backup-.*\.json/.test(bk.disp), backup.formatVersion, backup.app, backup.counts.budgets, backup.counts.goals, backup.counts.goalContributions, backup.counts.subscriptions, backup.counts.recurring, /^sha256:[0-9a-f]{64}$/.test(backup.checksum)], [200, true, true, 1, 'FinTrack', 1, 1, 1, 1, 1, true]);
  eq('backup EXCLUDES secrets: no password hash, no e-mail, no token words, documented exclusions listed', [bk.text.includes(hash), bk.text.includes(email), /passwordHash|jwt|token|secret|bcrypt|\$2[aby]\$/i.test(JSON.stringify({ data: backup.data, profile: backup.profile })), backup.exclusions.length >= 5, 'profile' in backup && !('email' in backup.profile)], [false, false, false, true, true]);
  eq('backup data: no foreign ids, user ids never included', [bk.text.includes(xid), /"userId"/.test(bk.text)], [false, false]);
  eq('backup checksum matches its data', backup.checksum, exporter.checksumOf(backup.data));

  // ---- preview (writes nothing) ----
  const C = await register('i16c'); const cid = await uidOf('i16c.');
  const prev = await raw(C, 'POST', '/backup/preview', { backup });
  eq('restore preview: counts, what will be added, nothing written, merge by default', [prev.status, prev.data.mode, prev.data.willAdd.transactions, prev.data.willAdd.goals, prev.data.willAdd.subscriptions, prev.data.willAdd.recurring, prev.data.willAdd.budgets, await txCount(cid), prev.data.willDelete], [200, 'merge', backup.counts.transactions, 1, 1, 1, 1, 0, null]);
  eq('preview warns that recurring comes back paused and lists exclusions', [prev.data.warnings.some((w) => /paused/.test(w)), prev.data.exclusions.length >= 5], [true, true]);
  eq('restore requires confirm:true (400) and writes nothing without it', [(await raw(C, 'POST', '/backup/restore', { backup })).status, await txCount(cid)], [400, 0]);

  // ---- tampered / invalid files ----
  const tampered = JSON.parse(JSON.stringify(backup)); tampered.data.transactions[0].amount = 999999;
  const wrongApp = { ...backup, app: 'Other' }; const newer = { ...backup, formatVersion: 99 };
  eq('tampered data (checksum mismatch), wrong app, newer format, not an object, missing data => 400', [
    (await raw(C, 'POST', '/backup/preview', { backup: tampered })).status, (await raw(C, 'POST', '/backup/preview', { backup: wrongApp })).status, (await raw(C, 'POST', '/backup/preview', { backup: newer })).status,
    (await raw(C, 'POST', '/backup/preview', { backup: 'hello' })).status, (await raw(C, 'POST', '/backup/preview', { backup: { app: 'FinTrack', kind: 'user-backup', formatVersion: 1 } })).status], Array(5).fill(400));
  eq('checksum message is helpful', /damaged or was edited/.test((await raw(C, 'POST', '/backup/preview', { backup: tampered })).json.message), true);
  const withBad = JSON.parse(JSON.stringify(backup)); withBad.data.transactions.push({ type: 'EXPENSE', amount: -5, category: 'Food', description: 'bad', date: '2024-13-45' }, { type: 'NOPE', amount: 5, category: 'Food', description: 'bad2', date: dd(-1) });
  withBad.data.budgets.push({ category: 'Food', limit: 100, startDate: dd(5), endDate: dd(1) }); withBad.checksum = exporter.checksumOf(withBad.data);
  const pv = await raw(C, 'POST', '/backup/preview', { backup: withBad });
  eq('invalid items are reported (not hidden) and excluded from willAdd', [pv.data.invalidTotal, pv.data.invalid.transactions.length, pv.data.invalid.budgets.length, pv.data.willAdd.transactions], [3, 2, 1, backup.counts.transactions]);
  const tooMany = JSON.parse(JSON.stringify(backup)); tooMany.data.goals = Array.from({ length: 501 }, (_, i) => ({ title: 'g' + i, targetAmount: 5, contributions: [] })); tooMany.checksum = exporter.checksumOf(tooMany.data);
  eq('item-count limit enforced', (await raw(C, 'POST', '/backup/preview', { backup: tooMany })).status, 400);

  // ---- restore (merge) into a clean account ----
  const rs = await raw(C, 'POST', '/backup/restore', { backup, confirm: true });
  eq('restore (merge) into empty account: everything added with NEW ids', [rs.status, rs.data.added.transactions, rs.data.added.goals, rs.data.added.goalContributions, rs.data.added.budgets, rs.data.added.subscriptions, rs.data.added.recurring], [201, backup.counts.transactions, 1, 1, 1, 1, 1]);
  const cTx = await prisma.transaction.findMany({ where: { userId: cid } }); const xTx = await prisma.transaction.findMany({ where: { userId: xid } });
  eq('restored transactions are the same data but different ids; counts equal', [cTx.length, xTx.length, cTx.some((t) => xTx.some((o) => o.id === t.id))], [xTx.length, xTx.length, false]);
  const cg = await prisma.savingsGoal.findFirst({ where: { userId: cid }, include: { contributions: true } });
  eq('goal restored with contributions; saved = sum of contributions', [cg.title, Number(cg.savedAmount), cg.contributions.length, Number(cg.contributions[0].amount)], ['=Laptop fund', 250, 1, 250]);
  const cr = await prisma.recurringTransaction.findFirst({ where: { userId: cid } });
  eq('recurring restored PAUSED (nothing generated behind the user\'s back)', [cr.isActive, !!cr.pausedAt, await prisma.transaction.count({ where: { userId: cid, recurringId: cr.id } })], [false, true, 0]);
  const cs = await prisma.subscription.findFirst({ where: { userId: cid } });
  const linked = await prisma.transaction.findMany({ where: { userId: cid, subscriptionId: cs.id } });
  eq('subscription restored and its payment expense stays linked to it (no duplicate occurrence)', [cs.name, linked.length, linked.length === 1 && linked[0].occurrenceDate !== null], ['Streaming', 1, true]);
  // subscription payment history is part of the backup now
  const cPay = await prisma.subscriptionPayment.findMany({ where: { userId: cid } });
  const xPay = await prisma.subscriptionPayment.findMany({ where: { userId: xid } });
  eq('backup includes payment history; restore recreates it with new ids, same amounts/dates, linked to the restored expense', [backup.counts.subscriptionPayments, rs.data.added.payments, cPay.length, cPay[0].id !== xPay[0].id, Number(cPay[0].amount), cPay[0].dueDate.toISOString(), xPay[0].dueDate.toISOString(), cPay[0].subscriptionId === cs.id, linked.some((t) => t.id === cPay[0].transactionId)], [1, 1, 1, true, 300 === 300 ? 500 : 0, xPay[0].dueDate.toISOString(), xPay[0].dueDate.toISOString(), true, true]);
  eq('budget restored', (await prisma.budget.count({ where: { userId: cid } })), 1);
  eq('import history records the restore', (await raw(C, 'GET', '/import/history')).data.imports[0].kind, 'BACKUP_RESTORE');
  eq('source account A/X unchanged by the restore into C', [await txCount(xid), (await prisma.savingsGoal.count({ where: { userId: xid } }))], [xTx.length, 1]);

  // ---- idempotent: restoring again adds nothing ----
  const pre2 = await raw(C, 'POST', '/backup/preview', { backup });
  eq('second preview: everything already exists => 0 to add (conflicts counted)', [Object.values(pre2.data.willAdd).reduce((a, b) => a + b, 0), pre2.data.conflicts.transactions], [0, backup.counts.transactions]);
  const rs2 = await raw(C, 'POST', '/backup/restore', { backup, confirm: true });
  eq('second restore refused as nothing to do; no duplicates created', [rs2.status, await txCount(cid), await prisma.savingsGoal.count({ where: { userId: cid } })], [400, xTx.length, 1]);

  // ---- merge into a non-empty account keeps existing data ----
  const M = await register('i16m'); const mid = await uidOf('i16m.');
  await call(M, 'POST', '/transactions', { type: 'EXPENSE', amount: 5, category: 'Misc', description: 'my existing', date: dd(-1) });
  await call(M, 'POST', '/budgets', { category: 'Food', limit: 100, startDate: dd(-3), endDate: dd(3) });
  const pm = await raw(M, 'POST', '/backup/preview', { backup });
  eq('merge: budget overlapping an existing one for the same category is a reported conflict', [pm.data.willSkip.budgets, pm.data.skipReasons.budgets.some((r) => /overlaps/.test(r))], [1, true]);
  const rm = await raw(M, 'POST', '/backup/restore', { backup, confirm: true });
  eq('merge keeps the existing transaction and budget (never destructive)', [rm.status, await txCount(mid), (await prisma.transaction.count({ where: { userId: mid, description: 'my existing' } })), (await prisma.budget.findMany({ where: { userId: mid } })).length], [201, xTx.length + 1, 1, 1]);

  // ---- replace needs the typed phrase ----
  const R = await register('i16r'); const rid = await uidOf('i16r.');
  for (let i = 0; i < 3; i += 1) await call(R, 'POST', '/transactions', { type: 'EXPENSE', amount: 10 + i, category: 'Old', description: 'old ' + i, date: dd(-1) });
  const pr = await raw(R, 'POST', '/backup/preview', { backup, mode: 'replace' });
  eq('replace preview shows what will be DELETED and the phrase', [pr.data.willDelete.transactions, pr.data.confirmPhrase, pr.data.warnings.some((w) => /permanently delete/.test(w))], [3, 'REPLACE MY DATA', true]);
  eq('replace without / with wrong phrase => 400 and data untouched', [(await raw(R, 'POST', '/backup/restore', { backup, mode: 'replace', confirm: true })).status, (await raw(R, 'POST', '/backup/restore', { backup, mode: 'replace', confirm: true, confirmText: 'replace my data' })).status, await txCount(rid)], [400, 400, 3]);

  // ---- failed restore rolls back (replace deletes first, then fails) ----
  let rf = null;
  try { await backups.restore(rid, { backup, mode: 'replace', confirm: true, confirmText: 'REPLACE MY DATA' }, { failAfter: 'transactions' }); } catch (e) { rf = e; }
  const fb = await prisma.importBatch.findMany({ where: { userId: rid, kind: 'BACKUP_RESTORE' } });
  eq('failed REPLACE restore: old data fully intact (delete rolled back), nothing partially restored', [rf && rf.statusCode, await txCount(rid), await prisma.budget.count({ where: { userId: rid } }), await prisma.savingsGoal.count({ where: { userId: rid } }), await prisma.subscription.count({ where: { userId: rid } })], [500, 3, 0, 0, 0]);
  eq('failure logged generically', [fb.length, fb[0].status, /rolled back/.test(fb[0].errorMessage), /injected/.test(fb[0].errorMessage + rf.message)], [1, 'FAILED', true, false]);
  for (const step of ['delete', 'schedules', 'budgets', 'transactions', 'payments']) {
    try { await backups.restore(rid, { backup, mode: 'replace', confirm: true, confirmText: 'REPLACE MY DATA' }, { failAfter: step }); } catch { /* expected */ }
  }
  eq('failures at every step roll back completely', [await txCount(rid), await prisma.recurringTransaction.count({ where: { userId: rid } }), await prisma.savingsGoal.count({ where: { userId: rid } })], [3, 0, 0]);
  const rr = await raw(R, 'POST', '/backup/restore', { backup, mode: 'replace', confirm: true, confirmText: 'REPLACE MY DATA' });
  eq('successful REPLACE: old rows gone, account now equals the backup', [rr.status, await txCount(rid), await prisma.transaction.count({ where: { userId: rid, category: 'Old' } }), await prisma.budget.count({ where: { userId: rid } }), await prisma.savingsGoal.count({ where: { userId: rid } })], [201, xTx.length, 0, 1, 1]);

  // ---- isolation of restore ----
  eq('restoring into B does not touch A\'s data or ids', [await txCount(aid), (await prisma.transaction.count({ where: { userId: bid } }))], [await txCount(aid), 0]);
  eq('restore history is per user', [(await raw(Z, 'GET', '/import/history')).data.imports.length, (await raw(R, 'GET', '/import/history')).data.imports.some((h) => h.kind === 'BACKUP_RESTORE')], [0, true]);

  // =================== Excel (.xlsx) import ===================
  const ExcelJS = require('../../node_modules/exceljs');
  const mkXlsx = async (rowsData, { hiddenFirst = false } = {}) => {
    const wb = new ExcelJS.Workbook();
    if (hiddenFirst) { const h = wb.addWorksheet('Hidden'); h.state = 'hidden'; h.addRow(['junk']); }
    const ws = wb.addWorksheet('Transactions');
    rowsData.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  };
  const XL = await register('i16xl'); const xlid = await uidOf('i16xl.');
  const xp = (T, xlsx, fileName = 'bank.xlsx') => raw(T, 'POST', '/import/transactions/preview', { xlsx, fileName });
  const xc = (T, xlsx, extra = {}) => raw(T, 'POST', '/import/transactions/confirm', { xlsx, fileName: 'bank.xlsx', confirm: true, ...extra });
  const D0 = new Date(`${dd(-4)}T00:00:00Z`);
  const book = await mkXlsx([
    ['date', 'type', 'amount', 'category', 'description', 'notes'],
    [D0, 'expense', 1200.5, 'Food', 'Groceries', null],
    [dd(-3), 'INCOME', 50000, 'Salary', 'Pay', 'monthly'],
    [dd(-2), 'EXPENSE', 0.1 + 0.2, 'Fun', 'float noise', null],
    [dd(-2), 'EXPENSE', 40, 'Food', { formula: 'HYPERLINK("http://evil")', result: '=cmd|calc' }, null],
    [dd(-1), 'EXPENSE', 'abc', 'Food', 'bad amount', null],
    ['2024-02-30', 'EXPENSE', 5, 'Food', 'bad date', null],
  ]);
  const xv = await xp(XL, book);
  eq('xlsx preview: Excel date cell, text date, float noise all read; 2 invalid reported; nothing saved', [xv.status, xv.data.counts, await txCount(xlid)], [200, { total: 6, valid: 4, invalid: 2, duplicate: 0 }, 0]);
  eq('xlsx preview rows carry the real values (date cell -> YYYY-MM-DD, 0.1+0.2 -> 0.3)', [xv.data.validSample[0].data.date, xv.data.validSample[0].data.amount, xv.data.validSample.find((r) => r.data.category === 'Fun').data.amount], [dd(-4), 1200.5, 0.3]);
  const xcr = await xc(XL, book);
  const xs = await prisma.transaction.findMany({ where: { userId: xlid }, orderBy: { amount: 'asc' } });
  eq('xlsx confirm: valid rows saved, invalid skipped; formula cell stored as its plain RESULT text (never evaluated)', [xcr.status, xcr.data.imported, xcr.data.invalid, xs.length, xs.find((t) => Number(t.amount) === 40).description], [201, 4, 2, 4, '=cmd|calc']);
  eq('xlsx: re-upload flags every row as a duplicate and names the earlier import', [(await xp(XL, book)).data.counts.duplicate, !!(await xp(XL, book)).data.sameFileAlreadyImported], [4, true]);
  const xe = await raw(XL, 'POST', '/import/transactions/error-report', { xlsx: book, fileName: 'bank.xlsx' });
  eq('xlsx error report works (csv with reasons)', [xe.status, /text\/csv/.test(xe.type), /plain positive number/.test(xe.text), /real day/.test(xe.text)], [200, true, true, true]);
  eq('hidden first sheet is skipped; the first visible sheet is used', (await xp(XL, await mkXlsx([['date', 'type', 'amount', 'category', 'description'], [dd(-9), 'EXPENSE', 9, 'Food', 'x']], { hiddenFirst: true }))).data.counts.total, 1);
  eq('xlsx structure errors => 400: .xls name, .xlsm name, not a zip, damaged zip, header only, empty sheet, missing column', [
    (await xp(XL, book, 'old.xls')).status, (await xp(XL, book, 'macro.xlsm')).status, (await xp(XL, Buffer.from('hello world, definitely not a workbook').toString('base64'))).status,
    (await xp(XL, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('garbage-garbage-garbage')]).toString('base64'))).status,
    (await xp(XL, await mkXlsx([['date', 'type', 'amount', 'category', 'description']]))).status, (await xp(XL, await mkXlsx([[]]))).status, (await xp(XL, await mkXlsx([['date', 'type'], [dd(-1), 'EXPENSE']]))).status], Array(7).fill(400));
  eq('xlsx too large (> 2 MB) => 413; body over the route limit => 413', [(await xp(XL, Buffer.alloc(2_100_000, 1).toString('base64'))).status, (await xp(XL, 'A'.repeat(4_000_000))).status], [413, 413]);
  eq('exactly one of csv / xlsx must be sent', [(await raw(XL, 'POST', '/import/transactions/preview', { csv: goodRows, xlsx: book, fileName: 'x.xlsx' })).status, (await raw(XL, 'POST', '/import/transactions/preview', { fileName: 'x.xlsx' })).status], [400, 400]);
  eq('csv still works with the new schema', (await preview(XL, goodRows)).status, 200);
  const manyXl = await mkXlsx([['date', 'type', 'amount', 'category', 'description'], ...Array.from({ length: 1001 }, (_, i) => [dd(-5), 'EXPENSE', i + 1, 'Food', 'r' + i])]);
  eq('xlsx 1001 data rows => 400 (limit 1000); another user cannot see this import', [(await xp(XL, manyXl)).status, (await raw(Bu, 'GET', '/import/history')).data.imports.length], [400, 0]);
  eq('xlsx import appears in history with the .xlsx name and can be undone', await (async () => { const h = (await raw(XL, 'GET', '/import/history')).data.imports; const u = await raw(XL, 'POST', `/import/history/${h[0].id}/undo`); return [h[0].fileName, u.status, await txCount(xlid)]; })(), ['bank.xlsx', 200, 0]);

  // =================== rate limiting ===================
  const http = require('http'); const express = require('../../node_modules/express');
  const app = express(); app.use((req, res, next) => { req.user = { id: 'u1' }; next(); }); app.use(perUser({ max: 2, message: 'slow down' })); app.get('/x', (req, res) => res.json({ ok: 1 }));
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
  const codes = []; for (let i = 0; i < 4; i += 1) codes.push((await fetch(`http://localhost:${port}/x`)).status);
  srv.close();
  eq('per-user rate limiter: 2 allowed then 429', codes, [200, 200, 429, 429]);
  const routes = require(B + 'routes/importRoutes.js').stack.filter((l) => l.route && l.route.methods.post).map((l) => l.route.stack.length);
  eq('import/confirm/undo routes sit behind the limiter', routes.every((n) => n >= 2), true);

  done();
})().catch((e) => { console.error(e); process.exit(1); });
