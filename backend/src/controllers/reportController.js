const asyncHandler = require('../utils/asyncHandler');
const reports = require('../services/reportService');
const { reportToCsv, reportToPdf } = require('../services/reportExport');
const { reportQuerySchema, snapshotBodySchema } = require('../validators/reportValidators');
const { isoDay } = require('../utils/dateRange');

const fileName = (r, ext) => `fintrack-report-${r.meta.range.start}_to_${r.meta.range.end}.${ext}`;

// GET /api/reports?period=&startDate=&endDate=  - a live report
const getReport = asyncHandler(async (req, res) => {
  const q = reportQuerySchema.parse(req.query);
  const data = await reports.buildReport(req.user.id, q, req.user);
  res.json({ success: true, data });
});

const send = async (res, report, kind) => {
  if (kind === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(report, 'csv')}"`);
    return res.send(reportToCsv(report));
  }
  const buf = await reportToPdf(report);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(report, 'pdf')}"`);
  res.setHeader('Content-Length', buf.length);
  return res.send(buf);
};

// GET /api/reports/export/csv|pdf?...
const exportReport = (kind) => asyncHandler(async (req, res) => {
  const q = reportQuerySchema.parse(req.query);
  await send(res, await reports.buildReport(req.user.id, q, req.user), kind);
});

// ----- snapshots (saved, frozen copies) -----
const listSnapshots = asyncHandler(async (req, res) => res.json({ success: true, data: { snapshots: await reports.listSnapshots(req.user.id) } }));
const createSnapshot = asyncHandler(async (req, res) => {
  const body = snapshotBodySchema.parse(req.body || {});
  const input = { period: body.period, title: body.title };
  if (body.period === 'custom') {
    // reuse the Analytics validation (both dates, order, max length) by parsing it as a query
    const q = reportQuerySchema.parse({ period: 'custom', startDate: body.startDate, endDate: body.endDate });
    input.startDate = q.startDate; input.endDate = q.endDate;
  }
  const { snapshot, duplicate } = await reports.createSnapshot(req.user.id, input, req.user);
  res.status(duplicate ? 200 : 201).json({ success: true, message: duplicate ? 'An identical saved report already exists (nothing new was saved).' : 'Report saved', data: { snapshot, duplicate } });
});
const getSnapshot = asyncHandler(async (req, res) => res.json({ success: true, data: await reports.getSnapshot(req.user.id, req.params.id) }));
const exportSnapshot = (kind) => asyncHandler(async (req, res) => send(res, await reports.getSnapshot(req.user.id, req.params.id), kind));
const deleteSnapshot = asyncHandler(async (req, res) => { await reports.deleteSnapshot(req.user.id, req.params.id); res.json({ success: true, message: 'Saved report deleted' }); });

void isoDay;
module.exports = { getReport, exportReport, listSnapshots, createSnapshot, getSnapshot, exportSnapshot, deleteSnapshot };
