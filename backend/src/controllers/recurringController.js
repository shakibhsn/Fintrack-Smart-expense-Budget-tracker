const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/recurringService');
const { createRecurringSchema, updateRecurringSchema, resumeSchema } = require('../validators/recurringValidators');

// Every handler scopes by req.user.id: another user's schedule id is simply "not found" (404).

// GET /api/recurring
const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { recurring: await svc.list(req.user.id) } });
});

// POST /api/recurring
const create = asyncHandler(async (req, res) => {
  const input = createRecurringSchema.parse(req.body);
  res.status(201).json({ success: true, data: { recurring: await svc.create(req.user.id, input) } });
});

// GET /api/recurring/:id
const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { recurring: await svc.get(req.user.id, req.params.id) } });
});

// PUT /api/recurring/:id  - applies to future occurrences only; generated transactions are never modified
const update = asyncHandler(async (req, res) => {
  const input = updateRecurringSchema.parse(req.body);
  res.json({ success: true, data: { recurring: await svc.update(req.user.id, req.params.id, input) } });
});

// DELETE /api/recurring/:id  - keeps the transactions already generated
const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.user.id, req.params.id);
  res.json({ success: true, message: 'Recurring transaction deleted. Transactions it already created were kept.' });
});

// POST /api/recurring/:id/pause
const pause = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { recurring: await svc.pause(req.user.id, req.params.id) } });
});

// POST /api/recurring/:id/resume  { catchUp?: boolean }
const resume = asyncHandler(async (req, res) => {
  const body = resumeSchema.parse(req.body || {});
  res.json({ success: true, data: { recurring: await svc.resume(req.user.id, req.params.id, body) } });
});

// GET /api/recurring/:id/occurrences
const occurrences = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.occurrences(req.user.id, req.params.id) });
});

// POST /api/recurring/process - run the CALLER'S due schedules now (idempotent). It can never touch anyone else's.
const processNow = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.processUser(req.user.id) });
});

module.exports = { list, create, getOne, update, remove, pause, resume, occurrences, processNow };
