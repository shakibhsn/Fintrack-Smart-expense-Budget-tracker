const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { serializeGoal, serializeContribution } = require('../utils/serialize');
const { checkGoalMilestones } = require('../services/notificationService');
const { addContribution, getGoalsSummary, withCount, INITIAL_NOTES } = require('../services/goalService');

// Every goal/contribution query includes userId - that is the ownership check. Another
// user's goal id simply looks like "not found" (404), never "forbidden", so ids can't be probed.
const findOwned = async (id, userId) => {
  const goal = await prisma.savingsGoal.findFirst({ where: { id, userId }, include: withCount });
  if (!goal) throw httpError(404, 'Savings goal not found');
  return goal;
};

// GET /api/goals
const getGoals = asyncHandler(async (req, res) => {
  const goals = await prisma.savingsGoal.findMany({ where: { userId: req.user.id }, include: withCount, orderBy: { createdAt: 'asc' } });
  res.json({ success: true, data: { goals: goals.map(serializeGoal) } });
});

// GET /api/goals/summary
const getSummary = asyncHandler(async (req, res) => {
  const { goals, ...summary } = await getGoalsSummary(req.user.id);
  res.json({ success: true, data: summary });
});

// GET /api/goals/:id
const getGoal = asyncHandler(async (req, res) => {
  const goal = await findOwned(req.params.id, req.user.id);
  res.json({ success: true, data: { goal: serializeGoal(goal) } });
});

// POST /api/goals - an initial saved amount becomes the goal's first contribution
const createGoal = asyncHandler(async (req, res) => {
  const { savedAmount, ...fields } = req.body;
  const goal = await prisma.$transaction(async (tx) => {
    const created = await tx.savingsGoal.create({ data: { ...fields, savedAmount, userId: req.user.id } });
    if (savedAmount > 0) {
      const today = new Date();
      await tx.goalContribution.create({
        data: {
          goalId: created.id,
          userId: req.user.id,
          amount: savedAmount,
          date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
          note: INITIAL_NOTES[0],
        },
      });
    }
    return tx.savingsGoal.findUnique({ where: { id: created.id }, include: withCount });
  });
  if (savedAmount > 0) await checkGoalMilestones(req.user.id, goal);
  res.status(201).json({ success: true, data: { goal: serializeGoal(goal) } });
});

// PUT /api/goals/:id - never touches savedAmount (that only moves via contributions)
const updateGoal = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  const goal = await prisma.savingsGoal.update({ where: { id: req.params.id }, data: req.body, include: withCount });
  res.json({ success: true, data: { goal: serializeGoal(goal) } });
});

// DELETE /api/goals/:id - its contributions go with it (cascade); transactions are untouched
const deleteGoal = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  await prisma.savingsGoal.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Savings goal deleted' });
});

// POST /api/goals/:id/contributions   body: { amount, date?, note? }   (also reachable as /deposit)
const createContribution = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  const { contribution, goal } = await addContribution(req.user.id, req.params.id, req.body);
  // Awaited so a client that refetches notifications right after this request sees the milestone.
  await checkGoalMilestones(req.user.id, goal);
  res.status(201).json({ success: true, data: { goal: serializeGoal(goal), contribution: serializeContribution(contribution) } });
});

// GET /api/goals/:id/contributions - newest first
const getContributions = asyncHandler(async (req, res) => {
  const goal = await findOwned(req.params.id, req.user.id);
  const rows = await prisma.goalContribution.findMany({
    where: { goalId: goal.id, userId: req.user.id },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ success: true, data: { goal: serializeGoal(goal), contributions: rows.map(serializeContribution) } });
});

module.exports = { getGoals, getSummary, getGoal, createGoal, updateGoal, deleteGoal, createContribution, getContributions };
