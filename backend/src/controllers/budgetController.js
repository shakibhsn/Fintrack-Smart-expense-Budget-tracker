const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { serializeBudget } = require('../utils/serialize');
const { getBudgetsWithSpending, getBudgetSummary, findOverlappingBudget } = require('../services/budgetService');
const { checkBudgetByCategoryAndDate } = require('../services/notificationService');

const findOwned = async (id, userId) => {
  const budget = await prisma.budget.findFirst({ where: { id, userId } });
  if (!budget) throw httpError(404, 'Budget not found');
  return budget;
};

// One budget with spending calculated (same shape as the list items), serialized for the API.
const withSpending = async (budgetId, userId) => {
  const list = await getBudgetsWithSpending(userId);
  const match = list.find((b) => b.id === budgetId);
  return match ? serializeBudget(match) : null;
};

// GET /api/budgets - every budget the user has (past, active, upcoming)
const getBudgets = asyncHandler(async (req, res) => {
  const budgets = await getBudgetsWithSpending(req.user.id);
  res.json({ success: true, data: { budgets: budgets.map(serializeBudget) } });
});

// GET /api/budgets/summary - totals across the budgets that are active right now
const getSummary = asyncHandler(async (req, res) => {
  const summary = await getBudgetSummary(req.user.id);
  res.json({
    success: true,
    data: { ...summary, budgets: summary.budgets.map(serializeBudget) },
  });
});

// POST /api/budgets
const createBudget = asyncHandler(async (req, res) => {
  const { category, startDate, endDate } = req.body;
  const clash = await findOverlappingBudget(req.user.id, category, startDate, endDate);
  if (clash) throw httpError(409, `A ${category} budget already covers part of this date range`);

  const budget = await prisma.budget.create({ data: { ...req.body, userId: req.user.id } });

  // The category may already be near/over this limit from transactions that predate
  // the budget itself - check right away rather than waiting for the next transaction.
  await checkBudgetByCategoryAndDate(req.user.id, budget.category, budget.startDate);

  res.status(201).json({ success: true, data: { budget: await withSpending(budget.id, req.user.id) } });
});

// PUT /api/budgets/:id
const updateBudget = asyncHandler(async (req, res) => {
  const current = await findOwned(req.params.id, req.user.id);

  const next = {
    category: req.body.category ?? current.category,
    startDate: req.body.startDate ?? current.startDate,
    endDate: req.body.endDate ?? current.endDate,
  };
  if (next.endDate < next.startDate) throw httpError(400, 'End date must be on or after the start date');

  const clash = await findOverlappingBudget(req.user.id, next.category, next.startDate, next.endDate, current.id);
  if (clash) throw httpError(409, `A ${next.category} budget already covers part of this date range`);

  const budget = await prisma.budget.update({ where: { id: current.id }, data: req.body });

  // The new limit/category/range may already be near/over budget - check right away.
  await checkBudgetByCategoryAndDate(req.user.id, budget.category, budget.startDate);

  res.json({ success: true, data: { budget: await withSpending(budget.id, req.user.id) } });
});

// DELETE /api/budgets/:id - never touches transactions, Budget and Transaction are independent models
const deleteBudget = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  await prisma.budget.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Budget deleted' });
});

module.exports = { getBudgets, getSummary, createBudget, updateBudget, deleteBudget };
