const prisma = require('../config/prisma');
const { toNumber } = require('../utils/serialize');

// Start (inclusive) and end (exclusive) of a month, in UTC.
const monthRange = (month, year) => ({
  start: new Date(Date.UTC(year, month - 1, 1)),
  end: new Date(Date.UTC(year, month, 1)),
});

// Budgets for a month, each with spent/remaining/percentage computed from real
// EXPENSE transactions. "spent" is never stored - the transactions table is the source of truth.
const getBudgetsWithSpending = async (userId, month, year) => {
  const { start, end } = monthRange(month, year);
  // Previous calendar month, for the "MoM Variance" comparison.
  const prevDate = new Date(Date.UTC(year, month - 2, 1));
  const prev = monthRange(prevDate.getUTCMonth() + 1, prevDate.getUTCFullYear());

  const [budgets, spentRows, prevSpentRows] = await Promise.all([
    prisma.budget.findMany({ where: { userId, month, year }, orderBy: { createdAt: 'asc' } }),
    prisma.transaction.groupBy({
      by: ['category'],
      where: { userId, type: 'EXPENSE', date: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ['category'],
      where: { userId, type: 'EXPENSE', date: { gte: prev.start, lt: prev.end } },
      _sum: { amount: true },
    }),
  ]);

  const spentByCategory = new Map(spentRows.map((r) => [r.category, toNumber(r._sum.amount) || 0]));
  const prevSpentByCategory = new Map(prevSpentRows.map((r) => [r.category, toNumber(r._sum.amount) || 0]));

  return budgets.map((b) => {
    const limit = toNumber(b.limit);
    const spent = spentByCategory.get(b.category) || 0;
    const prevSpent = prevSpentByCategory.get(b.category) || 0;
    const momChangePercent = prevSpent > 0
      ? Math.round(((spent - prevSpent) / prevSpent) * 1000) / 10
      : (spent > 0 ? 100 : 0);
    return {
      id: b.id,
      category: b.category,
      limit,
      month: b.month,
      year: b.year,
      spent,
      remaining: limit - spent,
      percentage: Math.round((spent / limit) * 100),
      isOverBudget: spent > limit,
      overBy: spent > limit ? spent - limit : 0,
      prevSpent,
      momChangePercent,
    };
  });
};

const getBudgetSummary = async (userId, month, year) => {
  const budgets = await getBudgetsWithSpending(userId, month, year);
  const totalLimit = budgets.reduce((s, b) => s + b.limit, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spent, 0);
  return {
    month,
    year,
    totalLimit,
    totalSpent,
    totalRemaining: totalLimit - totalSpent,
    percentage: totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0,
    isOverBudget: totalSpent > totalLimit,
    budgets,
  };
};

module.exports = { monthRange, getBudgetsWithSpending, getBudgetSummary };
