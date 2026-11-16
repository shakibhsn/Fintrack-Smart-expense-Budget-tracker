const crypto = require('crypto');
const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { parseCsv, CsvError } = require('../utils/csvParse');
const { toCsv } = require('../utils/csv');
const { checkBudgetByCategoryAndDate } = require('./notificationService');

// ---------------------------------------------------------------------------
// Phase 16 - CSV import of transactions.
//
// Flow (nothing is saved until step 4):
//   1. upload   the browser reads the file and sends its TEXT; the server never stores the upload
//   2. preview  parse -> validate columns -> validate every row -> detect duplicates -> return the analysis (no database writes)
//   3. decide   the user sees valid / invalid / duplicate rows, may download the error report, chooses what to do with duplicates
//   4. confirm  the file is analysed AGAIN on the server (the client is never trusted), then every accepted row is written in ONE
//               database transaction together with an ImportBatch history row; any failure rolls everything back
//   5. summary  imported / skipped duplicates / invalid counts; the batch can be undone later
//
// EXCEL    .xlsx files are converted to the same CSV text first (services/xlsxImport.js) and then follow exactly this pipeline.
// FORMAT   header row required, comma separated, UTF-8:  date,type,amount,category,description[,notes]
//   date         YYYY-MM-DD (a real calendar day, years 1970-2100). Other formats are rejected, never guessed (01/02/2024 is ambiguous).
//   type         INCOME or EXPENSE (any letter case)
//   amount       a positive number, at most 2 decimals, no thousands separators or currency signs, at most 999999999.99
//   category     1-50 characters (free text, like the rest of the app)
//   description  1-200 characters      notes  optional, up to 500 characters
//
// DUPLICATE STRATEGY  a row is a "possible duplicate" when the user already has a transaction with the SAME type, calendar date,
//   amount and category and the same description (ignoring case and repeated spaces), or when an identical row appears earlier in
//   the same file. Possible duplicates are NEVER dropped silently: the user chooses to skip (default) or import them, in bulk or
//   row by row. Two real purchases that look identical are therefore still possible to import.
//
// LIMITS  file <= 1,000,000 characters, <= 1,000 data rows, <= 30 columns, cells <= 5,000 characters (see csvParse.js).
// SAFETY  text is trimmed and stripped of control characters; a leading apostrophe that FinTrack's own export adds in front of
//   = + - @ (formula protection) is removed again so an exported file imports back unchanged; nothing is ever evaluated.
// ---------------------------------------------------------------------------

const LIMITS = { maxFileChars: 1_000_000, maxRows: 1000, maxCols: 30, errorPreview: 500, rowPreview: 200 };
const REQUIRED = ['date', 'type', 'amount', 'category', 'description'];
const OPTIONAL = ['notes'];
const TEMPLATE = [
  ['date', 'type', 'amount', 'category', 'description', 'notes'],
  ['2025-01-05', 'INCOME', '50000.00', 'Salary', 'January salary', ''],
  ['2025-01-06', 'EXPENSE', '1200.50', 'Food', 'Weekly groceries', 'Example row: delete before importing'],
];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v) => {
  let s = String(v ?? '').replace(CONTROL, '').trim();
  if (/^'[=+\-@]/.test(s)) s = s.slice(1); // undo FinTrack's own formula-protection prefix
  return s;
};
const normDesc = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const keyOf = (t) => `${t.type}|${t.date}|${Number(t.amount).toFixed(2)}|${t.category.toLowerCase()}|${normDesc(t.description)}`;

function validDay(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str) return false;
  const y = d.getUTCFullYear();
  return y >= 1970 && y <= 2100;
}

