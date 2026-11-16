const crypto = require('crypto');
const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { toNumber } = require('../utils/serialize');
const { resolveAnalyticsPeriod, DAY_MS, isoDay, startOfUtcDay } = require('../utils/dateRange');
const { round2, savingsRate, percentChange } = require('../utils/finance');
const { sumByType, categoryTotals, timeSeries, metricComparison } = require('./analyticsService');
const { getBudgetsWithSpending } = require('./budgetService');
const subscriptions = require('./subscriptionService');

// ---------------------------------------------------------------------------
// Phase 15 - Monthly / periodic financial report.
//
// One function (buildReport) assembles everything from the database, using the SAME building blocks as Analytics and the
// Dashboard (sumByType, categoryTotals, timeSeries, resolveAnalyticsPeriod, metricComparison, getBudgetsWithSpending,
// subscriptionService.summary), so the numbers in a report always equal what those pages show for the same range.
//
// Rules this file keeps (and the tests check):
//  * Reports are DYNAMIC: recalculated on every request. A saved snapshot is a frozen copy, labelled `type: 'snapshot'`.
//  * Income, expense and savings come ONLY from transactions. Savings = income - expense (can be negative).
//    Goal contributions are allocations of money already counted, so they never change income/expense/savings.
//    Subscription payments that were recorded as expenses are already inside "expense"; subscription ESTIMATES are never added.
//  * savingsRate is null when income is 0 (a rate cannot be computed); percentages against a zero previous period are null.
//  * "No previous data" is stated, never shown as 0% or 100%.
//  * Budgets: see budgetPerformance().
// ---------------------------------------------------------------------------

const TOP_TX = 10;
const MAX_SNAPSHOTS = 50;
const USD_LIKE = (c) => String(c || 'BDT').toUpperCase();

const dayOf = (d) => isoDay(d);

// ----- budget performance ------------------------------------------------------------------------------------------------
// A budget has its own date range (any length, e.g. a week or a quarter), so it rarely matches the report period exactly.
// Overlap handling:
//   * Every budget whose range OVERLAPS the report period is listed.
//   * `spent`/`limit`/`percentage`/`status` are for the budget's OWN full range (exactly what the Budgets page shows), so a
//     budget is never judged on a fraction of its limit.
//   * `spentInPeriod` is the part of that spending that falls inside the report period (informational).
//   * `inTotals` marks budgets that START inside the report period. ONLY those are added into the summary totals
//     (totalLimit/totalSpent). A budget that began before the period (e.g. a quarter-long budget seen in a one-month report) is
//     listed but left out of the totals, so its limit is never compared with spending from a different window. A budget that
//     starts inside the period but ends after it (a monthly budget in a "this month" report that stops today) is included: it is
//     judged over its own range, exactly like on the Budgets page.
//   * Two budgets for the same category cannot overlap (the API forbids it), so nothing is counted twice.
const statusOf = (b) => (b.isOverBudget ? 'over' : b.percentage >= 90 ? 'critical' : b.percentage >= 70 ? 'warning' : 'healthy');

async function budgetPerformance(userId, start, end) {
  const all = await getBudgetsWithSpending(userId);
  const overlapping = all.filter((b) => b.startDate < end && b.endDate >= start);
  const items = await Promise.all(overlapping.map(async (b) => {
    const from = b.startDate > start ? b.startDate : start;
    const toExclusive = new Date(Math.min(end.getTime(), b.endDate.getTime() + DAY_MS));
    const agg = toExclusive > from
      ? await prisma.transaction.aggregate({ where: { userId, type: 'EXPENSE', category: b.category, date: { gte: from, lt: toExclusive } }, _sum: { amount: true } })
      : { _sum: { amount: null } };
    const inTotals = b.startDate >= start && b.startDate < end;
    return {
      id: b.id, category: b.category, limit: round2(b.limit), spent: round2(b.spent), remaining: round2(b.remaining), percentage: b.percentage,
      status: statusOf(b), overBy: round2(b.overBy), startDate: dayOf(b.startDate), endDate: dayOf(b.endDate),
      spentInPeriod: round2(toNumber(agg._sum.amount) || 0), inTotals,
    };
  }));
  items.sort((a, b) => b.percentage - a.percentage || a.category.localeCompare(b.category));
  const whole = items.filter((i) => i.inTotals);
  const totalLimit = round2(whole.reduce((s, i) => s + i.limit, 0));
  const totalSpent = round2(whole.reduce((s, i) => s + i.spent, 0));
  return {
    items,
    summary: {
      count: items.length, includedCount: whole.length, excludedCount: items.length - whole.length,
      withinLimit: items.filter((i) => i.status !== 'over').length, overBudget: items.filter((i) => i.status === 'over').length,
      totalLimit, totalSpent, percentage: totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : null,
    },
    note: 'Each budget is judged over its own date range (as on the Budgets page). Totals include only budgets that start inside this report period; budgets that began earlier are listed (marked *) but left out of the totals.',
  };
}

