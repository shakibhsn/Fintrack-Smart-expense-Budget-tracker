const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const importer = require('../services/importService');
const { xlsxToCsv } = require('../services/xlsxImport');
const exporter = require('../services/exportService');
const backups = require('../services/backupService');
const { listQuerySchema } = require('../validators/transactionValidators');

// a file is sent either as CSV text (`csv`) or as a base64 .xlsx workbook (`xlsx`); both end up as the same CSV text on the server
const baseFile = z.object({ csv: z.string().optional(), xlsx: z.string().optional(), fileName: z.string().max(260).optional() });
const oneSource = [(b) => (b.csv !== undefined) !== (b.xlsx !== undefined), { message: 'Send the file as either csv text or an xlsx workbook.' }];
const fileBody = baseFile.refine(...oneSource);
const withCsv = async (b) => (b.xlsx !== undefined ? { ...b, csv: await xlsxToCsv(b.xlsx, b.fileName), xlsx: undefined, viaXlsx: true } : b);
const confirmBody = baseFile.extend({
  duplicateAction: z.enum(['skip', 'import']).default('skip'),
  includeRows: z.array(z.number().int().positive()).max(5000).default([]),
  confirm: z.literal(true, { error: 'Importing needs your explicit confirmation (confirm: true).' }),
}).refine(...oneSource);
const backupBody = z.object({ backup: z.any(), mode: z.enum(['merge', 'replace']).default('merge'), fileName: z.string().max(260).optional() });
const restoreBody = backupBody.extend({ confirm: z.boolean().optional(), confirmText: z.string().max(100).optional() });

const sendCsv = (res, { filename, csv, count }) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (count !== undefined) res.setHeader('X-Row-Count', String(count));
  res.send(csv);
};

// ----- import -----
const template = asyncHandler(async (req, res) => sendCsv(res, { filename: 'fintrack-import-template.csv', csv: importer.template() }));
const previewImport = asyncHandler(async (req, res) => { const b = await withCsv(fileBody.parse(req.body || {})); res.json({ success: true, data: await importer.preview(req.user.id, b) }); });
const confirmImport = asyncHandler(async (req, res) => { const b = await withCsv(confirmBody.parse(req.body || {})); res.status(201).json({ success: true, message: 'Import completed', data: await importer.confirm(req.user.id, b) }); });
const errorReport = asyncHandler(async (req, res) => { const b = await withCsv(fileBody.parse(req.body || {})); sendCsv(res, { filename: 'fintrack-import-errors.csv', csv: await importer.errorReport(req.user.id, b) }); });
const history = asyncHandler(async (req, res) => res.json({ success: true, data: { imports: await importer.history(req.user.id) } }));
const undo = asyncHandler(async (req, res) => { const r = await importer.undo(req.user.id, req.params.id); res.json({ success: true, message: `Import undone: ${r.removed} transaction${r.removed === 1 ? '' : 's'} removed`, data: r }); });

// ----- export -----
const exportTransactions = asyncHandler(async (req, res) => {
  const { sort, page, limit, ...filters } = listQuerySchema.parse(req.query); // same filter names as the Transactions page
  void sort; void page; void limit;
  const hasFilter = Object.keys(filters).length > 0;
  sendCsv(res, await exporter.transactionsCsv(req.user.id, hasFilter ? filters : {}));
});
const simple = (fn) => asyncHandler(async (req, res) => sendCsv(res, await fn(req.user.id)));
const exportBackup = asyncHandler(async (req, res) => {
  const { filename, backup } = await exporter.buildBackup(req.user);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(backup)); // compact: backups are for machines (and ~40% smaller / faster for big accounts)
});

// ----- restore -----
const previewBackup = asyncHandler(async (req, res) => { const b = backupBody.parse(req.body || {}); res.json({ success: true, data: await backups.preview(req.user.id, b, req.user) }); });
const restoreBackup = asyncHandler(async (req, res) => {
  const b = restoreBody.parse(req.body || {});
  if (!b.backup) throw httpError(400, 'No backup was received.');
  res.status(201).json({ success: true, message: 'Backup restored', data: await backups.restore(req.user.id, b) });
});

module.exports = {
  template, previewImport, confirmImport, errorReport, history, undo, exportTransactions,
  exportBudgets: simple(exporter.budgetsCsv), exportGoals: simple(exporter.goalsCsv), exportSubscriptions: simple(exporter.subscriptionsCsv), exportRecurring: simple(exporter.recurringCsv),
  exportBackup, previewBackup, restoreBackup,
};