function validateRow(get) {
  const errors = [];
  const date = clean(get('date')); const typeRaw = clean(get('type')).toUpperCase(); const amountRaw = clean(get('amount'));
  const category = clean(get('category')); const description = clean(get('description')); const notes = clean(get('notes'));
  if (!date) errors.push('Date is required'); else if (!validDay(date)) errors.push('Date must be a real day written as YYYY-MM-DD (years 1970-2100)');
  if (!typeRaw) errors.push('Type is required'); else if (typeRaw !== 'INCOME' && typeRaw !== 'EXPENSE') errors.push('Type must be INCOME or EXPENSE');
  if (!amountRaw) errors.push('Amount is required');
  else if (!/^\d{1,9}(\.\d{1,2})?$/.test(amountRaw)) errors.push('Amount must be a plain positive number with at most 2 decimals (no commas or currency signs)');
  else if (!(Number(amountRaw) > 0)) errors.push('Amount must be greater than 0');
  if (!category) errors.push('Category is required'); else if (category.length > 50) errors.push('Category must be 50 characters or fewer');
  if (!description) errors.push('Description is required'); else if (description.length > 200) errors.push('Description must be 200 characters or fewer');
  if (notes.length > 500) errors.push('Notes must be 500 characters or fewer');
  if (errors.length) return { errors };
  return { errors, data: { date, type: typeRaw, amount: Number(amountRaw), category, description, notes: notes || null } };
}

// ----- analysis (shared by preview and confirm) -----
async function analyze(userId, csv, fileName, viaXlsx = false) {
  if (typeof csv !== 'string' || !csv.length) throw httpError(400, 'No file content was received.');
  if (csv.length > LIMITS.maxFileChars) throw httpError(413, `The file is too large (limit ${LIMITS.maxFileChars.toLocaleString('en-US')} characters, about 1 MB).`);
  if (fileName && !(viaXlsx ? /\.xlsx$/i : /\.csv$/i).test(String(fileName))) throw httpError(400, 'Only .csv and .xlsx files can be imported. The old .xls format is not supported: save the sheet as .xlsx or CSV (comma separated) first.');

  let parsed;
  try { parsed = parseCsv(csv, { maxRows: LIMITS.maxRows, maxCols: LIMITS.maxCols }); } catch (e) { if (e instanceof CsvError) throw httpError(400, e.message); throw e; }
  if (!parsed.rows.length) throw httpError(400, 'The file has a header row but no data rows.');
  const headerLower = parsed.header.map((h) => h.toLowerCase());
  const missing = REQUIRED.filter((c) => !headerLower.includes(c));
  const dupHeaders = headerLower.filter((h, i) => h && headerLower.indexOf(h) !== i);
  if (missing.length) throw httpError(400, `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. The first row must be a header: ${REQUIRED.concat(OPTIONAL).join(',')}.`);
  if (dupHeaders.length) throw httpError(400, `Column "${dupHeaders[0]}" appears more than once in the header.`);
  const idx = Object.fromEntries(REQUIRED.concat(OPTIONAL).map((c) => [c, headerLower.indexOf(c)]));
  const ignored = parsed.header.filter((h, i) => h && !REQUIRED.concat(OPTIONAL).includes(headerLower[i]));

  const rows = parsed.rows.map((r) => {
    const base = { row: r.line, cells: r.cells };
    if (r.cells.length !== parsed.header.length) {
      return { ...base, status: 'invalid', errors: [`Expected ${parsed.header.length} columns but found ${r.cells.length}`] };
    }
    const v = validateRow((c) => (idx[c] >= 0 ? r.cells[idx[c]] : ''));
    return v.errors.length ? { ...base, status: 'invalid', errors: v.errors } : { ...base, status: 'valid', errors: [], data: v.data };
  });

  // duplicates: against existing transactions (one bounded query) and within the file
  const valid = rows.filter((r) => r.status === 'valid');
  if (valid.length) {
    const dates = valid.map((r) => r.data.date).sort();
    const existing = await prisma.transaction.findMany({
      where: { userId, date: { gte: new Date(`${dates[0]}T00:00:00Z`), lt: new Date(new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime() + 86400000) } },
      select: { id: true, type: true, amount: true, category: true, description: true, date: true },
    });
    const have = new Map();
    existing.forEach((t) => { have.set(keyOf({ type: t.type, date: t.date.toISOString().slice(0, 10), amount: Number(t.amount), category: t.category, description: t.description }), t.id); });
    const seen = new Map();
    valid.forEach((r) => {
      const k = keyOf(r.data);
      if (have.has(k)) { r.status = 'duplicate'; r.duplicate = { kind: 'existing' }; } else if (seen.has(k)) { r.status = 'duplicate'; r.duplicate = { kind: 'file', firstRow: seen.get(k) }; } else seen.set(k, r.row);
    });
  }

  const fileHash = crypto.createHash('sha256').update(csv).digest('hex');
  const counts = {
    total: rows.length, valid: rows.filter((r) => r.status === 'valid').length, invalid: rows.filter((r) => r.status === 'invalid').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
  };
  return { fileName: fileName || null, fileHash, header: parsed.header, ignoredColumns: ignored, hasNotes: idx.notes >= 0, rows, counts };
}

