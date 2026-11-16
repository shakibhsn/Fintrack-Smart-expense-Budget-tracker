const prisma = require('../../config/prisma');
const { startOfUtcDay, addDays, isoDay } = require('../../utils/dateRange');
const { round2, savingsRate, percentChange } = require('../../utils/finance');
const { categoryTotals, sumByType } = require('../analyticsService');
const { getBudgetsWithSpending } = require('../budgetService');
const subscriptions = require('../subscriptionService');
const { money } = require('./answer');

// ---------------------------------------------------------------------------
// Personalised recommendations from the user's REAL data, by fixed, documented rules (no model involved).
//  kind 'observation' = something that already happened (a fact); 'estimate' = what MIGHT happen (always labelled, never a guarantee).
//  Each carries `why` (the evidence used) so the user can check it. Not enough data => no recommendations, with the reason.
//  Keys include the month, so a dismissed recommendation does not come back that month and the same one is never listed twice.
// ---------------------------------------------------------------------------

const RULES = {
  minExpenseTransactions: 10, // across the last 90 days, otherwise "not enough data"
  minPreviousTransactions: 3, // a category change needs a real baseline
  categoryIncreasePercent: 25, categoryIncreaseMinAmount: 500, // ... and a meaningful amount (in the account currency)
  budgetNearPercent: 80, subscriptionSharePercent: 15, lowSavingsRatePercent: 10, concentrationPercent: 40, concentrationMinTransactions: 5,
};
const monthKey = (d) => d.toISOString().slice(0, 7);
const monthStart = (d, off = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + off, 1));
const SEVERITY = { warning: 0, info: 1 };

