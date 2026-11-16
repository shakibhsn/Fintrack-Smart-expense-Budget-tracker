const { z } = require('zod');
const prisma = require('../../config/prisma');
const { toNumber } = require('../../utils/serialize');
const { startOfUtcDay, addDays, isoDay, DAY_MS } = require('../../utils/dateRange');
const { round2, savingsRate, percentChange } = require('../../utils/finance');
const { sumByType, categoryTotals } = require('../analyticsService');
const { getBudgetsWithSpending } = require('../budgetService');
const { getForecast } = require('../forecastService');
const { getHealthScore } = require('../healthScoreService');

// ---------------------------------------------------------------------------
// The ONLY operations the assistant can run. Each tool:
//   * takes the authenticated user id from the SERVER (never from the question or the AI),
//   * validates its parameters with zod (a closed set: no free-form fields),
//   * reads through the existing services / parameterised Prisma queries (no SQL text is ever built from user or AI input),
//   * returns plain facts: { facts, rows, method, range, insufficient? } where `method` explains how the numbers were calculated.
// Nothing here writes to the database.
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthStartOf = (d, off = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + off, 1));

// ----- date ranges: a closed vocabulary -----
const rangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('this_month') }), z.object({ kind: z.literal('last_month') }),
  z.object({ kind: z.literal('this_year') }), z.object({ kind: z.literal('last_year') }),
  z.object({ kind: z.literal('last_days'), days: z.number().int().min(1).max(730) }),
  z.object({ kind: z.literal('last_months'), months: z.number().int().min(1).max(24) }),
  z.object({ kind: z.literal('custom'), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

// -> { start, end (exclusive), label, days, kind }; "to date" ranges stop at today (a half month is never compared with a whole one)
function resolveRange(spec, now = new Date()) {
  const r = rangeSchema.parse(spec);
  const today = startOfUtcDay(now); const tomorrow = addDays(today, 1);
  let start; let end; let label;
  switch (r.kind) {
    case 'this_month': start = monthStartOf(today); end = tomorrow; label = `this month (${MONTHS[today.getUTCMonth()]} ${today.getUTCFullYear()}, up to today)`; break;
    case 'last_month': start = monthStartOf(today, -1); end = monthStartOf(today); label = `last month (${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()})`; break;
    case 'this_year': start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1)); end = tomorrow; label = `this year (${today.getUTCFullYear()}, up to today)`; break;
    case 'last_year': start = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)); end = new Date(Date.UTC(today.getUTCFullYear(), 0, 1)); label = `last year (${today.getUTCFullYear() - 1})`; break;
    case 'last_days': start = addDays(today, -(r.days - 1)); end = tomorrow; label = `the last ${r.days} days`; break;
    case 'last_months': start = monthStartOf(today, -(r.months - 1)); end = tomorrow; label = `the last ${r.months} months (including this one so far)`; break;
    default: {
      start = new Date(`${r.start}T00:00:00Z`); end = addDays(new Date(`${r.end}T00:00:00Z`), 1);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw Object.assign(new Error('Invalid date range'), { statusCode: 400 });
      if ((end - start) / DAY_MS > 366 * 5) throw Object.assign(new Error('Date range cannot exceed 5 years'), { statusCode: 400 });
      label = `${r.start} to ${r.end}`;
    }
  }
  return { kind: r.kind, start, end, label, days: Math.round((end - start) / DAY_MS), from: isoDay(start), to: isoDay(addDays(end, -1)) };
}

const rangeInfo = (rg) => ({ label: rg.label, from: rg.from, to: rg.to, days: rg.days });
const catSchema = z.string().trim().min(1).max(50).optional();
const countTx = (userId, rg, extra = {}) => prisma.transaction.count({ where: { userId, date: { gte: rg.start, lt: rg.end }, ...extra } });

async function userCategories(userId) {
  const [t, b] = await Promise.all([prisma.transaction.groupBy({ by: ['category'], where: { userId } }), prisma.budget.groupBy({ by: ['category'], where: { userId } })]);
  return [...new Set([...t.map((x) => x.category), ...b.map((x) => x.category)])];
}

