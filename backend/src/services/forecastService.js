const prisma = require('../config/prisma');
const { addMonths, startOfUtcDay } = require('../utils/dateRange');
const { round2, round1 } = require('../utils/finance');
const { cached } = require('./derivedCache');

// ---------------------------------------------------------------------------
// Phase 9 - spending forecast.
//
// Method (deliberately simple and explainable): a WEIGHTED MOVING AVERAGE over the user's most
// recent complete calendar months. With n months of history (oldest -> newest) month i gets weight
// i (1..n), so the newest month counts n times as much as the oldest:
//
//     predicted = sum(weight_i * value_i) / sum(weight_i)
//
// The same average is applied to total expenses, total income and each expense category.
// Savings = predicted income - predicted expenses (negative = deficit).
// Future months are projected flat at that value: no trend extrapolation, no invented seasonality.
// The current (incomplete) calendar month is never part of the model, only shown as "so far".
// ---------------------------------------------------------------------------

const AVG_DAYS_PER_MONTH = 30.4375;

const MODEL = {
  maxHistoryMonths: 6,      // complete months looked back
  minHistoryMonths: 2,      // below this: no forecast at all
  minExpenseTransactions: 8, // ... or fewer expense transactions than this in the window
  reliability: [            // by months of usable history
    { minMonths: 6, label: 'Sufficient Data' },
    { minMonths: 3, label: 'Moderate Data' },
    { minMonths: 2, label: 'Limited Data' },
  ],
  categoryMinActiveMonths: 2, // a category needs spending in >= 2 history months ...
  categoryMinTransactions: 3, // ... and >= 3 transactions, otherwise "insufficient data"
  trendThresholdPct: 5,
};

