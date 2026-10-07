const asyncHandler = require('../utils/asyncHandler');
const { getMonthlyIncomeExpense, getCategoryBreakdown, getSpendingForecast } = require('../services/analyticsService');
const { monthlyQuerySchema, categoryQuerySchema } = require('../validators/periodValidators');
const { monthRange } = require('../utils/dateRange');

// GET /api/analytics/monthly?months=6
const getMonthly = asyncHandler(async (req, res) => {
  const { months } = monthlyQuerySchema.parse(req.query);
  const data = await getMonthlyIncomeExpense(req.user.id, months);
  res.json({ success: true, data });
});

// GET /api/analytics/categories?month=&year=
const getCategories = asyncHandler(async (req, res) => {
  const { month, year } = categoryQuerySchema.parse(req.query);
  const { start, end } = monthRange(month, year);
  const data = await getCategoryBreakdown(req.user.id, start, end);
  res.json({ success: true, data: { month, year, categories: data } });
});

// GET /api/analytics/income-expense - same trend data as /monthly, kept as its
// own endpoint per the API spec; the frontend calls whichever it needs.
const getIncomeExpense = asyncHandler(async (req, res) => {
  const { months } = monthlyQuerySchema.parse(req.query);
  const data = await getMonthlyIncomeExpense(req.user.id, months);
  res.json({ success: true, data });
});

// GET /api/analytics/forecast
const getForecast = asyncHandler(async (req, res) => {
  const data = await getSpendingForecast(req.user.id);
  res.json({ success: true, data });
});

module.exports = { getMonthly, getCategories, getIncomeExpense, getForecast };
