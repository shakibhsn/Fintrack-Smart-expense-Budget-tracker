const prisma = require('../config/prisma');
const { toNumber } = require('../utils/serialize');
const { monthRange } = require('./budgetService');

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Sums INCOME and EXPENSE transactions inside [start, end) in a single query.
const sumByType = async (userId, start, end) => {
  const rows = await prisma.transaction.groupBy({
    by: ['type'],
    where: { userId, date: { gte: start, lt: end } },
    _sum: { amount: true },
  });
  const income = toNumber(rows.find((r) => r.type === 'INCOME')?._sum.amount) || 0;
  const expense = toNumber(rows.find((r) => r.type === 'EXPENSE')?._sum.amount) || 0;
  return { income, expense };
};

// Trailing `months` calendar months (oldest first, current month last).
const getMonthlyIncomeExpense = async (userId, months = 6) => {
  const now = new Date();
  const periods = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push({ month: d.getUTCMonth() + 1, year: d.getUTCFullYear() });
  }

  return Promise.all(
    periods.map(async ({ month, year }) => {
      const { start, end } = monthRange(month, year);
      const { income, expense } = await sumByType(userId, start, end);
      return { month, year, label: MONTH_LABELS[month - 1], income, expense };
    })
  );
};

// Expense breakdown by category for one calendar month, with the percentage
// of that month's total expenses and the % change vs. the previous month
// (used for both the dashboard donut chart and the Budgets "MoM Variance" panel).
const getCategoryBreakdown = async (userId, month, year) => {
  const { start, end } = monthRange(month, year);
  const prevDate = new Date(Date.UTC(year, month - 2, 1)); // month is 1-indexed
  const prev = monthRange(prevDate.getUTCMonth() + 1, prevDate.getUTCFullYear());

  const [rows, prevRows] = await Promise.all([
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

  const prevByCategory = new Map(prevRows.map((r) => [r.category, toNumber(r._sum.amount) || 0]));
  const total = rows.reduce((sum, r) => sum + (toNumber(r._sum.amount) || 0), 0);

  return rows
    .map((r) => {
      const amount = toNumber(r._sum.amount) || 0;
      const prevAmount = prevByCategory.get(r.category) || 0;
      const momChangePercent = prevAmount > 0
        ? Math.round(((amount - prevAmount) / prevAmount) * 1000) / 10
        : (amount > 0 ? 100 : 0);
      return {
        category: r.category,
        amount,
        percentage: total > 0 ? Math.round((amount / total) * 1000) / 10 : 0,
        prevAmount,
        momChangePercent,
      };
    })
    .sort((a, b) => b.amount - a.amount);
};

// A simple, honest forecast: this month's average daily spend, projected across the full month.
const getSpendingForecast = async (userId) => {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  const { start } = monthRange(month, year);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daysElapsed = Math.min(now.getUTCDate(), daysInMonth);

  const rows = await prisma.transaction.aggregate({
    where: { userId, type: 'EXPENSE', date: { gte: start, lte: now } },
    _sum: { amount: true },
  });
  const spentSoFar = toNumber(rows._sum.amount) || 0;
  const dailyAverage = daysElapsed > 0 ? spentSoFar / daysElapsed : 0;
  const projectedAmount = Math.round(dailyAverage * daysInMonth);
  // Reliability grows with how much of the month we've actually observed.
  const reliability = Math.min(99, Math.round((daysElapsed / daysInMonth) * 100));

  return { projectedAmount, dailyAverage: Math.round(dailyAverage), daysElapsed, daysInMonth, reliability };
};

module.exports = { getMonthlyIncomeExpense, getCategoryBreakdown, getSpendingForecast, sumByType };