const PERIODS = {
  next_7_days: { label: 'Next 7 Days', days: 7, minMonths: 2 },
  next_30_days: { label: 'Next 30 Days', days: 30, minMonths: 2 },
  next_3_months: { label: 'Next 3 Months', months: 3, minMonths: 3 },
  next_6_months: { label: 'Next 6 Months', months: 6, minMonths: 6 },
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthKey = (d) => d.toISOString().slice(0, 7);
const monthLabel = (d) => `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// ----- pure math (exported for tests) -----
const weightedAverage = (values) => {
  const n = values.length;
  if (!n) return 0;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => { num += (i + 1) * v; den += i + 1; });
  return num / den;
};
const stdDev = (values) => {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

// Trend of a monthly series: mean of the newest floor(n/2) months vs the oldest floor(n/2).
const trendOf = (values) => {
  if (values.length < 2) return { direction: 'unknown', percent: null };
  const h = Math.floor(values.length / 2);
  const first = mean(values.slice(0, h));
  const last = mean(values.slice(-h));
  if (first <= 0) return { direction: last > 0 ? 'up' : 'stable', percent: null };
  const percent = round1(((last - first) / first) * 100);
  const direction = percent >= MODEL.trendThresholdPct ? 'up' : percent <= -MODEL.trendThresholdPct ? 'down' : 'stable';
  return { direction, percent };
};

const reliabilityFor = (months) => MODEL.reliability.find((r) => months >= r.minMonths)?.label || null;

// Scales a monthly amount to the requested forecast period. Day periods use the average month length.
const periodScale = (cfg) => (cfg.days ? cfg.days / AVG_DAYS_PER_MONTH : cfg.months);

// ----- data loading -----
const loadHistory = async (userId, now) => {
  const thisMonth = addMonths(startOfUtcDay(now), 0);
  const first = await prisma.transaction.aggregate({ where: { userId }, _min: { date: true } });
  const firstDate = first._min.date;
  if (!firstDate) return { months: [], thisMonth, rows: [] };

  const firstMonth = addMonths(startOfUtcDay(firstDate), 0);
  let windowStart = addMonths(thisMonth, -MODEL.maxHistoryMonths);
  if (firstMonth > windowStart) windowStart = firstMonth;

  const months = [];
  for (let d = windowStart; d < thisMonth; d = addMonths(d, 1)) months.push(d);

  const startTs = windowStart.toISOString().slice(0, 19).replace('T', ' ');
  const endTs = thisMonth.toISOString().slice(0, 19).replace('T', ' ');
  const rows = months.length
    ? await prisma.$queryRaw`
      SELECT date_trunc('month', "date") AS bucket, "type"::text AS type, "category",
             SUM("amount") AS total, COUNT(*)::int AS cnt
      FROM "Transaction"
      WHERE "userId" = ${userId} AND "date" >= ${startTs}::timestamp AND "date" < ${endTs}::timestamp
      GROUP BY 1, 2, 3`
    : [];
  return { months, thisMonth, rows };
};

const loadCurrentMonth = async (userId, thisMonth, now) => {
  const tomorrow = new Date(startOfUtcDay(now).getTime() + 86400000);
  const g = await prisma.transaction.groupBy({
    by: ['type'], where: { userId, date: { gte: thisMonth, lt: tomorrow } }, _sum: { amount: true },
  });
  const pick = (t) => round2(Number(g.find((r) => r.type === t)?._sum.amount || 0));
  return { income: pick('INCOME'), expense: pick('EXPENSE'), label: monthLabel(thisMonth) };
};

// ----- the forecast itself (pure over the loaded rows; exported for tests) -----
const buildForecast = ({ months, rows }, periodId, current = null) => {
  const cfg = PERIODS[periodId];
  const keys = months.map(monthKey);
  const series = (type) => keys.map((k) => rows.filter((r) => r.type === type && monthKey(new Date(r.bucket)) === k)
    .reduce((s, r) => s + Number(r.total), 0));
  const expenseSeries = series('EXPENSE');
  const incomeSeries = series('INCOME');
  const expenseTx = rows.filter((r) => r.type === 'EXPENSE').reduce((s, r) => s + r.cnt, 0);
  const n = months.length;

  const availablePeriods = Object.entries(PERIODS).map(([id, p]) => ({
    id,
    label: p.label,
    available: n >= p.minMonths && expenseTx >= MODEL.minExpenseTransactions,
    reason: n >= p.minMonths ? null : `Needs at least ${p.minMonths} complete months of history (you have ${n}).`,
  }));

  const dataAvailability = {
    monthsOfHistory: n,
    expenseTransactions: expenseTx,
    requirement: `At least ${MODEL.minHistoryMonths} complete calendar months of history and ${MODEL.minExpenseTransactions} expense transactions.`,
  };

  const base = { period: periodId, periodLabel: cfg.label, availablePeriods, dataAvailability, generatedAt: new Date().toISOString() };

  if (n < MODEL.minHistoryMonths || expenseTx < MODEL.minExpenseTransactions) {
    return { ...base, available: false, message: 'Not enough financial history to generate a reliable forecast.' };
  }
  if (n < cfg.minMonths) {
    return {
      ...base,
      available: false,
      message: `${cfg.label} needs at least ${cfg.minMonths} complete months of history (you have ${n}). Try a shorter period.`,
    };
  }

  const monthlyExpense = weightedAverage(expenseSeries);
  const monthlyIncome = weightedAverage(incomeSeries);
  const monthlySavings = monthlyIncome - monthlyExpense;
  const expenseSd = stdDev(expenseSeries);
  const incomeSd = stdDev(incomeSeries);
  const scale = periodScale(cfg);
  const spread = cfg.days ? scale : Math.sqrt(scale); // independent months: error grows with sqrt

  const periodExpense = monthlyExpense * scale;
  const periodIncome = monthlyIncome * scale;
  const periodSavings = periodIncome - periodExpense;

  // Per-category forecast: only for categories with enough real history; the rest say so.
  const cats = new Map();
  rows.filter((r) => r.type === 'EXPENSE').forEach((r) => {
    if (!cats.has(r.category)) cats.set(r.category, { values: keys.map(() => 0), tx: 0 });
    const c = cats.get(r.category);
    c.values[keys.indexOf(monthKey(new Date(r.bucket)))] += Number(r.total);
    c.tx += r.cnt;
  });
  const categories = [...cats.entries()].map(([category, c]) => {
    const activeMonths = c.values.filter((v) => v > 0).length;
    if (activeMonths < MODEL.categoryMinActiveMonths || c.tx < MODEL.categoryMinTransactions) {
      return {
        category, sufficient: false, activeMonths, transactions: c.tx,
        message: 'Insufficient data for this category (needs spending in at least 2 months and 3 transactions).',
      };
    }
    const m = weightedAverage(c.values);
    return {
      category, sufficient: true, activeMonths, transactions: c.tx,
      predictedMonthly: round2(m),
      predictedPeriod: round2(m * scale),
      sharePercent: monthlyExpense > 0 ? round1((m / monthlyExpense) * 100) : null,
      trend: trendOf(c.values),
    };
  }).sort((a, b) => (b.predictedMonthly || 0) - (a.predictedMonthly || 0) || a.category.localeCompare(b.category));

  const history = months.map((d, i) => ({
    month: monthKey(d), label: monthLabel(d),
    income: round2(incomeSeries[i]), expense: round2(expenseSeries[i]), savings: round2(incomeSeries[i] - expenseSeries[i]),
  }));
  const futureCount = cfg.months || 1;
  const lastMonth = months[n - 1];
  // Projection starts at the current calendar month (still in progress) and continues forward.
  const firstFuture = addMonths(lastMonth, 1);
  const projectionRows = Array.from({ length: futureCount }, (_, i) => {
    const d = addMonths(firstFuture, i);
    return {
      month: monthKey(d), label: monthLabel(d),
      income: round2(monthlyIncome), expense: round2(monthlyExpense), savings: round2(monthlySavings),
    };
  });

  const savingsRatePct = monthlyIncome > 0 ? round1((monthlySavings / monthlyIncome) * 100) : null;

  return {
    ...base,
    available: true,
    reliability: { label: reliabilityFor(n), ...dataAvailability },
    method: {
      name: 'Weighted moving average',
      description: `Average of your last ${n} complete month${n === 1 ? '' : 's'}, with recent months weighted more (weights 1..${n}). Future months are projected flat; this is an estimate, not a guarantee.`,
    },
    monthly: {
      expense: round2(monthlyExpense), income: round2(monthlyIncome), savings: round2(monthlySavings),
      savingsRatePercent: savingsRatePct,
      isDeficit: monthlySavings < 0,
      deficit: monthlySavings < 0 ? round2(-monthlySavings) : 0,
      expenseRange: { low: round2(Math.max(0, monthlyExpense - expenseSd)), high: round2(monthlyExpense + expenseSd) },
      incomeRange: { low: round2(Math.max(0, monthlyIncome - incomeSd)), high: round2(monthlyIncome + incomeSd) },
    },
    forecast: {
      expense: round2(periodExpense), income: round2(periodIncome), savings: round2(periodSavings),
      isDeficit: periodSavings < 0, deficit: periodSavings < 0 ? round2(-periodSavings) : 0,
      expenseRange: { low: round2(Math.max(0, periodExpense - expenseSd * spread)), high: round2(periodExpense + expenseSd * spread) },
    },
    trend: { expense: trendOf(expenseSeries), income: trendOf(incomeSeries) },
    categories,
    history,
    projection: projectionRows,
    currentMonth: current,
  };
};

const getForecast = (userId, periodId = 'next_30_days', now = new Date()) =>
  cached(userId, `forecast:${periodId}`, async () => {
    const data = await loadHistory(userId, now);
    const current = await loadCurrentMonth(userId, data.thisMonth, now);
    return buildForecast(data, periodId, current);
  });

module.exports = { getForecast, buildForecast, weightedAverage, stdDev, trendOf, MODEL, PERIODS, AVG_DAYS_PER_MONTH };
