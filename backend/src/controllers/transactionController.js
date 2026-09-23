const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { serializeTransaction } = require('../utils/serialize');
const { listQuerySchema } = require('../validators/transactionValidators');
const { checkBudgetForCategory } = require('../services/notificationService');

const SORTS = {
  'date-desc': [{ date: 'desc' }, { createdAt: 'desc' }],
  'date-asc': [{ date: 'asc' }, { createdAt: 'asc' }],
  'amount-desc': [{ amount: 'desc' }],
  'amount-asc': [{ amount: 'asc' }],
};

// Every query includes userId: that is what keeps each user's data separate.
const findOwned = async (id, userId) => {
  const tx = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!tx) throw httpError(404, 'Transaction not found');
  return tx;
};

// GET /api/transactions?type=&category=&search=&sort=&page=&limit=
const getTransactions = asyncHandler(async (req, res) => {
  const { type, category, search, sort, page, limit } = listQuerySchema.parse(req.query);

  const where = { userId: req.user.id };
  if (type) where.type = type;
  if (category) where.category = category;
  if (search) {
    where.OR = [
      { description: { contains: search, mode: 'insensitive' } },
      { category: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      orderBy: SORTS[sort],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  res.json({
    success: true,
    data: {
      transactions: rows.map(serializeTransaction),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
});

// GET /api/transactions/:id
const getTransaction = asyncHandler(async (req, res) => {
  const tx = await findOwned(req.params.id, req.user.id);
  res.json({ success: true, data: { transaction: serializeTransaction(tx) } });
});

// POST /api/transactions
const createTransaction = asyncHandler(async (req, res) => {
  const tx = await prisma.transaction.create({ data: { ...req.body, userId: req.user.id } });

  // Real spending just changed - re-check the budget for this category/month and
  // notify if it's now near or over the limit. Awaited so a client that refetches
  // notifications right after this request is guaranteed to see it.
  if (tx.type === 'EXPENSE') {
    await checkBudgetForCategory(req.user.id, tx.category, tx.date.getUTCMonth() + 1, tx.date.getUTCFullYear());
  }

  res.status(201).json({ success: true, data: { transaction: serializeTransaction(tx) } });
});

// PUT /api/transactions/:id
const updateTransaction = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  const tx = await prisma.transaction.update({ where: { id: req.params.id }, data: req.body });

  if (tx.type === 'EXPENSE') {
    await checkBudgetForCategory(req.user.id, tx.category, tx.date.getUTCMonth() + 1, tx.date.getUTCFullYear());
  }

  res.json({ success: true, data: { transaction: serializeTransaction(tx) } });
});

// DELETE /api/transactions/:id
const deleteTransaction = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  await prisma.transaction.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Transaction deleted' });
});

module.exports = { getTransactions, getTransaction, createTransaction, updateTransaction, deleteTransaction };
