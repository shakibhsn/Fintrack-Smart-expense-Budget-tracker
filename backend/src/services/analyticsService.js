const prisma = require('../config/prisma');
const { toNumber } = require('../utils/serialize');
const { monthRange } = require('../utils/dateRange');

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

// Expense breakdown by category within an arbitrary [start, end) date range, with the
// percentage of that range's total expenses and the % change vs. an equal-length window
// immediately before it. Used by the dashboard donut chart (whatever range the selected
// period resolves to - this month/last month/this year, so it always matches the summary
// cards shown next to it) and by GET /api/analytics/categories (a specific calendar month).
const getCategoryBreakdown = async (userId, start, end) => {
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - durationMs);

  const [rows, prevRows] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['category'],
      where: { userId, type: 'EXPENSE', date: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ['category'],
      where: { userId, type: 'EXPENSE', date: { gte: prevStart, lt: prevEnd } },
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