const publicRow = (r) => ({ row: r.row, status: r.status, errors: r.errors, data: r.data || null, duplicate: r.duplicate || null, raw: r.cells.slice(0, 8) });

async function preview(userId, { csv, fileName, viaXlsx }) {
  const a = await analyze(userId, csv, fileName, viaXlsx);
  const prior = await prisma.importBatch.findFirst({ where: { userId, kind: 'TRANSACTIONS_CSV', status: 'COMPLETED', fileHash: a.fileHash }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, importedRows: true } });
  const invalid = a.rows.filter((r) => r.status === 'invalid');
  const dups = a.rows.filter((r) => r.status === 'duplicate');
  const okRows = a.rows.filter((r) => r.status === 'valid');
  return {
    fileName: a.fileName, fileHash: a.fileHash, counts: a.counts, ignoredColumns: a.ignoredColumns, limits: LIMITS,
    willImport: a.counts.valid, // valid, non-duplicate rows; duplicates are only imported if the user chooses so
    sameFileAlreadyImported: prior ? { batchId: prior.id, at: prior.createdAt, importedRows: prior.importedRows } : null,
    validSample: okRows.slice(0, LIMITS.rowPreview).map(publicRow),
    invalid: invalid.slice(0, LIMITS.errorPreview).map(publicRow), invalidTruncated: invalid.length > LIMITS.errorPreview,
    duplicates: dups.slice(0, LIMITS.rowPreview).map(publicRow), duplicatesTruncated: dups.length > LIMITS.rowPreview,
    duplicateRule: 'Same type, date, amount and category, and the same description (ignoring case and extra spaces), as an existing transaction or an earlier row in this file.',
  };
}

// opts.failAfterInsert is a TEST HOOK (not reachable over HTTP): throws after the rows are inserted to prove the whole import rolls back.
async function confirm(userId, { csv, fileName, viaXlsx, duplicateAction = 'skip', includeRows = [] }, now = new Date(), opts = {}) {
  const a = await analyze(userId, csv, fileName, viaXlsx);
  const include = new Set((Array.isArray(includeRows) ? includeRows : []).map(Number));
  const accepted = a.rows.filter((r) => r.status === 'valid' || (r.status === 'duplicate' && (duplicateAction === 'import' || include.has(r.row))));
  const skippedDup = a.rows.filter((r) => r.status === 'duplicate' && !accepted.includes(r)).length;
  if (!accepted.length) throw httpError(400, a.counts.invalid === a.counts.total ? 'No valid rows to import. Fix the errors and upload the file again.' : 'Nothing to import: every valid row was skipped as a possible duplicate.');

  let batch;
  try {
    batch = await prisma.$transaction(async (tx) => {
      const b = await tx.importBatch.create({ data: { userId, kind: 'TRANSACTIONS_CSV', status: 'COMPLETED', fileName: fileName ? String(fileName).slice(0, 200) : null, fileHash: a.fileHash, mode: duplicateAction, totalRows: a.counts.total, importedRows: accepted.length, duplicateSkipped: skippedDup, invalidRows: a.counts.invalid } });
      for (let i = 0; i < accepted.length; i += 500) {
        // eslint-disable-next-line no-await-in-loop
        await tx.transaction.createMany({ data: accepted.slice(i, i + 500).map((r) => ({ userId, importBatchId: b.id, type: r.data.type, amount: r.data.amount, category: r.data.category, description: r.data.description, notes: r.data.notes, date: new Date(`${r.data.date}T00:00:00Z`) })) });
      }
      if (opts.failAfterInsert) throw new Error('injected failure after insert');
      return b;
    }, { timeout: 60000, maxWait: 10000 });
  } catch (err) {
    // The transaction rolled back: nothing was imported. Log a FAILED batch with a GENERIC message (no row data, no stack, no SQL).
    console.error('[import] failed:', err.code || err.name);
    await prisma.importBatch.create({ data: { userId, kind: 'TRANSACTIONS_CSV', status: 'FAILED', fileName: fileName ? String(fileName).slice(0, 200) : null, fileHash: a.fileHash, mode: duplicateAction, totalRows: a.counts.total, importedRows: 0, invalidRows: a.counts.invalid, errorMessage: 'The import could not be saved and was rolled back. No transactions were added.' } }).catch(() => {});
    throw httpError(500, 'The import could not be saved and was rolled back. No transactions were added.');
  }

  // imported expenses may push a budget over a threshold: same de-duplicated alerts as adding transactions by hand
  const latest = new Map();
  accepted.filter((r) => r.data.type === 'EXPENSE').forEach((r) => { const d = new Date(`${r.data.date}T00:00:00Z`); if (!latest.has(r.data.category) || d > latest.get(r.data.category)) latest.set(r.data.category, d); });
  for (const [category, d] of [...latest.entries()].slice(0, 15)) { await checkBudgetByCategoryAndDate(userId, category, d); } // eslint-disable-line no-await-in-loop

  return {
    batchId: batch.id, imported: accepted.length, skippedDuplicates: skippedDup, invalid: a.counts.invalid, total: a.counts.total, finishedAt: now.toISOString(),
    invalidRows: a.rows.filter((r) => r.status === 'invalid').slice(0, LIMITS.errorPreview).map(publicRow),
  };
}

