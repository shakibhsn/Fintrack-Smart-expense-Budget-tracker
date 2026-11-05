// Prisma returns Decimal objects for money columns. The frontend wants plain numbers,
// and dates as YYYY-MM-DD strings, so we convert here in one place.
const { goalMetrics } = require('./goalMetrics');

const toNumber = (value) => (value === null || value === undefined ? value : Number(value));

const serializeTransaction = (tx) => ({
  id: tx.id,
  type: tx.type,
  amount: toNumber(tx.amount),
  category: tx.category,
  description: tx.description,
  notes: tx.notes ?? null,
  date: tx.date.toISOString().slice(0, 10),
  createdAt: tx.createdAt,
  updatedAt: tx.updatedAt,
});

// Budget rows come from budgetService already carrying computed spent/remaining/etc.
// This just formats the Date fields for the API the same way transactions/goals are.
const serializeBudget = (b) => ({
  id: b.id,
  category: b.category,
  limit: b.limit,
  startDate: b.startDate.toISOString().slice(0, 10),
  endDate: b.endDate.toISOString().slice(0, 10),
  status: b.status,
  spent: b.spent,
  remaining: b.remaining,
  percentage: b.percentage,
  isOverBudget: b.isOverBudget,
  overBy: b.overBy,
  prevSpent: b.prevSpent,
  momChangePercent: b.momChangePercent,
});

const serializeGoal = (goal) => ({
  id: goal.id,
  title: goal.title,
  ...goalMetrics(goal),
  targetDate: goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : null,
  category: goal.category ?? null,
  description: goal.description ?? null,
  icon: goal.icon,
  contributionCount: goal._count ? goal._count.contributions : undefined,
  createdAt: goal.createdAt,
  updatedAt: goal.updatedAt,
});

const serializeContribution = (c) => ({
  id: c.id,
  goalId: c.goalId,
  amount: toNumber(c.amount),
  date: c.date.toISOString().slice(0, 10),
  note: c.note ?? null,
  createdAt: c.createdAt,
});

module.exports = { toNumber, serializeTransaction, serializeGoal, serializeBudget, serializeContribution };