// ----- goals -------------------------------------------------------------------------------------------------------------
async function goalSummary(userId, start, end, today) {
  const [goals, contribs] = await Promise.all([
    prisma.savingsGoal.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.goalContribution.groupBy({ by: ['goalId'], where: { userId, date: { gte: start, lt: end } }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const byGoal = new Map(contribs.map((c) => [c.goalId, { amount: toNumber(c._sum.amount) || 0, count: c._count._all }]));
  const items = goals.map((g) => {
    const target = toNumber(g.targetAmount); const saved = toNumber(g.savedAmount);
    const completed = target > 0 && saved >= target;
    const overdue = !completed && g.targetDate && g.targetDate < today;
    const c = byGoal.get(g.id) || { amount: 0, count: 0 };
    return {
      id: g.id, title: g.title, targetAmount: round2(target), savedAmount: round2(saved), percentage: target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0,
      remaining: round2(Math.max(0, target - saved)), targetDate: g.targetDate ? dayOf(g.targetDate) : null,
      status: completed ? 'completed' : overdue ? 'overdue' : 'active', contributedInPeriod: round2(c.amount), contributionsInPeriod: c.count,
    };
  });
  const totalTarget = round2(items.reduce((s, i) => s + i.targetAmount, 0));
  const totalSaved = round2(items.reduce((s, i) => s + i.savedAmount, 0));
  return {
    items,
    summary: {
      count: items.length, active: items.filter((i) => i.status === 'active').length, completed: items.filter((i) => i.status === 'completed').length,
      overdue: items.filter((i) => i.status === 'overdue').length, totalTarget, totalSaved,
      overallPercentage: totalTarget > 0 ? Math.round((totalSaved / totalTarget) * 100) : null,
      contributedInPeriod: round2(items.reduce((s, i) => s + i.contributedInPeriod, 0)),
    },
    note: 'Goal progress is shown as of today. "Contributed in period" is money moved into goals during the report period; it is an allocation of income already counted and does not change income, expense or savings.',
  };
}

// ----- subscriptions: estimated (a plan) vs actual (confirmed payments) -------------------------------------------------
async function subscriptionSection(userId, start, end, now) {
  const s = await subscriptions.summary(userId, { days: 30 }, now);
  const actual = await prisma.subscriptionPayment.findMany({
    where: { userId, status: 'PAID', currency: s.baseCurrency, paidAt: { gte: start, lt: end } },
    select: { amount: true, subscription: { select: { name: true, category: true } } },
  });
  const actualTotal = round2(actual.reduce((t, p) => t + Number(p.amount), 0));
  const byName = new Map();
  actual.forEach((p) => byName.set(p.subscription.name, round2((byName.get(p.subscription.name) || 0) + Number(p.amount))));
  return {
    counts: s.counts,
    currency: s.baseCurrency,
    estimated: { monthly: s.estimated.monthly, yearly: s.estimated.yearly, label: 'ESTIMATE - what your active subscriptions cost per month / year at today\'s plans. Not payments.' },
    actual: { inPeriod: actualTotal, paymentCount: actual.length, byName: [...byName.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount), label: 'ACTUAL - renewals confirmed (or auto-recorded) as paid inside this period.' },
    topExpensive: s.topExpensive,
    categoryBreakdown: s.categoryBreakdown,
    note: 'Estimates describe your current plans and are never added to expenses. A subscription payment that was recorded as an expense is already inside the expense total above, so it is not counted twice here.',
  };
}

// ----- the report ----------------------------------------------------------------------------------------------------------
async function buildReport(userId, { period = 'this_month', startDate, endDate } = {}, user = {}, now = new Date()) {
  const p = resolveAnalyticsPeriod(period, startDate, endDate, now);
  const today = startOfUtcDay(now);

  const [cur, prev, expCats, incCats, series, totalTx, curCount, prevCount, expCount, incCount, topExpenses, topIncome, budgets, goals, subs] = await Promise.all([
    sumByType(userId, p.start, p.end),
    sumByType(userId, p.prevStart, p.prevEnd),
    categoryTotals(userId, 'EXPENSE', p.start, p.end),
    categoryTotals(userId, 'INCOME', p.start, p.end),
    timeSeries(userId, p.start, p.end),
    prisma.transaction.count({ where: { userId } }),
    prisma.transaction.count({ where: { userId, date: { gte: p.start, lt: p.end } } }),
    prisma.transaction.count({ where: { userId, date: { gte: p.prevStart, lt: p.prevEnd } } }),
    prisma.transaction.count({ where: { userId, type: 'EXPENSE', date: { gte: p.start, lt: p.end } } }),
    prisma.transaction.count({ where: { userId, type: 'INCOME', date: { gte: p.start, lt: p.end } } }),
    prisma.transaction.findMany({ where: { userId, type: 'EXPENSE', date: { gte: p.start, lt: p.end } }, orderBy: [{ amount: 'desc' }, { date: 'desc' }, { id: 'asc' }], take: TOP_TX }),
    prisma.transaction.findMany({ where: { userId, type: 'INCOME', date: { gte: p.start, lt: p.end } }, orderBy: [{ amount: 'desc' }, { date: 'desc' }, { id: 'asc' }], take: 5 }),
    budgetPerformance(userId, p.start, p.end),
    goalSummary(userId, p.start, p.end, today),
    subscriptionSection(userId, p.start, p.end, now),
  ]);

  const income = round2(cur.income); const expense = round2(cur.expense); const savings = round2(income - expense);
  const prevIncome = round2(prev.income); const prevExpense = round2(prev.expense); const prevSavings = round2(prevIncome - prevExpense);
  const prevHas = prevCount > 0;
  const days = p.range.days;
  const share = (list, total) => list.map((c) => ({ ...c, percentage: total > 0 ? Math.round((c.amount / total) * 1000) / 10 : 0 })).sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
  const tx = (t) => ({ id: t.id, date: dayOf(t.date), description: t.description, category: t.category, amount: toNumber(t.amount) });

  const report = {
    type: 'dynamic',
    meta: {
      title: `Financial report - ${p.label}`, period, label: p.label, range: p.range, previousRange: p.previousRange,
      generatedAt: now.toISOString(), currency: USD_LIKE(user.currency), userName: user.name || '',
      basis: 'Calculated live from your transactions, budgets, goals and subscriptions at the moment of generation.',
    },
    hasAnyTransactions: totalTx > 0,
    hasData: curCount > 0,
    summary: {
      income, expense, savings, savingsRate: savingsRate(income, expense), transactionCount: curCount, incomeCount: incCount, expenseCount: expCount,
      averageDailyExpense: days > 0 ? round2(expense / days) : 0, averageDailyIncome: days > 0 ? round2(income / days) : 0,
      isNegativeSavings: savings < 0, hasIncome: income > 0,
    },
    previousSummary: prevHas ? { income: prevIncome, expense: prevExpense, savings: prevSavings, savingsRate: savingsRate(prevIncome, prevExpense) } : null,
    comparison: {
      available: prevHas,
      income: metricComparison('Income', income, prevIncome, prevHas, { higherIsBetter: true }),
      expense: metricComparison('Expenses', expense, prevExpense, prevHas, { higherIsBetter: false }),
      savings: metricComparison('Savings', savings, prevSavings, prevHas, { higherIsBetter: true }),
      message: prevHas ? null : 'There are no transactions in the previous period, so no comparison is shown.',
    },
    trend: { granularity: series.granularity, points: series.points },
    expenseCategories: share(expCats, expense),
    incomeCategories: share(incCats, income),
    topExpenses: topExpenses.map(tx),
    topIncome: topIncome.map(tx),
    budgets, goals, subscriptions: subs,
  };
  void percentChange;
  return report;
}

// A stable hash of the figures: the same data for the same range gives the same fingerprint, so an unchanged report is not saved twice.
const fingerprintOf = (report) => crypto.createHash('sha256').update(JSON.stringify({
  r: report.meta.range, s: report.summary, e: report.expenseCategories, i: report.incomeCategories,
  b: report.budgets.items.map((b) => [b.id, b.spent, b.limit]), g: report.goals.items.map((g) => [g.id, g.savedAmount, g.contributedInPeriod]),
  u: [report.subscriptions.estimated, report.subscriptions.actual.inPeriod, report.subscriptions.counts],
})).digest('hex');

// ----- snapshots -----------------------------------------------------------------------------------------------------------
const snapshotRow = (r) => ({
  id: r.id, title: r.title, period: r.period, startDate: dayOf(r.startDate), endDate: dayOf(r.endDate), generatedAt: r.generatedAt,
  summary: r.payload && r.payload.summary ? { income: r.payload.summary.income, expense: r.payload.summary.expense, savings: r.payload.summary.savings } : null,
  type: 'snapshot',
});

async function createSnapshot(userId, input, user, now = new Date()) {
  const count = await prisma.reportSnapshot.count({ where: { userId } });
  const report = await buildReport(userId, input, user, now);
  const fingerprint = fingerprintOf(report);
  const existing = await prisma.reportSnapshot.findUnique({ where: { userId_fingerprint: { userId, fingerprint } } });
  if (existing) return { snapshot: snapshotRow(existing), duplicate: true };
  if (count >= MAX_SNAPSHOTS) throw httpError(400, `You can keep at most ${MAX_SNAPSHOTS} saved reports. Delete an older one first.`);
  const frozen = { ...report, type: 'snapshot', meta: { ...report.meta, basis: `Saved snapshot: the figures below were frozen on ${now.toISOString().slice(0, 10)} and do not change when your data changes.` } };
  const title = input.title || `${report.meta.label} (${report.meta.range.start} to ${report.meta.range.end})`;
  try {
    const row = await prisma.reportSnapshot.create({
      data: { userId, title, period: report.meta.period, startDate: new Date(`${report.meta.range.start}T00:00:00Z`), endDate: new Date(`${report.meta.range.end}T00:00:00Z`), fingerprint, payload: frozen, generatedAt: now },
    });
    return { snapshot: snapshotRow(row), duplicate: false };
  } catch (err) {
    if (err.code === 'P2002') { // two identical saves at the same moment: the unique key keeps exactly one
      const again = await prisma.reportSnapshot.findUnique({ where: { userId_fingerprint: { userId, fingerprint } } });
      return { snapshot: snapshotRow(again), duplicate: true };
    }
    throw err;
  }
}

const listSnapshots = async (userId) => (await prisma.reportSnapshot.findMany({ where: { userId }, orderBy: { generatedAt: 'desc' } })).map(snapshotRow);

async function getSnapshot(userId, id) {
  const row = await prisma.reportSnapshot.findFirst({ where: { id, userId } }); // userId in the query: another user's id is "not found"
  if (!row) throw httpError(404, 'Saved report not found');
  return { ...row.payload, snapshotId: row.id, title: row.title };
}

async function deleteSnapshot(userId, id) {
  const { count } = await prisma.reportSnapshot.deleteMany({ where: { id, userId } });
  if (!count) throw httpError(404, 'Saved report not found');
}

module.exports = { buildReport, createSnapshot, listSnapshots, getSnapshot, deleteSnapshot, fingerprintOf, MAX_SNAPSHOTS };
