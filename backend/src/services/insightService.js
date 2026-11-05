const prisma = require('../config/prisma');
const { sumByType, categoryTotals, timeSeries } = require('./analyticsService');
const { getBudgetsWithSpending } = require('./budgetService');
const { goalMetrics } = require('../utils/goalMetrics');
const { resolveAnalyticsPeriod, addMonths, addDays, startOfUtcDay, DAY_MS, isoDay } = require('../utils/dateRange');
const { round2, round1, savingsRate, percentChange } = require('../utils/finance');
const derivedCache = require('./derivedCache');
const { INITIAL_NOTES } = require('./goalService');

// ===========================================================================
// Rule-based insight engine. NOT AI/ML: every insight below comes from a fixed rule applied to the
// user's own transactions, budgets and goals. Each insight carries a `reason` that states the rule
// and numbers behind it, so the user can verify it.
//
// Windows (UTC): "this period" = 1st of this month .. today; "previous period" = the same number of
// days at the start of last month (like-for-like, so a half-finished month is never compared with a
// whole one). These are the same windows the Analytics page uses for "This Month".
//
// Minimum data: at least MIN_TRANSACTIONS transactions in the last 90 days, otherwise no insights.
// ===========================================================================
const MIN_TRANSACTIONS = 5;
const CHANGE_PCT_THRESHOLD = 10;   // category/overall change must be >= 10% to be worth mentioning
const UNUSUAL_RATIO = 1.5;         // category >= 150% of its own recent monthly average
const REPEAT_MIN_COUNT = 3;        // same title+category at least 3 times in 90 days...
const REPEAT_AMOUNT_SPREAD = 1.2;  // ...with amounts within 20% of each other
const PACE_MIN_CONTRIBUTIONS = 3;
const PACE_MIN_SPAN_DAYS = 30;