const TOOLS = {
  // ---- totals ----
  summary: {
    params: z.object({ range: rangeSchema }),
    async run(userId, { range }, now) {
      const rg = resolveRange(range, now);
      const [{ income, expense }, n] = await Promise.all([sumByType(userId, rg.start, rg.end), countTx(userId, rg)]);
      const i = round2(income); const e = round2(expense);
      if (!n) return { range: rangeInfo(rg), insufficient: `You have no transactions in ${rg.label}.`, facts: { transactionCount: 0 }, method: '' };
      return {
        range: rangeInfo(rg),
        facts: { income: i, expense: e, savings: round2(i - e), savingsRate: savingsRate(i, e), transactionCount: n, averageDailyExpense: round2(e / rg.days) },
        method: `Income and expenses are the sums of your recorded INCOME and EXPENSE transactions dated ${rg.from} to ${rg.to}. Savings = income - expenses (it can be negative). Savings rate = savings / income, shown only when there is income. Average daily expense = expenses / ${rg.days} days.`,
      };
    },
  },
  // ---- categories ----
  categories: {
    params: z.object({ range: rangeSchema, type: z.enum(['EXPENSE', 'INCOME']).default('EXPENSE') }),
    async run(userId, { range, type }, now) {
      const rg = resolveRange(range, now);
      const rows = await categoryTotals(userId, type, rg.start, rg.end);
      const total = round2(rows.reduce((s, r) => s + r.amount, 0));
      if (!rows.length) return { range: rangeInfo(rg), insufficient: `You have no ${type === 'EXPENSE' ? 'expenses' : 'income'} recorded in ${rg.label}.`, facts: {}, method: '' };
      const ranked = rows.sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)).map((r) => ({ category: r.category, amount: r.amount, transactions: r.count, share: total > 0 ? Math.round((r.amount / total) * 1000) / 10 : 0 }));
      return { range: rangeInfo(rg), facts: { type, total, top: ranked[0], categoryCount: ranked.length }, rows: ranked.slice(0, 8), method: `Your ${type === 'EXPENSE' ? 'expenses' : 'income'} dated ${rg.from} to ${rg.to} are grouped by category and summed. Share = category total / ${total}.` };
    },
  },
  // ---- compare two ranges (optionally one category) ----
  compare: {
    params: z.object({ a: rangeSchema, b: rangeSchema, category: catSchema }),
    async run(userId, { a, b, category }, now) {
      const ra = resolveRange(a, now); const rb = resolveRange(b, now);
      const sum = async (rg) => {
        if (category) { const agg = await prisma.transaction.aggregate({ where: { userId, type: 'EXPENSE', category, date: { gte: rg.start, lt: rg.end } }, _sum: { amount: true }, _count: { _all: true } }); return { total: round2(toNumber(agg._sum.amount) || 0), count: agg._count._all }; }
        const { expense } = await sumByType(userId, rg.start, rg.end); return { total: round2(expense), count: await countTx(userId, rg, { type: 'EXPENSE' }) };
      };
      const [x, y] = await Promise.all([sum(ra), sum(rb)]);
      const what = category ? `${category} spending` : 'total spending';
      if (!x.count && !y.count) return { range: { a: rangeInfo(ra), b: rangeInfo(rb) }, insufficient: `You have no ${what.replace(' spending', '')} expenses in either period.`, facts: {}, method: '' };
      const change = round2(x.total - y.total);
      return {
        range: { a: rangeInfo(ra), b: rangeInfo(rb) },
        facts: { what, categoryName: category || null, a: { label: ra.label, total: x.total, transactions: x.count }, b: { label: rb.label, total: y.total, transactions: y.count }, change, changePercent: percentChange(x.total, y.total), partialPeriodWarning: ra.days !== rb.days ? `The periods have different lengths (${ra.days} vs ${rb.days} days), so the totals are not like-for-like.` : null },
        method: `${what} = sum of EXPENSE transactions${category ? ` in category "${category}"` : ''} in each period. Change = first period - second period; percent change = change / second period total (not shown when the second total is 0).`,
      };
    },
  },
  // ---- budgets ----
  budgets: {
    params: z.object({}),
    async run(userId, _p, now) {
      const today = startOfUtcDay(now);
      const all = (await getBudgetsWithSpending(userId)).filter((b) => b.startDate <= today && today <= b.endDate);
      if (!all.length) return { range: null, insufficient: 'You have no budgets that are active today.', facts: {}, method: '' };
      const rows = all.map((b) => ({ category: b.category, limit: round2(b.limit), spent: round2(b.spent), remaining: round2(b.remaining), percentUsed: b.percentage, status: b.isOverBudget ? 'over' : b.percentage >= 90 ? 'critical' : b.percentage >= 70 ? 'warning' : 'on track', daysLeft: Math.max(0, Math.round((b.endDate - today) / DAY_MS)), ends: isoDay(b.endDate) }));
      return { range: null, facts: { activeBudgets: rows.length, over: rows.filter((r) => r.status === 'over').length, nearLimit: rows.filter((r) => r.status === 'critical' || r.status === 'warning').length }, rows, method: 'For each budget that is active today, spent = sum of EXPENSE transactions in that budget\'s category between its own start and end dates; percent used = spent / limit.' };
    },
  },
  // ---- savings outlook (an ESTIMATE) ----
  savings_outlook: {
    params: z.object({}),
    async run(userId, _p, now) {
      const f = await getForecast(userId, 'next_30_days', now);
      if (!f.available) return { range: null, insufficient: f.message || 'There is not enough history to estimate next month.', facts: {}, method: '' };
      return {
        range: null, isEstimate: true,
        facts: { estimatedIncome: f.forecast.income, estimatedExpense: f.forecast.expense, estimatedSavings: f.forecast.savings, expenseLow: f.forecast.expenseRange.low, expenseHigh: f.forecast.expenseRange.high, isDeficit: f.forecast.isDeficit },
        method: 'This is an ESTIMATE, not a prediction you can rely on: FinTrack\'s forecast takes a weighted moving average of your recent complete months of income and expenses (see the Forecast page for the model, the range and the data it used).',
      };
    },
  },
  // ---- habits ----
  habits: {
    params: z.object({ range: rangeSchema }),
    async run(userId, { range }, now) {
      const rg = resolveRange(range, now);
      const [cats, biggest, n] = await Promise.all([
        categoryTotals(userId, 'EXPENSE', rg.start, rg.end),
        prisma.transaction.findMany({ where: { userId, type: 'EXPENSE', date: { gte: rg.start, lt: rg.end } }, orderBy: [{ amount: 'desc' }, { id: 'asc' }], take: 3, select: { amount: true, category: true, date: true } }),
        countTx(userId, rg, { type: 'EXPENSE' }),
      ]);
      if (n < 5) return { range: rangeInfo(rg), insufficient: `There are only ${n} expense transactions in ${rg.label}, which is too few to describe habits. Record more spending first.`, facts: { expenseTransactions: n }, method: '' };
      const total = round2(cats.reduce((s, c) => s + c.amount, 0));
      const byAmount = cats.slice().sort((a, b) => b.amount - a.amount); const byCount = cats.slice().sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
      return {
        range: rangeInfo(rg),
        facts: { expenseTransactions: n, totalExpense: total, averageDailyExpense: round2(total / rg.days), averageExpense: round2(total / n), topByAmount: byAmount.slice(0, 3).map((c) => ({ category: c.category, amount: c.amount, share: total > 0 ? Math.round((c.amount / total) * 1000) / 10 : 0 })), mostFrequent: { category: byCount[0].category, transactions: byCount[0].count } },
        rows: biggest.map((t) => ({ category: t.category, amount: toNumber(t.amount), date: isoDay(t.date) })),
        method: `Looked at ${n} expense transactions dated ${rg.from} to ${rg.to}: categories ranked by total and by number of transactions, plus your three largest single expenses. Averages = total / days and total / transactions.`,
      };
    },
  },
  // ---- health ----
  health: {
    params: z.object({}),
    async run(userId) {
      const h = await getHealthScore(userId);
      if (!h.available) return { range: null, insufficient: h.message || 'Your health score is not available yet.', facts: {}, method: '' };
      return { range: null, facts: { score: h.score, level: h.level, partial: h.partial, componentsEvaluated: h.basedOn.componentsEvaluated }, rows: (h.strengths || []).slice(0, 2).map((s) => ({ kind: 'strength', text: s.text || s.title || String(s) })).concat((h.improvements || []).slice(0, 2).map((s) => ({ kind: 'improve', text: s.text || s.title || String(s) }))), method: 'The score is FinTrack\'s own Financial Health Score (see the Health Score page for the components and weights); it is computed from your savings rate, budgets, spending stability and goals, and is not a credit score.' };
    },
  },
  // ---- list transactions ----
  transactions: {
    params: z.object({ range: rangeSchema, type: z.enum(['EXPENSE', 'INCOME']).optional(), category: catSchema, limit: z.number().int().min(1).max(20).default(10) }),
    async run(userId, { range, type, category, limit }, now) {
      const rg = resolveRange(range, now);
      const where = { userId, date: { gte: rg.start, lt: rg.end }, ...(type ? { type } : {}), ...(category ? { category } : {}) };
      const [n, agg, rows] = await Promise.all([prisma.transaction.count({ where }), prisma.transaction.aggregate({ where, _sum: { amount: true } }), prisma.transaction.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], take: limit, select: { date: true, type: true, amount: true, category: true, description: true } })]);
      if (!n) return { range: rangeInfo(rg), insufficient: `No matching transactions in ${rg.label}.`, facts: { count: 0 }, method: '' };
      return { range: rangeInfo(rg), facts: { count: n, total: round2(toNumber(agg._sum.amount) || 0), shown: rows.length, type: type || 'ALL', category: category || null }, rows: rows.map((t) => ({ date: isoDay(t.date), type: t.type, amount: toNumber(t.amount), category: t.category, description: t.description })), localOnly: ['rows'], method: `Matching transactions dated ${rg.from} to ${rg.to}, newest first; the total is the sum of ALL ${n} matches, not just the ${rows.length} listed.` };
    },
  },
};

// validated entry point: unknown tool / bad params throw (the HTTP layer turns that into a 400); the AI cannot add fields
async function runTool(userId, name, params, now = new Date()) {
  const tool = TOOLS[name];
  if (!tool) throw Object.assign(new Error('Unsupported operation'), { statusCode: 400 });
  const parsed = tool.params.parse(params || {});
  const out = await tool.run(userId, parsed, now);
  return { tool: name, params: parsed, ...out };
}

module.exports = { TOOLS, runTool, resolveRange, rangeSchema, userCategories, MONTHS };
