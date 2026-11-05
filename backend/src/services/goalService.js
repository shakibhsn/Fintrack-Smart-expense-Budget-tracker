const prisma = require('../config/prisma');
const { goalMetrics } = require('../utils/goalMetrics');
const { serializeGoal } = require('../utils/serialize');
const { round2 } = require('../utils/finance');

// Notes on the system-created rows that hold a goal's starting balance (new goals / the Phase 6 backfill).
// They are not "recent saving activity", so pace estimates ignore them.
const INITIAL_NOTES = ['Initial saved amount', 'Balance before contribution tracking'];

const withCount = { _count: { select: { contributions: true } } };

// Accounting rule (see backend/README): a contribution is NOT a Transaction. It allocates money
// the user already recorded as income, so it never changes income, expenses, budgets or the savings rate.
// Adds the contribution row and bumps savedAmount in ONE database transaction so the two can't drift;
// the increment is done by the database so two quick contributions can't overwrite each other.
const addContribution = async (userId, goalId, { amount, date, note }) => {
  const when = date || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const [contribution, goal] = await prisma.$transaction([
    prisma.goalContribution.create({ data: { goalId, userId, amount, date: when, note: note || null } }),
    prisma.savingsGoal.update({ where: { id: goalId }, data: { savedAmount: { increment: amount } }, include: withCount }),
  ]);
  return { contribution, goal };
};

// Overview for the dashboard card. Only reads the caller's own goals.
const getGoalsSummary = async (userId) => {
  const goals = await prisma.savingsGoal.findMany({ where: { userId }, include: withCount, orderBy: { createdAt: 'asc' } });
  const items = goals.map(serializeGoal);

  const active = items.filter((g) => g.status !== 'completed');
  const completed = items.filter((g) => g.status === 'completed');
  const activeTarget = round2(active.reduce((s, g) => s + g.targetAmount, 0));
  const activeSaved = round2(active.reduce((s, g) => s + g.savedAmount, 0));

  return {
    totalCount: items.length,
    activeCount: active.length,
    completedCount: completed.length,
    overdueCount: items.filter((g) => g.status === 'overdue').length,
    // everything the user has put into goals (completed goals included)
    totalSaved: round2(items.reduce((s, g) => s + g.savedAmount, 0)),
    activeSaved,
    activeTarget,
    activeProgress: activeTarget > 0 ? Math.min(Math.round((activeSaved / activeTarget) * 1000) / 10, 100) : 0,
    // active goals that have a target date, soonest first (overdue ones sort to the top)
    upcoming: active.filter((g) => g.targetDate).sort((a, b) => a.targetDate.localeCompare(b.targetDate)).slice(0, 3),
    goals: items,
  };
};

module.exports = { addContribution, getGoalsSummary, withCount, goalMetrics, INITIAL_NOTES };