const money = (n) => `৳${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (n) => `${Math.abs(n)}%`;
const CATEGORIES = ['spending', 'budget', 'savings', 'habits', 'recommendations'];

const insight = (category, id, type, title, message, reason) => ({ id, category, type, title, message, reason });

const generate = async (userId) => {
  const now = new Date();
  const today = startOfUtcDay(now);
  const p = resolveAnalyticsPeriod('this_month', null, null, now);
  const since90 = addDays(today, -90);
  const sixMonthsStart = addMonths(p.start, -5);

  const [txCount90, cur, prev, curCats, prevCats, monthly, budgets, goals, contribs, repeats] = await Promise.all([
    prisma.transaction.count({ where: { userId, date: { gte: since90, lt: p.end } } }),
    sumByType(userId, p.start, p.end),
    sumByType(userId, p.prevStart, p.prevEnd),
    categoryTotals(userId, 'EXPENSE', p.start, p.end),
    categoryTotals(userId, 'EXPENSE', p.prevStart, p.prevEnd),
    timeSeries(userId, sixMonthsStart, p.end),
    getBudgetsWithSpending(userId),
    prisma.savingsGoal.findMany({ where: { userId } }),
    prisma.goalContribution.findMany({ where: { userId, date: { gte: since90 } }, select: { goalId: true, amount: true, date: true, note: true } }),
    prisma.transaction.groupBy({
      by: ['description', 'category'],
      where: { userId, type: 'EXPENSE', date: { gte: since90, lt: p.end } },
      _count: { _all: true },
      _sum: { amount: true },
      _min: { amount: true },
      _max: { amount: true },
    }),
  ]);

  const base = { generatedAt: now.toISOString(), period: { label: p.label, ...p.range }, previousPeriod: p.previousRange };

  if (txCount90 < MIN_TRANSACTIONS) {
    return {
      ...base,
      sufficient: false,
      message: 'Not enough financial data to generate insights yet.',
      requirement: `Insights need at least ${MIN_TRANSACTIONS} transactions recorded in the last 90 days (you have ${txCount90}).`,
      insights: [],
      groups: Object.fromEntries(CATEGORIES.map((c) => [c, []])),
    };
  }

  const out = [];
  const prevHasData = (await prisma.transaction.count({ where: { userId, date: { gte: p.prevStart, lt: p.prevEnd } } })) > 0;
  const income = round2(cur.income); const expense = round2(cur.expense);
  const prevIncome = round2(prev.income); const prevExpense = round2(prev.expense);
  const windowText = `${p.range.start} to ${p.range.end} vs ${p.previousRange.start} to ${p.previousRange.end}`;

  const curSorted = [...curCats].sort((a, b) => b.amount - a.amount);
  const prevByCat = new Map(prevCats.map((c) => [c.category, c.amount]));

  // ----------------------------- SPENDING -----------------------------
  if (curSorted.length >= 2 && expense > 0) {
    const top = curSorted[0];
    out.push(insight('spending', 'spending.top-category', 'info', 'Highest spending category',
      `${top.category} is your highest spending category this month (${money(top.amount)}, ${round1((top.amount / expense) * 100)}% of your expenses).`,
      `Largest expense-category total between ${p.range.start} and ${p.range.end}.`));
  }
  if (curSorted.length >= 3) {
    const low = curSorted[curSorted.length - 1];
    out.push(insight('spending', 'spending.lowest-category', 'info', 'Lowest spending category',
      `${low.category} is your lowest spending category this month (${money(low.amount)}).`,
      `Smallest expense-category total between ${p.range.start} and ${p.range.end}.`));
  }

  if (prevHasData && prevExpense > 0 && expense >= 0) {
    const change = percentChange(expense, prevExpense);
    if (change !== null && Math.abs(change) >= CHANGE_PCT_THRESHOLD) {
      const more = change > 0;
      out.push(insight('spending', 'spending.total-change', more ? 'warning' : 'positive', 'Overall spending change',
        `You spent ${pct(change)} ${more ? 'more' : 'less'} this month than in the previous period (${money(expense)} vs ${money(prevExpense)}).`,
        `(${money(expense)} − ${money(prevExpense)}) ÷ ${money(prevExpense)}. Compared like-for-like: ${windowText}.`));
    }
  }

  if (prevHasData) {
    const changes = curSorted.map((c) => ({ category: c.category, now: c.amount, before: prevByCat.get(c.category) || 0 }))
      .concat(prevCats.filter((c) => !curSorted.some((x) => x.category === c.category)).map((c) => ({ category: c.category, now: 0, before: c.amount })))
      .map((c) => ({ ...c, diff: round2(c.now - c.before), percent: percentChange(c.now, c.before) }))
      .filter((c) => c.before > 0 && c.diff !== 0 && Math.abs(c.percent) >= CHANGE_PCT_THRESHOLD)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 3);
    changes.forEach((c) => {
      const up = c.diff > 0;
      out.push(insight('spending', `spending.category-change.${c.category}`, up ? 'warning' : 'positive',
        `${c.category} spending ${up ? 'up' : 'down'}`,
        `Your ${c.category} expenses ${up ? 'increased' : 'decreased'} by ${money(Math.abs(c.diff))} (${pct(c.percent)}) compared with the previous period.`,
        `${c.category}: ${money(c.now)} now vs ${money(c.before)} before. ${windowText}.`));
    });
  }

  // ----------------------------- BUDGET -----------------------------
  const active = budgets.filter((b) => b.status === 'active');
  active.forEach((b) => {
    const range = `${isoDay(b.startDate)} to ${isoDay(b.endDate)}`;
    const reason = `${money(b.spent)} spent of a ${money(b.limit)} limit (${b.percentage}%), ${range}. Tiers: 70-89% warning, 90-100% critical, over 100% exceeded.`;
    if (b.isOverBudget) {
      out.push(insight('budget', `budget.over.${b.id}`, 'alert', `${b.category} budget exceeded`,
        `You exceeded your ${b.category} budget by ${money(b.overBy)}.`, reason));
    } else if (b.percentage >= 90) {
      out.push(insight('budget', `budget.critical.${b.id}`, 'warning', `${b.category} budget almost used`,
        `Your ${b.category} budget is almost exhausted (${b.percentage}% used, ${money(b.remaining)} left).`, reason));
    } else if (b.percentage >= 70) {
      out.push(insight('budget', `budget.warning.${b.id}`, 'warning', `${b.category} budget`,
        `You have used ${b.percentage}% of your ${b.category} budget (${money(b.remaining)} left).`, reason));
    }
  });
  if (active.length > 0 && active.every((b) => !b.isOverBudget && b.percentage < 70)) {
    out.push(insight('budget', 'budget.all-healthy', 'positive', 'Within budget',
      `Your current spending is within your budget${active.length > 1 ? 's' : ''}.`,
      `All ${active.length} active budget${active.length > 1 ? 's are' : ' is'} under 70% used.`));
  }

  // ----------------------------- SAVINGS -----------------------------
  const rate = savingsRate(income, expense);
  const prevRate = savingsRate(prevIncome, prevExpense);
  const savings = round2(income - expense);
  const prevSavings = round2(prevIncome - prevExpense);

  if (income > 0 && expense > income) {
    out.push(insight('savings', 'savings.negative', 'warning', 'Spending above income',
      `You have spent ${money(expense - income)} more than you earned this month.`,
      `Expenses ${money(expense)} − income ${money(income)} between ${p.range.start} and ${p.range.end}.`));
  }
  if (prevHasData && rate !== null && prevRate !== null) {
    const diff = round1(rate - prevRate);
    if (Math.abs(diff) >= 1) {
      out.push(insight('savings', 'savings.rate-change', diff > 0 ? 'positive' : 'warning', 'Savings rate',
        `Your savings rate ${diff > 0 ? 'improved' : 'dropped'} from ${prevRate}% to ${rate}% (${diff > 0 ? '+' : '−'}${Math.abs(diff)} points).`,
        `Savings rate = (income − expenses) ÷ income. ${windowText}.`));
    }
  }
  if (prevHasData && savings !== prevSavings && (income > 0 || prevIncome > 0)) {
    const d = round2(savings - prevSavings);
    out.push(insight('savings', 'savings.amount-change', d > 0 ? 'positive' : 'info', 'Savings compared with last month',
      `You saved ${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than in the previous period (${money(savings)} vs ${money(prevSavings)}).`,
      `Savings = income − expenses. ${windowText}.`));
  }

  // goals
  const goalItems = goals.map((g) => ({ g, m: goalMetrics(g, now) }));
  const contribsByGoal = new Map();
  contribs.filter((c) => !INITIAL_NOTES.includes(c.note)).forEach((c) => {
    if (!contribsByGoal.has(c.goalId)) contribsByGoal.set(c.goalId, []);
    contribsByGoal.get(c.goalId).push({ amount: Number(c.amount), date: startOfUtcDay(c.date) });
  });

  goalItems.filter((x) => x.m.status === 'in_progress').sort((a, b) => b.m.actualProgress - a.m.actualProgress).slice(0, 2).forEach(({ g, m }) => {
    out.push(insight('savings', `savings.goal-progress.${g.id}`, 'info', `Goal: ${g.title}`,
      `Your savings goal "${g.title}" is ${Math.round(m.progress)}% complete (${money(m.savedAmount)} of ${money(m.targetAmount)}).`,
      `Saved ÷ target × 100 = ${m.actualProgress}%.`));
  });
  goalItems.filter((x) => x.m.status === 'overdue').slice(0, 2).forEach(({ g, m }) => {
    out.push(insight('savings', `savings.goal-overdue.${g.id}`, 'warning', `Goal past its target date`,
      `"${g.title}" passed its target date (${isoDay(g.targetDate)}) with ${money(m.remaining)} still to save.`,
      `Target date is before today and saved (${money(m.savedAmount)}) is below target (${money(m.targetAmount)}).`));
  });
  goalItems.filter((x) => x.m.status === 'completed').slice(0, 2).forEach(({ g, m }) => {
    out.push(insight('savings', `savings.goal-completed.${g.id}`, 'positive', `Goal reached`,
      `You reached your "${g.title}" goal (${money(m.savedAmount)} saved of ${money(m.targetAmount)}).`,
      `Saved amount is at or above the target.`));
  });

  // pace estimate: only with enough contribution history
  goalItems.filter((x) => x.m.status === 'in_progress' || x.m.status === 'overdue').forEach(({ g, m }) => {
    const list = (contribsByGoal.get(g.id) || []).filter((c) => c.date <= today);
    if (list.length < PACE_MIN_CONTRIBUTIONS) return;
    const first = list.reduce((a, c) => (c.date < a ? c.date : a), list[0].date);
    const spanDays = Math.round((today - first) / DAY_MS);
    if (spanDays < PACE_MIN_SPAN_DAYS) return;
    const total = list.reduce((s, c) => s + c.amount, 0);
    const perDay = total / spanDays;
    if (perDay <= 0) return;
    const daysNeeded = Math.ceil(m.remaining / perDay);
    const eta = addDays(today, daysNeeded);
    const perMonth = round2(perDay * 30);
    const reason = `${list.length} contributions totalling ${money(total)} over the last ${spanDays} days (≈ ${money(perMonth)}/month); ${money(m.remaining)} remaining. This is an estimate that assumes the same pace.`;
    if (g.targetDate && eta > startOfUtcDay(g.targetDate)) {
      out.push(insight('savings', `savings.goal-pace.${g.id}`, 'warning', `Goal pace: ${g.title}`,
        `At your recent savings pace you may need more time to reach "${g.title}": about ${isoDay(eta)}, after your target date of ${isoDay(g.targetDate)}.`, reason));
    } else {
      out.push(insight('savings', `savings.goal-pace.${g.id}`, 'info', `Goal pace: ${g.title}`,
        `At your recent savings pace you may reach "${g.title}" around ${isoDay(eta)}${g.targetDate ? ', before your target date' : ''}.`, reason));
    }
  });

  // ----------------------------- HABITS -----------------------------
  // consecutive-month spending trend over the last full months that have data
  const fullMonths = monthly.points.filter((pt) => pt.key < isoDay(p.start) && (pt.expense > 0 || pt.income > 0)).slice(-3);
  if (fullMonths.length === 3) {
    const [a, b, c] = fullMonths.map((x) => x.expense);
    if (a < b && b < c) {
      out.push(insight('habits', 'habits.spending-rising', 'info', 'Rising monthly spending',
        `Your monthly spending rose for 3 months in a row: ${money(a)}, ${money(b)}, ${money(c)}.`,
        `Total expenses for ${fullMonths.map((x) => x.label).join(', ')}.`));
    } else if (a > b && b > c) {
      out.push(insight('habits', 'habits.spending-falling', 'positive', 'Falling monthly spending',
        `Your monthly spending fell for 3 months in a row: ${money(a)}, ${money(b)}, ${money(c)}.`,
        `Total expenses for ${fullMonths.map((x) => x.label).join(', ')}.`));
    }
  }

  // unusual category increase vs that category's own recent average (needs >= 2 prior months of data)
  const priorMonths = monthly.points.filter((pt) => pt.key < isoDay(p.start) && pt.expense > 0).slice(-3);
  if (priorMonths.length >= 2) {
    const priorStart = new Date(`${priorMonths[0].key}T00:00:00.000Z`);
    const priorCats = await categoryTotals(userId, 'EXPENSE', priorStart, p.start);
    const unusual = curSorted
      .map((c) => ({ ...c, avg: (priorCats.find((x) => x.category === c.category)?.amount || 0) / priorMonths.length }))
      .filter((c) => c.avg > 0 && c.amount >= c.avg * UNUSUAL_RATIO)
      .sort((a, b) => (b.amount - b.avg) - (a.amount - a.avg))
      .slice(0, 2);
    unusual.forEach((c) => {
      out.push(insight('habits', `habits.unusual-increase.${c.category}`, 'info', `${c.category} higher than usual`,
        `${c.category} spending so far this month (${money(c.amount)}) is already ${Math.round(((c.amount / c.avg) - 1) * 100)}% above your recent monthly average of ${money(round2(c.avg))}.`,
        `Average of the previous ${priorMonths.length} months with data. Flagged when this month to date is at least ${Math.round(UNUSUAL_RATIO * 100)}% of that average. A higher month can have ordinary causes.`));
    });
  }

  // repeated spending
  repeats
    .filter((r) => r._count._all >= REPEAT_MIN_COUNT && Number(r._min.amount) > 0 && Number(r._max.amount) / Number(r._min.amount) <= REPEAT_AMOUNT_SPREAD)
    .sort((a, b) => Number(b._sum.amount) - Number(a._sum.amount))
    .slice(0, 2)
    .forEach((r) => {
      const total = Number(r._sum.amount);
      out.push(insight('habits', `habits.repeat.${r.category}.${r.description}`, 'info', 'Repeated spending',
        `You spent on "${r.description}" (${r.category}) ${r._count._all} times in the last 90 days, about ${money(round2(total / r._count._all))} each (${money(total)} in total).`,
        `Same title and category at least ${REPEAT_MIN_COUNT} times with similar amounts.`));
    });

  // ----------------------------- RECOMMENDATIONS -----------------------------
  // Suggestions only - each one is tied to a rule above and phrased as an option, not a promise.
  const risingTop = out.find((i) => i.id.startsWith('spending.category-change.') && i.type === 'warning');
  if (risingTop) {
    const cat = risingTop.id.replace('spending.category-change.', '');
    out.push(insight('recommendations', `rec.review-category.${cat}`, 'suggestion', `Review ${cat} spending`,
      `Consider reviewing your ${cat} expenses this month.`, `${cat} spending is up compared with the previous period (see Spending).`));
  }
  const strained = active.filter((b) => b.isOverBudget || b.percentage >= 90);
  if (strained.length > 0) {
    const b = strained[0];
    out.push(insight('recommendations', `rec.adjust-budget.${b.id}`, 'suggestion', `Revisit your ${b.category} budget`,
      `Your ${b.category} budget may need adjustment, or spending in that category could be reduced.`, `It is ${b.isOverBudget ? 'over' : 'at 90% or more of'} its limit (${b.percentage}%).`));
  }
  if (budgets.length === 0 && curSorted.length > 0) {
    out.push(insight('recommendations', 'rec.set-budget', 'suggestion', 'Try a budget',
      `Setting a budget for ${curSorted[0].category}, your largest category, could help you keep track of it.`, 'You have no budgets yet.'));
  }
  if (rate !== null && rate < 10 && income > 0) {
    out.push(insight('recommendations', 'rec.savings-target', 'suggestion', 'Set a savings target',
      'Try setting a monthly savings target.', `Your savings rate this month is ${rate}%.`));
  }
  if (goals.length === 0 && income > 0) {
    out.push(insight('recommendations', 'rec.create-goal', 'suggestion', 'Create a savings goal',
      'A savings goal with a target amount can make it easier to see your progress.', 'You have no savings goals yet.'));
  }

  // De-duplicate by id (defensive: ids are deterministic so the same rule can never appear twice)
  const seen = new Set();
  const insights = out.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));

  const groups = Object.fromEntries(CATEGORIES.map((c) => [c, insights.filter((i) => i.category === c)]));
  return { ...base, sufficient: true, message: insights.length === 0 ? 'No notable changes to report for this period.' : null, insights, groups };
};

const getInsights = (userId) => derivedCache.cached(userId, 'insights', () => generate(userId));

module.exports = { getInsights, generateInsights: generate, MIN_TRANSACTIONS };
