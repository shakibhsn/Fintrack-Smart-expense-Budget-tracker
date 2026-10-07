const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { serializeTransaction } = require('../utils/serialize');
const { sumByType, getMonthlyIncomeExpense, getCategoryBreakdown } = require('../services/analyticsService');
const { dashboardQuerySchema } = require('../validators/periodValidators');

// Maps the frontend's period selector to an actual [start, end) date range.
// This exact range is used for BOTH the summary totals and the category
// breakdown, so the two numbers on screen always agree with each other -
// selecting "This Year" used to still show only this month's categories.
const resolvePeriod = (period) => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-indexed

  if (period === 'last_month') {
    const d = new Date(Date.UTC(y, m - 2, 1));
    const month = d.getUTCMonth() + 1;
    const year = d.getUTCFullYear();
    return {
      start: new Date(Date.UTC(year, month - 1, 1)),
      end: new Date(Date.UTC(year, month, 1)),
    };
  }
  if (period === 'year') {
    return {
      start: new Date(Date.UTC(y, 0, 1)),
      end: new Date(Date.UTC(y + 1, 0, 1)),
    };
  }
  // default: this month
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
};

// GET /api/dashboard?period=month|last_month|year
const getDashboard = asyncHandler(async (req, res) => {
  const { period } = dashboardQuerySchema.parse(req.query);
  const { start, end } = resolvePeriod(period);

  const [{ income, expense }, recentRows, categoryExpenses, monthlyIncomeExpense] = await Promise.all([
    sumByType(req.user.id, start, end),
    prisma.transaction.findMany({
      where: { userId: req.user.id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    }),
    getCategoryBreakdown(req.user.id, start, end),
    getMonthlyIncomeExpense(req.user.id, 6),
  ]);

  const balance = income - expense;
  const savingsRate = income > 0 ? Math.round((balance / income) * 1000) / 10 : 0;

  res.json({
    success: true,
    data: {
      period,
      summary: { totalIncome: income, totalExpense: expense, balance, savingsRate },
      recentTransactions: recentRows.map(serializeTransaction),
      categoryExpenses,
      monthlyIncomeExpense,
    },
  });
});

module.exports = { getDashboard };
