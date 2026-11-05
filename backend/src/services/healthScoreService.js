const prisma = require('../config/prisma');
const { timeSeries } = require('./analyticsService');
const { getBudgetsWithSpending } = require('./budgetService');
const derivedCache = require('./derivedCache');
const { startOfUtcDay, addDays, addMonths, isoDay, DAY_MS } = require('../utils/dateRange');
const { round1, round2 } = require('../utils/finance');

// ===========================================================================
// FINANCIAL HEALTH SCORE  -  an educational indicator, NOT financial advice.
//
// ALL tunable numbers live in MODEL below; every formula is documented in backend/README.md
// ("Financial Health Score") and is applied identically for today's score and for each point of the
// score history (history is recomputed "as of" a past date from the data that existed then).
//
// score = round( earned points / evaluable points * 100 )
//   - a component is "evaluable" only if the user has the data it needs (rules below);
//   - a component that cannot be evaluated is left OUT of both sides - it is never scored as 0;
//   - the score is unavailable unless  >= MIN_TRANSACTIONS_90D  transactions exist in the last 90 days
//     AND the evaluable components add up to >= MIN_EVALUABLE_POINTS of the 100 nominal points.
// ===========================================================================
const MODEL = {
  version: 1,
  weights: { budget: 30, savingsRate: 25, stability: 20, goals: 15, tracking: 10 },
  minTransactions90d: 10,
  minEvaluablePoints: 35,
  levels: [[80, 'Excellent'], [60, 'Good'], [40, 'Fair'], [0, 'Needs Improvement']],
  windowMonths: 3,                 // savings rate looks at this month + the 2 before it
  budget: { healthyUpTo: 70, fullUpTo: 100, zeroAt: 150, scoreAtLimit: 0.6 }, // usage % breakpoints
  savingsRate: { zeroAt: 0, fullAt: 20 },            // savings rate % that earns 0 / full points
  stability: { minMonths: 3, maxMonths: 6, fullCv: 0.15, zeroCv: 0.6 },
  goals: { graceFraction: 0.1, recentCompletionDays: 90 },
  tracking: { weeks: 12, minWeeks: 4 },
  historyMonths: 6,
};

const NAMES = {
  budget: 'Budget Management',
  savingsRate: 'Savings Rate',
  stability: 'Expense Stability',
  goals: 'Savings Goal Progress',
  tracking: 'Financial Tracking Consistency',
};

