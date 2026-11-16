const prisma = require('../config/prisma');
const { toNumber } = require('../utils/serialize');
const { Prisma } = require('@prisma/client');
const { monthRange, resolveAnalyticsPeriod, DAY_MS, addDays, isoDay } = require('../utils/dateRange');
const { round2, savingsRate, percentChange } = require('../utils/finance');

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

// ---------------------------------------------------------------------------
// Phase 5 - period-based analytics overview
// ---------------------------------------------------------------------------

// Per-category totals for one transaction type inside [start, end). Done in the database.
const categoryTotals = async (userId, type, start, end) => {
  const rows = await prisma.transaction.groupBy({
    by: ['category'],
    where: { userId, type, date: { gte: start, lt: end } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return rows.map((r) => ({ category: r.category, amount: round2(toNumber(r._sum.amount) || 0), count: r._count._all }));
};

// Income/expense per day (ranges up to 31 days) or per calendar month (longer ranges),
// aggregated by Postgres. Empty buckets are filled with zeros so the x-axis is continuous;
// a zero here is a real "nothing recorded", not invented data.
const timeSeries = async (userId, start, end) => {
  const days = Math.round((end - start) / DAY_MS);
  const granularity = days <= 31 ? 'day' : 'month';
  const unit = granularity === 'day' ? Prisma.sql`'day'` : Prisma.sql`'month'`;

  // Bounds go in as zone-less strings cast to timestamp: "date" is timestamp WITHOUT time zone, and a
  // timestamptz parameter would be shifted by the DB session timezone, dropping rows at the range edges.
  const startTs = start.toISOString().slice(0, 19).replace("T", " ");
  const endTs = end.toISOString().slice(0, 19).replace("T", " ");
  const rows = await prisma.$queryRaw`
    SELECT date_trunc(${unit}, "date") AS bucket, "type"::text AS type, SUM("amount") AS total
    FROM "Transaction"
    WHERE "userId" = ${userId} AND "date" >= ${startTs}::timestamp AND "date" < ${endTs}::timestamp
    GROUP BY 1, 2`;

  const totals = new Map();
  rows.forEach((r) => {
    const key = isoDay(new Date(r.bucket));
    const entry = totals.get(key) || { income: 0, expense: 0 };
    entry[r.type === 'INCOME' ? 'income' : 'expense'] = round2(Number(r.total));
    totals.set(key, entry);
  });

  const buckets = [];
  if (granularity === 'day') {
    for (let d = new Date(start); d < end; d = addDays(d, 1)) buckets.push(new Date(d));
  } else {
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); d < end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      buckets.push(new Date(d));
    }
  }

  const points = buckets.map((b) => {
    const key = isoDay(b);
    const t = totals.get(key) || { income: 0, expense: 0 };
    const label = granularity === 'day'
      ? `${MONTH_LABELS[b.getUTCMonth()]} ${b.getUTCDate()}`
      : `${MONTH_LABELS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
    return { key, label, income: t.income, expense: t.expense, savings: round2(t.income - t.expense) };
  });
  return { granularity, points };
};

const metricComparison = (name, current, previous, previousHasData, { higherIsBetter }) => {
  // A comparison is only meaningful if the previous period actually has recorded transactions.
  if (!previousHasData) {
    return {
      current, previous, change: null, changePercent: null, direction: null, sufficient: false,
      message: `No transactions in the previous period, so ${name.toLowerCase()} can't be compared.`,
    };
  }
  const change = round2(current - previous);
  const percent = percentChange(current, previous);
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const verb = direction === 'up' ? 'increased' : 'decreased';
  let message;
  if (direction === 'flat') message = `${name} are unchanged from the previous period.`;
  else if (percent === null) message = `${name} ${verb} by ৳${Math.abs(change).toLocaleString()} (the previous period was ৳${previous.toLocaleString()}, so no percentage is shown).`;
  else message = `${name} ${verb} by ${Math.abs(percent)}%.`;
  return {
    current, previous, change, changePercent: percent, direction, sufficient: true, message,
    favourable: direction === 'flat' ? null : (direction === 'up') === higherIsBetter,
  };
};

// One call powering the whole Analytics page, for the authenticated user only.
const getAnalyticsOverview = async (userId, { period, startDate, endDate }) => {
  const p = resolveAnalyticsPeriod(period, startDate, endDate);

  const [cur, prev, expCats, prevExpCats, incCats, series, totalTx, curCount, prevCount] = await Promise.all([
    sumByType(userId, p.start, p.end),
    sumByType(userId, p.prevStart, p.prevEnd),
    categoryTotals(userId, 'EXPENSE', p.start, p.end),
    categoryTotals(userId, 'EXPENSE', p.prevStart, p.prevEnd),
    categoryTotals(userId, 'INCOME', p.start, p.end),
    timeSeries(userId, p.start, p.end),
    prisma.transaction.count({ where: { userId } }),
    prisma.transaction.count({ where: { userId, date: { gte: p.start, lt: p.end } } }),
    prisma.transaction.count({ where: { userId, date: { gte: p.prevStart, lt: p.prevEnd } } }),
  ]);

  const income = round2(cur.income);
  const expense = round2(cur.expense);
  const savings = round2(income - expense);
  const prevIncome = round2(prev.income);
  const prevExpense = round2(prev.expense);
  const prevSavings = round2(prevIncome - prevExpense);
  const prevHas = prevCount > 0;

  const withShare = (list, total) => list
    .map((c) => ({ ...c, percentage: total > 0 ? Math.round((c.amount / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.amount - a.amount);
  const expenseCategories = withShare(expCats, expense);
  const incomeCategories = withShare(incCats, income);

  // Category-level changes (expenses) - only when the previous period has data.
  const prevByCat = new Map(prevExpCats.map((c) => [c.category, c.amount]));
  const categoryChanges = prevHas
    ? [
      ...expenseCategories.map((c) => {
        const before = prevByCat.get(c.category) || 0;
        return { category: c.category, current: c.amount, previous: before, change: round2(c.amount - before), changePercent: percentChange(c.amount, before) };
      }),
      ...prevExpCats
        .filter((c) => !expenseCategories.some((e) => e.category === c.category))
        .map((c) => ({ category: c.category, current: 0, previous: c.amount, change: round2(-c.amount), changePercent: -100 })),
    ]
      .filter((c) => c.change !== 0)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 5)
      .map((c) => ({ ...c, message: `${c.category} spending ${c.change > 0 ? 'increased' : 'decreased'} by ৳${Math.abs(c.change).toLocaleString()}.` }))
    : [];

  return {
    period,
    label: p.label,
    range: p.range,
    previousRange: p.previousRange,
    granularity: series.granularity,
    hasAnyTransactions: totalTx > 0,
    hasData: curCount > 0,
    transactionCount: curCount,
    summary: { income, expense, savings, savingsRate: savingsRate(income, expense) },
    previousSummary: prevHas
      ? { income: prevIncome, expense: prevExpense, savings: prevSavings, savingsRate: savingsRate(prevIncome, prevExpense) }
      : null,
    comparison: {
      available: prevHas,
      income: metricComparison('Income', income, prevIncome, prevHas, { higherIsBetter: true }),
      expense: metricComparison('Expenses', expense, prevExpense, prevHas, { higherIsBetter: false }),
      savings: metricComparison('Savings', savings, prevSavings, prevHas, { higherIsBetter: true }),
      categories: categoryChanges,
    },
    series: series.points,
    expenseCategories,
    incomeCategories,
    topCategories: expenseCategories.slice(0, 5),
  };
};

module.exports = { getMonthlyIncomeExpense, getCategoryBreakdown, getSpendingForecast, sumByType, getAnalyticsOverview, categoryTotals, timeSeries, metricComparison };
