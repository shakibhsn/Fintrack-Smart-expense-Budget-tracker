const prisma = require('../config/prisma');
const { toNumber } = require('../utils/serialize');

const DAY_MS = 24 * 60 * 60 * 1000;

// upcoming (hasn't started yet) / active (today falls inside the range) / ended (range is over).
// Ranges are whole days, so comparisons are done against UTC midnight of "today".
const getStatus = (startDate, endDate) => {
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (todayUTC < startDate) return 'upcoming';
  if (todayUTC > endDate) return 'ended';
  return 'active';
};

// Two [start, end] ranges overlap iff each starts on or before the other ends.
const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;

// Finds an existing budget for this category whose date range overlaps the given one
// (optionally excluding one budget id, for updates). Used to block ambiguous/duplicate budgets.
const findOverlappingBudget = (userId, category, startDate, endDate, excludeId) =>
  prisma.budget.findFirst({
    where: {
      userId,
      category,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
  });

// Real spent/remaining/percentage for ONE budget, computed from EXPENSE transactions
// inside its own date range - "spent" is never stored, the transactions table is the
// source of truth. Also includes a month-over-month-style comparison against an
// equal-length period immediately before the budget's start date.
const computeSpending = async (budget) => {
  const durationMs = budget.endDate.getTime() - budget.startDate.getTime();
  const prevEnd = new Date(budget.startDate.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - durationMs);

  const [spentAgg, prevAgg] = await Promise.all([
    prisma.transaction.aggregate({
      where: { userId: budget.userId, type: 'EXPENSE', category: budget.category, date: { gte: budget.startDate, lte: budget.endDate } },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { userId: budget.userId, type: 'EXPENSE', category: budget.category, date: { gte: prevStart, lte: prevEnd } },
      _sum: { amount: true },
    }),
  ]);

  const limit = toNumber(budget.limit);
  const spent = toNumber(spentAgg._sum.amount) || 0;
  const prevSpent = toNumber(prevAgg._sum.amount) || 0;
  const momChangePercent = prevSpent > 0
    ? Math.round(((spent - prevSpent) / prevSpent) * 1000) / 10
    : (spent > 0 ? 100 : 0);

  return {
    id: budget.id,
    category: budget.category,
    limit,
    startDate: budget.startDate,
    endDate: budget.endDate,
    createdAt: budget.createdAt,
    status: getStatus(budget.startDate, budget.endDate),
    spent,
    remaining: limit - spent,
    percentage: limit > 0 ? Math.round((spent / limit) * 100) : 0,
    isOverBudget: spent > limit,
    overBy: spent > limit ? spent - limit : 0,
    prevSpent,
    momChangePercent,
  };
};

// Every budget the user has (past, active, upcoming), each with real spending computed.
// Returns raw objects (Date instances for startDate/endDate) - the controller/serializer
// formats these for the API response; notificationService uses the raw Date objects directly.
const getBudgetsWithSpending = async (userId) => {
  const budgets = await prisma.budget.findMany({ where: { userId }, orderBy: { startDate: 'desc' } });
  return Promise.all(budgets.map(computeSpending));
};

// Aggregates only the budgets that are active right now (today falls in their range) -
// this powers the "Active Budgets Overview" card.
const getBudgetSummary = async (userId) => {
  const budgets = await getBudgetsWithSpending(userId);
  const active = budgets.filter((b) => b.status === 'active');
  const totalLimit = active.reduce((s, b) => s + b.limit, 0);
  const totalSpent = active.reduce((s, b) => s + b.spent, 0);
  return {
    totalLimit,
    totalSpent,
    totalRemaining: totalLimit - totalSpent,
    percentage: totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0,
    isOverBudget: totalSpent > totalLimit,
    activeCount: active.length,
    totalCount: budgets.length,
    budgets,
  };
};

module.exports = { getBudgetsWithSpending, getBudgetSummary, findOverlappingBudget };