const money = (n) => `৳${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const monthKey = (d) => isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
const levelFor = (score) => MODEL.levels.find(([min]) => score >= min)[1];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const unavailable = (key, explanation, suggestion) => ({
  key, name: NAMES[key], maxPoints: MODEL.weights[key], eligible: false, earned: null, ratio: null, explanation, suggestion,
});
const scored = (key, ratio, explanation, suggestion, details) => ({
  key, name: NAMES[key], maxPoints: MODEL.weights[key], eligible: true,
  earned: round1(ratio * MODEL.weights[key]), ratio: round2(ratio), explanation, suggestion, details,
});

// ---------------------------------------------------------------------------
// Component calculations. `ctx` = { asOf, isCurrent, months (Map monthKey->{income,expense}), data }
// ---------------------------------------------------------------------------

// 1. BUDGET MANAGEMENT (30)
//    Considers budgets whose date range overlaps the evaluation window (this month + the 2 before it).
//    For each budget, usage = spent / limit * 100 and
//      usage <= 70%        -> 1.00
//      70% .. 100%         -> falls linearly from 1.00 to 0.60
//      100% .. 150%        -> falls linearly from 0.60 to 0
//      >= 150%             -> 0
//    Component ratio = average over those budgets. In a historical (as-of) score only budgets that had
//    already ended, and already existed, on that date are counted, because their result was final.
const budgetFraction = (usage) => {
  const b = MODEL.budget;
  if (usage <= b.healthyUpTo) return 1;
  if (usage <= b.fullUpTo) return 1 - (1 - b.scoreAtLimit) * ((usage - b.healthyUpTo) / (b.fullUpTo - b.healthyUpTo));
  if (usage < b.zeroAt) return b.scoreAtLimit * (1 - (usage - b.fullUpTo) / (b.zeroAt - b.fullUpTo));
  return 0;
};

const budgetComponent = (ctx) => {
  const { asOf, isCurrent, windowStart, data } = ctx;
  const rel = data.budgets.filter((b) => b.limit > 0
    && b.startDate <= asOf && b.endDate >= windowStart
    && b.createdAt < addDays(asOf, 1)
    && (isCurrent || b.endDate <= asOf));
  if (rel.length === 0) {
    return unavailable('budget', 'Not evaluated: you have no budgets covering the last 3 months.',
      'Create a budget for a category you spend on regularly to unlock this part of the score.');
  }
  const usages = rel.map((b) => (b.spent / b.limit) * 100);
  const ratio = mean(usages.map(budgetFraction));
  const within = usages.filter((u) => u <= MODEL.budget.fullUpTo).length;
  const over = rel.length - within;
  const avgUsage = Math.round(mean(usages));
  const explanation = over === 0
    ? `All ${rel.length} budget${rel.length > 1 ? 's' : ''} in the last 3 months ${rel.length > 1 ? 'are' : 'is'} within the limit (average usage ${avgUsage}%).`
    : `${within} of ${rel.length} budget${rel.length > 1 ? 's are' : ' is'} within the limit and ${over} ${over > 1 ? 'are' : 'is'} over it (average usage ${avgUsage}%).`;
  const suggestion = ratio >= 0.8 ? 'Keep reviewing your budgets as your spending changes.'
    : 'Look at the budgets that are over their limit - you might lower that spending or adjust the limit if it is unrealistic.';
  return scored('budget', ratio, explanation, suggestion, { budgets: rel.length, withinLimit: within, overLimit: over, averageUsagePercent: avgUsage });
};

// 2. SAVINGS RATE (25)
//    rate = (income - expenses) / income * 100 over this month + the 2 before it.
//    rate <= 0% -> 0 points, rate >= 20% -> full points, linear in between.
//    No income in the window -> not evaluable (a rate can't be calculated; this is NOT treated as 0%).
const savingsRateComponent = (ctx) => {
  const keys = [0, 1, 2].map((i) => monthKey(addMonths(ctx.asOf, -i)));
  const income = keys.reduce((s, k) => s + (ctx.months.get(k)?.income || 0), 0);
  const expense = keys.reduce((s, k) => s + (ctx.months.get(k)?.expense || 0), 0);
  if (income <= 0) {
    return unavailable('savingsRate', 'Not evaluated: no income was recorded in the last 3 months, so a savings rate cannot be calculated.',
      'Record your income as INCOME transactions so your savings rate can be measured.');
  }
  const rate = ((income - expense) / income) * 100;
  const { zeroAt, fullAt } = MODEL.savingsRate;
  const ratio = clamp01((rate - zeroAt) / (fullAt - zeroAt));
  const r = round1(rate);
  const explanation = rate < 0
    ? `You spent ${money(expense - income)} more than you earned over the last 3 months (savings rate ${r}%).`
    : `You saved ${r}% of your income over the last 3 months (${money(income - expense)} of ${money(income)}). ${fullAt}% or more earns full points.`;
  const suggestion = rate >= fullAt ? 'Your savings rate is strong - consider directing some of it to a savings goal.'
    : 'Try setting a monthly savings target, even a small one, and see how your rate changes.';
  return scored('savingsRate', ratio, explanation, suggestion, { income: round2(income), expenses: round2(expense), savingsRatePercent: r });
};

// 3. EXPENSE STABILITY (20)
//    Looks at up to 6 COMPLETED months before the evaluation month; needs at least 3 months with expenses.
//    Measure = coefficient of variation (standard deviation / mean) of monthly values:
//      - if every one of those months also has income, the value is expenses / income (so spending that
//        simply grows with income is not penalised);
//      - otherwise the value is the monthly expense total.
//    CV <= 0.15 -> full points, CV >= 0.60 -> 0, linear in between.
//    Higher spending is never penalised on its own - only how much it swings from month to month.
const stabilityComponent = (ctx) => {
  const keys = [];
  for (let i = 1; i <= MODEL.stability.maxMonths; i += 1) keys.push(monthKey(addMonths(ctx.asOf, -i)));
  const rows = keys.map((k) => ({ k, ...(ctx.months.get(k) || { income: 0, expense: 0 }) })).filter((r) => r.expense > 0);
  if (rows.length < MODEL.stability.minMonths) {
    return unavailable('stability', `Not evaluated: stability needs at least ${MODEL.stability.minMonths} completed months with expenses (you have ${rows.length}).`,
      'Keep recording your expenses - this unlocks after a few full months of history.');
  }
  const useRatio = rows.every((r) => r.income > 0);
  const values = rows.map((r) => (useRatio ? r.expense / r.income : r.expense));
  const mu = mean(values);
  const sd = Math.sqrt(mean(values.map((v) => (v - mu) ** 2)));
  const cv = mu > 0 ? sd / mu : 0;
  const { fullCv, zeroCv } = MODEL.stability;
  const ratio = clamp01((zeroCv - cv) / (zeroCv - fullCv));
  const explanation = `Over the last ${rows.length} completed months your ${useRatio ? 'spending as a share of income' : 'monthly spending'} varied by about ${Math.round(cv * 100)}% (lower is steadier; ${Math.round(fullCv * 100)}% or less earns full points).`;
  const suggestion = ratio >= 0.8 ? 'Your spending pattern is steady - that makes planning easier.'
    : 'Look at the months where spending jumped; a one-off cost is normal, but regular large swings can make budgeting harder.';
  return scored('stability', ratio, explanation, suggestion, { months: rows.length, basis: useRatio ? 'expenses/income' : 'expenses', variationPercent: Math.round(cv * 100) });
};

// 4. SAVINGS GOAL PROGRESS (15)
//    Goals counted: goals that already existed on the evaluation date and either
//      - have a target date (so progress can be judged against time), or
//      - were completed within the last 90 days.
//    Goals with no target date and not completed are skipped (no way to judge pace) - not scored as 0.
//    Per goal:  completed -> 1.
//               otherwise expected = share of the time between creation and target date that has passed;
//               expected < 10% (a grace period) -> 1;  else min(1, actual progress / expected).
//    Overdue goals have expected = 100%, so their score is simply their progress fraction.
//    saved amounts use only contributions dated on/before the evaluation date. Component = average.
const goalsComponent = (ctx) => {
  const { asOf, data } = ctx;
  const items = [];
  data.goals.forEach((g) => {
    if (g.createdAt >= addDays(asOf, 1)) return;
    const contribs = g.contributions.filter((c) => c.date <= asOf).sort((a, b) => a.date - b.date);
    let saved = 0; let completedOn = null;
    contribs.forEach((c) => { saved += c.amount; if (completedOn === null && saved >= g.target) completedOn = c.date; });
    const completed = saved >= g.target;
    if (completed) {
      if ((asOf - completedOn) / DAY_MS <= MODEL.goals.recentCompletionDays) items.push({ g, saved, state: 'completed', fraction: 1 });
      return;
    }
    if (!g.targetDate) return;
    const created = startOfUtcDay(g.createdAt);
    const total = Math.max(g.targetDate - created, DAY_MS);
    const expected = clamp01((asOf - created) / total);
    const actual = clamp01(saved / g.target);
    const fraction = expected < MODEL.goals.graceFraction ? 1 : Math.min(1, actual / expected);
    items.push({ g, saved, state: g.targetDate < asOf ? 'overdue' : 'active', fraction, expected, actual });
  });
  if (items.length === 0) {
    return unavailable('goals', 'Not evaluated: you have no savings goals with a target date (or recently completed) to measure.',
      'Create a savings goal with a target date and add contributions to see how you are pacing.');
  }
  const ratio = mean(items.map((i) => i.fraction));
  const done = items.filter((i) => i.state === 'completed').length;
  const overdue = items.filter((i) => i.state === 'overdue').length;
  const onPace = items.filter((i) => i.state === 'active' && i.fraction >= 0.999).length;
  const behind = items.filter((i) => i.state === 'active' && i.fraction < 0.999).length;
  const parts = [];
  if (done) parts.push(`${done} completed`);
  if (onPace) parts.push(`${onPace} on pace`);
  if (behind) parts.push(`${behind} behind pace`);
  if (overdue) parts.push(`${overdue} past the target date`);
  const explanation = `${items.length} goal${items.length > 1 ? 's' : ''} evaluated: ${parts.join(', ')}. Pace compares the amount saved with how much of the time to the target date has passed.`;
  const suggestion = ratio >= 0.8 ? 'Your goals are progressing well.'
    : 'A regular contribution (even a small one) can help goals that are behind; you can also move a target date if your plans changed.';
  return scored('goals', ratio, explanation, suggestion, { goals: items.length, completed: done, onPace, behindPace: behind, pastTargetDate: overdue });
};

// 5. FINANCIAL TRACKING CONSISTENCY (10)
//    Splits the last 12 weeks (or, for newer users, the weeks since the first transaction, minimum 4)
//    into 7-day buckets. Score = share of those weeks that contain at least one transaction.
//    Only whether a week has activity matters - recording many transactions in a week earns nothing extra.
const trackingComponent = (ctx) => {
  const { asOf, data } = ctx;
  if (!data.firstTx || data.firstTx > asOf) {
    return unavailable('tracking', 'Not evaluated: no transactions have been recorded yet.', 'Record your income and expenses regularly.');
  }
  const weeksSinceFirst = Math.floor(((asOf - data.firstTx) / DAY_MS + 1) / 7);
  const weeks = Math.min(MODEL.tracking.weeks, weeksSinceFirst);
  if (weeks < MODEL.tracking.minWeeks) {
    return unavailable('tracking', `Not evaluated: this needs at least ${MODEL.tracking.minWeeks} weeks of history (you have ${Math.max(weeksSinceFirst, 0)}).`,
      'Keep recording transactions - this unlocks after a few weeks.');
  }
  const active = new Set();
  data.dayCounts.forEach((_, day) => {
    const d = new Date(`${day}T00:00:00.000Z`);
    const idx = Math.floor((asOf - d) / DAY_MS / 7);
    if (d <= asOf && idx >= 0 && idx < weeks) active.add(idx);
  });
  const ratio = active.size / weeks;
  const explanation = `You recorded transactions in ${active.size} of the last ${weeks} weeks.`;
  const suggestion = ratio >= 0.8 ? 'Your records are consistent.'
    : 'Recording transactions a little more often (even weekly) gives every part of FinTrack more accurate numbers.';
  return scored('tracking', ratio, explanation, suggestion, { weeksEvaluated: weeks, weeksWithActivity: active.size });
};

// ---------------------------------------------------------------------------
// One evaluation (today or any past date)
// ---------------------------------------------------------------------------
const evaluate = (data, asOf, isCurrent) => {
  const ctx = { asOf, isCurrent, months: data.months, data, windowStart: addMonths(asOf, -(MODEL.windowMonths - 1)) };
  ctx.windowStart = new Date(Date.UTC(ctx.windowStart.getUTCFullYear(), ctx.windowStart.getUTCMonth(), 1));

  let txn90 = 0;
  const from = addDays(asOf, -90);
  data.dayCounts.forEach((n, day) => { const d = new Date(`${day}T00:00:00.000Z`); if (d > from && d <= asOf) txn90 += n; });

  const components = [
    budgetComponent(ctx), savingsRateComponent(ctx), stabilityComponent(ctx), goalsComponent(ctx), trackingComponent(ctx),
  ];
  const evaluable = components.filter((c) => c.eligible);
  const evaluablePoints = evaluable.reduce((s, c) => s + c.maxPoints, 0);
  const earnedPoints = round1(evaluable.reduce((s, c) => s + c.earned, 0));

  let available = true; let reason = null;
  if (txn90 < MODEL.minTransactions90d) {
    available = false; reason = `At least ${MODEL.minTransactions90d} transactions in the last 90 days are needed (you have ${txn90}).`;
  } else if (evaluablePoints < MODEL.minEvaluablePoints) {
    available = false; reason = `At least ${MODEL.minEvaluablePoints} of the 100 points must be measurable from your data (currently ${evaluablePoints}).`;
  }
  const score = available ? Math.round((earnedPoints / evaluablePoints) * 100) : null;
  return { asOf, available, reason, score, level: score === null ? null : levelFor(score), components, evaluablePoints, earnedPoints, evaluatedCount: evaluable.length, transactions90d: txn90 };
};

// ---------------------------------------------------------------------------
// Data loading (a handful of queries, shared by today's score and the whole history)
// ---------------------------------------------------------------------------
const loadData = async (userId, today) => {
  const histStart = addMonths(today, -(MODEL.historyMonths + MODEL.stability.maxMonths));
  const dayFrom = addDays(today, -(MODEL.historyMonths * 31 + 90 + MODEL.tracking.weeks * 7));

  const [series, days, first, budgets, goals] = await Promise.all([
    timeSeries(userId, new Date(Date.UTC(histStart.getUTCFullYear(), histStart.getUTCMonth(), 1)), addDays(today, 1)),
    prisma.transaction.groupBy({ by: ['date'], where: { userId, date: { gte: dayFrom, lt: addDays(today, 1) } }, _count: { _all: true } }),
    prisma.transaction.aggregate({ where: { userId }, _min: { date: true } }),
    getBudgetsWithSpending(userId),
    prisma.savingsGoal.findMany({ where: { userId }, include: { contributions: { select: { amount: true, date: true } } } }),
  ]);

  const months = new Map(series.points.map((p) => [p.key, { income: p.income, expense: p.expense }]));
  const dayCounts = new Map(days.map((r) => [isoDay(r.date), r._count._all]));
  return {
    months,
    dayCounts,
    firstTx: first._min.date ? startOfUtcDay(first._min.date) : null,
    budgets: budgets.map((b) => ({ ...b, startDate: startOfUtcDay(b.startDate), endDate: startOfUtcDay(b.endDate) })),
    goals: goals.map((g) => ({
      createdAt: g.createdAt,
      target: Number(g.targetAmount),
      targetDate: g.targetDate ? startOfUtcDay(g.targetDate) : null,
      contributions: g.contributions.map((c) => ({ amount: Number(c.amount), date: startOfUtcDay(c.date) })),
    })),
  };
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const compute = async (userId) => {
  const now = new Date();
  const today = startOfUtcDay(now);
  const data = await loadData(userId, today);
  const current = evaluate(data, today, true);

  // Score history: the score as it would have been calculated at the END of each of the previous months,
  // using only data dated on/before that day. A month is shown only if a score was possible then.
  const history = [];
  for (let i = MODEL.historyMonths; i >= 1; i -= 1) {
    const monthEnd = addDays(addMonths(today, -(i - 1)), -1); // last day of the month i months ago
    monthEnd.setUTCHours(0, 0, 0, 0);
    const r = evaluate(data, monthEnd, false);
    if (r.available) {
      history.push({ asOf: isoDay(monthEnd), label: `${MONTH_LABELS[monthEnd.getUTCMonth()]} ${monthEnd.getUTCFullYear()}`, score: r.score, level: r.level, componentsEvaluated: r.evaluatedCount });
    }
  }
  if (current.available) {
    history.push({ asOf: isoDay(today), label: 'Today', score: current.score, level: current.level, componentsEvaluated: current.evaluatedCount });
  }

  const evaluable = current.components.filter((c) => c.eligible);
  const strengths = current.available ? evaluable.filter((c) => c.ratio >= 0.8).map((c) => ({ key: c.key, name: c.name, text: c.explanation })) : [];
  const improvements = current.available ? evaluable.filter((c) => c.ratio <= 0.5).map((c) => ({ key: c.key, name: c.name, text: c.explanation })) : [];
  const suggestions = [
    ...(current.available ? evaluable.filter((c) => c.ratio < 0.8).map((c) => ({ key: c.key, text: c.suggestion })) : []),
    ...current.components.filter((c) => !c.eligible).map((c) => ({ key: c.key, text: c.suggestion })),
  ];

  const base = {
    asOf: isoDay(today),
    generatedAt: now.toISOString(),
    model: { version: MODEL.version, weights: MODEL.weights, minTransactions90d: MODEL.minTransactions90d, minEvaluablePoints: MODEL.minEvaluablePoints },
    disclaimer: 'This score is an educational indicator based only on the data you record in FinTrack. It is not professional financial advice or a universal measure of financial health.',
    components: current.components,
    history: history.length >= 2 ? history : [],
    historyMessage: history.length >= 2 ? null : 'Score history appears once a score can be calculated for at least two points in time.',
  };

  if (!current.available) {
    return {
      ...base,
      available: false,
      score: null,
      level: null,
      message: 'Your financial health score is not available yet.',
      requirement: current.reason,
      needs: current.components.filter((c) => !c.eligible).map((c) => ({ key: c.key, name: c.name, points: c.maxPoints, text: c.suggestion })),
      history: [],
      historyMessage: null,
      strengths: [], improvements: [], suggestions,
    };
  }
  return {
    ...base,
    available: true,
    score: current.score,
    level: current.level,
    basedOn: { componentsEvaluated: current.evaluatedCount, componentsTotal: 5, earnedPoints: current.earnedPoints, evaluablePoints: current.evaluablePoints },
    partial: current.evaluatedCount < 5,
    strengths, improvements, suggestions,
  };
};

const getHealthScore = (userId) => derivedCache.cached(userId, 'health', () => compute(userId));

module.exports = { getHealthScore, MODEL, budgetFraction };