async function generate(userId, user = {}, now = new Date()) {
  const cur = user.currency || 'BDT'; const m = (n) => money(n, cur);
  const today = startOfUtcDay(now); const ms = monthStart(today); const prevMs = monthStart(today, -1);
  const elapsed = Math.round((addDays(today, 1) - ms) / 86400000);
  const prevEnd = new Date(Math.min(prevMs.getTime() + elapsed * 86400000, ms.getTime()));
  const mk = monthKey(today);

  const since = addDays(today, -90);
  const recent = await prisma.transaction.count({ where: { userId, type: 'EXPENSE', date: { gte: since, lt: addDays(today, 1) } } });
  if (recent < RULES.minExpenseTransactions) {
    return { sufficient: false, message: `There is not enough spending data yet to give useful recommendations. Record at least ${RULES.minExpenseTransactions} expenses (you have ${recent} in the last 90 days).`, recommendations: [], generatedFor: mk };
  }

  const [curCats, prevCats, budgets, subs, lastMonth, curTx] = await Promise.all([
    categoryTotals(userId, 'EXPENSE', ms, addDays(today, 1)), categoryTotals(userId, 'EXPENSE', prevMs, prevEnd),
    getBudgetsWithSpending(userId), subscriptions.summary(userId, {}, now),
    sumByType(userId, prevMs, ms), prisma.transaction.count({ where: { userId, type: 'EXPENSE', date: { gte: ms, lt: addDays(today, 1) } } }),
  ]);
  const recs = [];
  const prevBy = new Map(prevCats.map((c) => [c.category, c]));
  const range = { from: isoDay(ms), to: isoDay(today) };

  // R1: a category clearly up on the same days of last month
  curCats.forEach((c) => {
    const p = prevBy.get(c.category);
    if (!p || p.count < RULES.minPreviousTransactions || p.amount <= 0) return;
    const diff = round2(c.amount - p.amount); const change = percentChange(c.amount, p.amount);
    if (change === null || change < RULES.categoryIncreasePercent || diff < RULES.categoryIncreaseMinAmount) return;
    recs.push({ key: `category_increase:${c.category}:${mk}`, rule: 'category_increase', kind: 'observation', severity: 'warning', category: c.category,
      title: `${c.category} spending is up ${change}% on last month`,
      text: `So far this month you spent ${m(c.amount)} on ${c.category}, against ${m(p.amount)} over the same days last month (${m(diff)} more).`,
      why: [`This month (${range.from} to ${range.to}): ${m(c.amount)} in ${c.count} transactions`, `Same days last month: ${m(p.amount)} in ${p.count} transactions`, `Rule: flagged when the increase is at least ${RULES.categoryIncreasePercent}% and ${m(RULES.categoryIncreaseMinAmount)}`],
      estimate: { amount: diff, label: `ESTIMATE: if ${c.category} returned to last month's pace you would spend roughly ${m(diff)} less over this period. This is not a guaranteed saving.` } });
  });

  // R2: budgets close to / over the limit
  const today0 = today;
  budgets.filter((b) => b.startDate <= today0 && today0 <= b.endDate && b.percentage >= RULES.budgetNearPercent).forEach((b) => {
    const left = Math.max(0, Math.round((b.endDate - today0) / 86400000));
    recs.push({ key: `budget_near:${b.category}:${mk}`, rule: 'budget_near', kind: 'observation', severity: 'warning', category: b.category,
      title: b.isOverBudget ? `Your ${b.category} budget is over its limit` : `Your ${b.category} budget is ${b.percentage}% used`,
      text: b.isOverBudget ? `You have spent ${m(b.spent)} of a ${m(b.limit)} ${b.category} budget (${m(b.overBy)} over), with ${left} days left in it.` : `You have spent ${m(b.spent)} of ${m(b.limit)}, leaving ${m(b.remaining)} for the ${left} days until ${isoDay(b.endDate)}.`,
      why: [`Budget ${isoDay(b.startDate)} to ${isoDay(b.endDate)}: limit ${m(b.limit)}`, `Spent in ${b.category} in that range: ${m(b.spent)} (${b.percentage}%)`, `Rule: flagged from ${RULES.budgetNearPercent}% used`] });
  });

  // R3: subscriptions as a share of last complete month's spending
  const monthlySubs = subs.estimated && subs.estimated.currency === cur ? subs.estimated.monthly : 0;
  if (monthlySubs > 0 && lastMonth.expense > 0) {
    const share = Math.round((monthlySubs / lastMonth.expense) * 1000) / 10;
    if (share >= RULES.subscriptionSharePercent) {
      recs.push({ key: `subscription_share::${mk}`, rule: 'subscription_share', kind: 'observation', severity: 'info', category: null,
        title: `Subscriptions are about ${share}% of a typical month's spending`,
        text: `Your active subscriptions cost an estimated ${m(monthlySubs)} a month, compared with ${m(lastMonth.expense)} spent last month. Reviewing plans you rarely use is one way to lower fixed costs.`,
        why: [`ESTIMATE of active subscriptions per month: ${m(monthlySubs)} (see Subscriptions)`, `Total expenses last month: ${m(round2(lastMonth.expense))}`, `Rule: flagged from ${RULES.subscriptionSharePercent}%`] });
    }
  }

  // R4: low (or negative) savings rate last complete month
  if (lastMonth.income > 0) {
    const rate = savingsRate(lastMonth.income, lastMonth.expense);
    if (rate !== null && rate < RULES.lowSavingsRatePercent) {
      recs.push({ key: `low_savings:${''}:${mk}`, rule: 'low_savings', kind: 'observation', severity: rate < 0 ? 'warning' : 'info', category: null,
        title: rate < 0 ? 'Last month you spent more than you earned' : `Last month's savings rate was ${rate}%`,
        text: `Last month's income was ${m(round2(lastMonth.income))} and expenses ${m(round2(lastMonth.expense))}, so ${rate < 0 ? `spending exceeded income by ${m(round2(lastMonth.expense - lastMonth.income))}` : `you kept ${rate}% of what you earned`}.`,
        why: [`Income last month: ${m(round2(lastMonth.income))}`, `Expenses last month: ${m(round2(lastMonth.expense))}`, `Rule: flagged below ${RULES.lowSavingsRatePercent}%`] });
    }
  }

  // R5: one category dominating this month's spending
  const total = curCats.reduce((s, c) => s + c.amount, 0);
  if (curTx >= 8 && total > 0) {
    const top = curCats.slice().sort((a, b) => b.amount - a.amount)[0];
    const share = Math.round((top.amount / total) * 1000) / 10;
    if (share >= RULES.concentrationPercent && top.count >= RULES.concentrationMinTransactions && !recs.some((r) => r.category === top.category)) {
      recs.push({ key: `concentration:${top.category}:${mk}`, rule: 'concentration', kind: 'observation', severity: 'info', category: top.category,
        title: `${top.category} is ${share}% of this month's spending`,
        text: `${top.category} accounts for ${m(top.amount)} of the ${m(round2(total))} you have spent so far this month. If you want to cut costs, the largest category is usually where a change matters most.`,
        why: [`${top.category}: ${m(top.amount)} in ${top.count} transactions this month`, `All expenses this month so far: ${m(round2(total))}`, `Rule: flagged from ${RULES.concentrationPercent}% with at least ${RULES.concentrationMinTransactions} transactions`] });
    }
  }

  const dismissed = new Set((await prisma.aiDismissal.findMany({ where: { userId, key: { in: recs.map((r) => r.key) } }, select: { key: true } })).map((d) => d.key));
  const seen = new Set();
  const list = recs.filter((r) => !dismissed.has(r.key) && !seen.has(r.key) && seen.add(r.key)).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]).slice(0, 6).map((r) => ({ ...r, dataRange: range }));
  return { sufficient: true, recommendations: list, generatedFor: mk, dismissedCount: dismissed.size, rules: RULES, disclaimer: 'Educational information based on your own records, not professional financial advice. Estimates are not guarantees.',
    message: list.length ? null : 'Nothing stands out right now: your recent spending is in line with last month and your budgets.' };
}

const dismiss = async (userId, key) => { await prisma.aiDismissal.upsert({ where: { userId_key: { userId, key } }, create: { userId, key }, update: {} }); };

module.exports = { generate, dismiss, RULES };
