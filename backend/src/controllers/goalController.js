const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { serializeGoal } = require('../utils/serialize');
const { checkGoalMilestones } = require('../services/notificationService');

const findOwned = async (id, userId) => {
  const goal = await prisma.savingsGoal.findFirst({ where: { id, userId } });
  if (!goal) throw httpError(404, 'Savings goal not found');
  return goal;
};

// GET /api/goals
const getGoals = asyncHandler(async (req, res) => {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: { goals: goals.map(serializeGoal) } });
});

// GET /api/goals/:id
const getGoal = asyncHandler(async (req, res) => {
  const goal = await findOwned(req.params.id, req.user.id);
  res.json({ success: true, data: { goal: serializeGoal(goal) } });
});

// POST /api/goals
const createGoal = asyncHandler(async (req, res) => {
  const goal = await prisma.savingsGoal.create({ data: { ...req.body, userId: req.user.id } });
  res.status(201).json({ success: true, data: { goal: serializeGoal(goal) } });
});

// PUT /api/goals/:id
const updateGoal = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  const goal = await prisma.savingsGoal.update({ where: { id: req.params.id }, data: req.body });
  res.json({ success: true, data: { goal: serializeGoal(goal) } });
});

// DELETE /api/goals/:id
const deleteGoal = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  await prisma.savingsGoal.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Savings goal deleted' });
});

// POST /api/goals/:id/deposit   body: { amount }
const depositToGoal = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  // "increment" is done by the database itself, so two quick deposits can't overwrite each other.
  const goal = await prisma.savingsGoal.update({
    where: { id: req.params.id },
    data: { savedAmount: { increment: req.body.amount } },
  });

  // Awaited so a client that refetches notifications right after this request sees the milestone.
  await checkGoalMilestones(req.user.id, goal);

  res.json({ success: true, data: { goal: serializeGoal(goal) } });
});

module.exports = { getGoals, getGoal, createGoal, updateGoal, deleteGoal, depositToGoal };
