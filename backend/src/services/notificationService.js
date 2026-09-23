const prisma = require('../config/prisma');
const { monthRange, getBudgetsWithSpending } = require('./budgetService');
const { toNumber } = require('../utils/serialize');

// Creates a notification only if one with the same title doesn't already exist
// in the given window. This is the whole "don't spam the user" strategy:
// budgets are deduped per calendar month, goal milestones are deduped forever
// (a milestone only needs to be announced once per goal).
const createIfNew = async (userId, { title, message, type }, since) => {
  const existing = await prisma.notification.findFirst({
    where: { userId, title, ...(since ? { createdAt: { gte: since } } : {}) },
  });
  if (existing) return null;
  return prisma.notification.create({ data: { userId, title, message, type } });
};

// Call after any EXPENSE transaction is created/updated for `category`.
// Looks at the real budget for that category/month and raises a warning or
// exceeded alert based on actual spending - never a guess.
const checkBudgetForCategory = async (userId, category, month, year) => {
  try {
    const budgets = await getBudgetsWithSpending(userId, month, year);
    const budget = budgets.find((b) => b.category === category);
    if (!budget) return; // user hasn't set a budget for this category - nothing to alert on

    const { start } = monthRange(month, year);

    if (budget.isOverBudget) {
      await createIfNew(userId, {
        title: `Budget Exceeded: ${category}`,
        message: `You've exceeded your ${category} budget by ৳${budget.overBy.toLocaleString()} (${budget.percentage}% used).`,
        type: 'BUDGET_EXCEEDED',
      }, start);
    } else if (budget.percentage >= 80) {
      await createIfNew(userId, {
        title: `Budget Warning: ${category}`,
        message: `You've used ${budget.percentage}% of your ${category} budget (৳${budget.spent.toLocaleString()} of ৳${budget.limit.toLocaleString()}).`,
        type: 'BUDGET_WARNING',
      }, start);
    }
  } catch (err) {
    // A notification failing to generate should never break the transaction request itself.
    console.error('checkBudgetForCategory failed:', err.message);
  }
};

// Call after a deposit updates a savings goal. Announces the 50% and 100% milestones once each.
const checkGoalMilestones = async (userId, goal) => {
  try {
    const target = toNumber(goal.targetAmount);
    const saved = toNumber(goal.savedAmount);
    if (target <= 0) return;
    const progress = (saved / target) * 100;

    if (progress >= 100) {
      await createIfNew(userId, {
        title: `Goal Completed: ${goal.title}`,
        message: `You reached your ৳${target.toLocaleString()} target for "${goal.title}". Great work!`,
        type: 'GOAL_PROGRESS',
      });
    } else if (progress >= 50) {
      await createIfNew(userId, {
        title: `Halfway There: ${goal.title}`,
        message: `You've saved ৳${saved.toLocaleString()} of ৳${target.toLocaleString()} (${Math.round(progress)}%) towards "${goal.title}".`,
        type: 'GOAL_PROGRESS',
      });
    }
  } catch (err) {
    console.error('checkGoalMilestones failed:', err.message);
  }
};

const createWelcomeNotification = async (userId) => {
  try {
    await prisma.notification.create({
      data: {
        userId,
        title: 'Welcome to FinTrack',
        message: 'Add your first transaction, set a budget, and create a savings goal to get started.',
        type: 'INFO',
      },
    });
  } catch (err) {
    console.error('createWelcomeNotification failed:', err.message);
  }
};

module.exports = { checkBudgetForCategory, checkGoalMilestones, createWelcomeNotification };