// error report: every row that was NOT clean (invalid or duplicate) with the reason, plus the original cells
async function errorReport(userId, { csv, fileName, viaXlsx }) {
  const a = await analyze(userId, csv, fileName, viaXlsx);
  const bad = a.rows.filter((r) => r.status !== 'valid');
  const rows = [['file_row', 'status', 'problem', ...a.header]];
  bad.forEach((r) => rows.push([r.row, r.status, r.status === 'invalid' ? r.errors.join('; ') : (r.duplicate.kind === 'file' ? `Same as row ${r.duplicate.firstRow} in this file` : 'Same as an existing transaction'), ...r.cells]));
  return toCsv(rows);
}

const template = () => toCsv(TEMPLATE);

// ----- history & undo -----
const historyRow = (b) => ({ id: b.id, kind: b.kind, status: b.status, fileName: b.fileName, mode: b.mode, totalRows: b.totalRows, importedRows: b.importedRows, duplicateSkipped: b.duplicateSkipped, invalidRows: b.invalidRows, summary: b.summary, errorMessage: b.errorMessage, createdAt: b.createdAt, undoneAt: b.undoneAt, canUndo: b.kind === 'TRANSACTIONS_CSV' && b.status === 'COMPLETED' });
const history = async (userId) => (await prisma.importBatch.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 })).map(historyRow);

async function undo(userId, id) {
  const b = await prisma.importBatch.findFirst({ where: { id, userId } }); // ownership in the query
  if (!b) throw httpError(404, 'Import not found');
  if (b.kind !== 'TRANSACTIONS_CSV') throw httpError(400, 'Only CSV transaction imports can be undone.');
  if (b.status !== 'COMPLETED') throw httpError(409, b.status === 'UNDONE' ? 'This import was already undone.' : 'This import did not complete, so there is nothing to undo.');
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.importBatch.updateMany({ where: { id, userId, status: 'COMPLETED' }, data: { status: 'UNDONE', undoneAt: new Date() } }); // compare-and-set: a double click undoes once
    if (!claimed.count) throw httpError(409, 'This import was already undone.');
    const del = await tx.transaction.deleteMany({ where: { importBatchId: id, userId } });
    return { removed: del.count };
  });
}

module.exports = { preview, confirm, errorReport, template, history, undo, analyze, LIMITS, keyOf, REQUIRED, OPTIONAL, clean, validDay };
