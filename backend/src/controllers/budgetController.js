const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { periodQuerySchema } = require('../validators/budgetValidators');
const { getBudgetsWithSpending, getBudgetSummary } = require('../services/budgetService');
const { checkBudgetForCategory } = require('../services/notificationService');

const findOwned = async (id, userId) => {
  const budget = await prisma.budget.findFirst({ where: { id, userId } });
  if (!budget) throw httpError(404, 'Budget not found');
  return budget;
};

// One budget with spending calculated (same shape as the list items).
const withSpending = async (budget) => {
  const list = await getBudgetsWithSpending(budget.userId, budget.month, budget.year);
  return list.find((b) => b.id === budget.id);
};

// GET /api/budgets?month=&year=   (defaults to the current month)
const getBudgets = asyncHandler(async (req, res) => {
  const { month, year } = periodQuerySchema.parse(req.query);
  const budgets = await getBudgetsWithSpending(req.user.id, month, year);
  res.json({ success: true, data: { month, year, budgets } });
});

// GET /api/budgets/summary?month=&year=
const getSummary = asyncHandler(async (req, res) => {
  const { month, year } = periodQuerySchema.parse(req.query);
  const summary = await getBudgetSummary(req.user.id, month, year);
  res.json({ success: true, data: summary });
});

// POST /api/budgets
const createBudget = asyncHandler(async (req, res) => {
  const { category, month, year } = req.body;
  const existing = await prisma.budget.findFirst({ where: { userId: req.user.id, category, month, year } });
  if (existing) throw httpError(409, `A ${category} budget already exists for ${month}/${year}`);

  const budget = await prisma.budget.create({ data: { ...req.body, userId: req.user.id } });

  // The category may already be near/over this limit from transactions that predate
  // the budget itself - check right away rather than waiting for the next transaction.
  await checkBudgetForCategory(req.user.id, budget.category, budget.month, budget.year);

  res.status(201).json({ success: true, data: { budget: await withSpending(budget) } });
});

// PUT /api/budgets/:id
const updateBudget = asyncHandler(async (req, res) => {
  const current = await findOwned(req.params.id, req.user.id);

  const next = {
    category: req.body.category ?? current.category,
    month: req.body.month ?? current.month,
    year: req.body.year ?? current.year,
  };
  const clash = await prisma.budget.findFirst({
    where: { userId: req.user.id, ...next, NOT: { id: current.id } },
  });
  if (clash) throw httpError(409, `A ${next.category} budget already exists for ${next.month}/${next.year}`);

  const budget = await prisma.budget.update({ where: { id: current.id }, data: req.body });

  // The new limit/category/month may already be near/over budget - check right away.
  await checkBudgetForCategory(req.user.id, budget.category, budget.month, budget.year);

  res.json({ success: true, data: { budget: await withSpending(budget) } });
});

// DELETE /api/budgets/:id
const deleteBudget = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  await prisma.budget.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Budget deleted' });
});

module.exports = { getBudgets, getSummary, createBudget, updateBudget, deleteBudget };
