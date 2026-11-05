const { round1, round2 } = require('./finance');
const { startOfUtcDay, DAY_MS } = require('./dateRange');

// The ONE place goal progress and status are calculated. serializeGoal, the dashboard
// summary, insights and the health score all go through here so they always agree.
//
//   progress  = saved / target * 100            (actualProgress, can exceed 100)
//   shown bar = min(progress, 100)              (progress)
//   remaining = max(target - saved, 0)
//   excess    = max(saved - target, 0)          (shown separately, never as >100% on the bar)
//
// Status (completed wins over everything, overdue is never "auto-completed"):
//   completed    saved >= target
//   overdue      not completed AND targetDate is before today
//   not_started  not completed, not overdue, saved == 0
//   in_progress  otherwise
const goalMetrics = (goal, now = new Date()) => {
  const target = Number(goal.targetAmount);
  const saved = Number(goal.savedAmount);
  const today = startOfUtcDay(now);
  const targetDate = goal.targetDate ? startOfUtcDay(new Date(goal.targetDate)) : null;

  const actualProgress = target > 0 ? round1((saved / target) * 100) : 0;
  const completed = target > 0 && saved >= target;

  let status;
  if (completed) status = 'completed';
  else if (targetDate && targetDate < today) status = 'overdue';
  else if (saved <= 0) status = 'not_started';
  else status = 'in_progress';

  return {
    targetAmount: round2(target),
    savedAmount: round2(saved),
    remaining: round2(Math.max(target - saved, 0)),
    excess: round2(Math.max(saved - target, 0)),
    progress: Math.min(actualProgress, 100),
    actualProgress,
    status,
    daysRemaining: targetDate ? Math.round((targetDate - today) / DAY_MS) : null,
  };
};

module.exports = { goalMetrics };
