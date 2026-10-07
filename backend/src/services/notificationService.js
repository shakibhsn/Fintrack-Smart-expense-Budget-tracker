const prisma = require('../config/prisma');
const { getBudgetsWithSpending } = require('./budgetService');
const { toNumber } = require('../utils/serialize');

// Creates a notification only if one with the same title doesn't already exist
// in the given window. This is the whole "don't spam the user" strategy:
// budget alerts are deduped per budget (using the budget's own createdAt as the
// window start, since each budget now has its own arbitrary date range rather than
// a calendar month); goal milestones are deduped forever (announced once per goal).
const createIfNew = async (userId, { title, message, type }, since) => {
  const existing = await prisma.notification.findFirst({
    where: { userId, title, ...(since ? { createdAt: { gte: since } } : {}) },
  });
  if (existing) return null;
  return prisma.notification.create({ data: { userId, title, message, type } });
};

// Call after any EXPENSE transaction is created/updated for `category` (with `onDate`
// being the transaction's date), or after a budget for `category` is created/updated
// (with `onDate` being that budget's startDate). Finds every budget for this category
// whose date range covers `onDate` and raises a warning/exceeded alert from its real,
// computed spending - never a guess.
const checkBudgetByCategoryAndDate = async (userId, category, onDate) => {
  try {
    const budgets = await getBudgetsWithSpending(userId);
    const matches = budgets.filter((b) => b.category === category && b.startDate <= onDate && onDate <= b.endDate);

    for (const budget of matches) {
      const range = `${budget.startDate.toISOString().slice(0, 10)} – ${budget.endDate.toISOString().slice(0, 10)}`;

      if (budget.isOverBudget) {
        // eslint-disable-next-line no-await-in-loop
        await createIfNew(userId, {
          title: `Budget Exceeded: ${category}`,
          message: `You've exceeded your ${category} budget (${range}) by ৳${budget.overBy.toLocaleString()} (${budget.percentage}% used).`,
          type: 'BUDGET_EXCEEDED',
        }, budget.createdAt);
      } else if (budget.percentage >= 80) {
        // eslint-disable-next-line no-await-in-loop
        await createIfNew(userId, {
          title: `Budget Warning: ${category}`,
          message: `You've used ${budget.percentage}% of your ${category} budget (৳${budget.spent.toLocaleString()} of ৳${budget.limit.toLocaleString()}, ${range}).`,
          type: 'BUDGET_WARNING',
        }, budget.createdAt);
      }
    }
  } catch (err) {
    // A notification failing to generate should never break the transaction/budget request itself.
    console.error('checkBudgetByCategoryAndDate failed:', err.message);
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

module.exports = { checkBudgetByCategoryAndDate, checkGoalMilestones, createWelcomeNotification };
