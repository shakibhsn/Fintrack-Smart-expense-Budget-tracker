const { z } = require('zod');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { serializeTransaction } = require('../utils/serialize');
const { getUnusualSpending } = require('../services/anomalyService');

const listSchema = z.object({ status: z.enum(['active', 'reviewed', 'dismissed', 'all']).default('active') });
const patchSchema = z.object({ status: z.enum(['NEW', 'REVIEWED', 'DISMISSED'], { error: 'status must be NEW, REVIEWED or DISMISSED' }) }).strict();

// Every query includes userId: another user's detection id is simply "not found".
const findOwned = async (id, userId) => {
  const row = await prisma.unusualDetection.findFirst({ where: { id, userId } });
  if (!row) throw httpError(404, 'Detection not found');
  return row;
};

// GET /api/unusual-spending?status=active|reviewed|dismissed|all
const list = asyncHandler(async (req, res) => {
  const { status } = listSchema.parse(req.query);
  res.json({ success: true, data: await getUnusualSpending(req.user.id, status) });
});

// PATCH /api/unusual-spending/:id  { status } - review / dismiss / restore. Never touches transactions.
const updateStatus = asyncHandler(async (req, res) => {
  const { status } = patchSchema.parse(req.body);
  await findOwned(req.params.id, req.user.id);
  const row = await prisma.unusualDetection.update({
    where: { id: req.params.id },
    data: { status, statusUpdatedAt: status === 'NEW' ? null : new Date() },
  });
  res.json({ success: true, data: { id: row.id, status: row.status, statusUpdatedAt: row.statusUpdatedAt } });
});

// GET /api/unusual-spending/:id/transactions - the real transactions behind a detection.
const relatedTransactions = asyncHandler(async (req, res) => {
  const d = await findOwned(req.params.id, req.user.id);
  const where = d.transactionId
    ? { id: d.transactionId, userId: req.user.id }
    : {
      userId: req.user.id,
      type: 'EXPENSE',
      ...(d.category ? { category: d.category } : {}),
      date: { gte: d.windowStart, lte: d.windowEnd },
    };
  const rows = await prisma.transaction.findMany({ where, orderBy: [{ amount: 'desc' }, { id: 'asc' }], take: 100 });
  res.json({ success: true, data: { transactions: rows.map(serializeTransaction) } });
});

module.exports = { list, updateStatus, relatedTransactions };
