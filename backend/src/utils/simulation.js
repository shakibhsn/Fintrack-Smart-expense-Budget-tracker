const { round1, round2 } = require('./finance');

// ---------------------------------------------------------------------------
// Phase 11 - What-If simulation maths. PURE: no database, no side effects. The browser has an
// identical copy (simulateLocal in fintrack_application.html) for instant feedback while sliders move;
// the server runs THIS function when validating and saving, so the saved result is always the server's.
//
// baseline = { income, expense, categories: [{ category, monthly }] }  (monthly averages of real data)
// inputs   = {
//   categoryReductions: { [category]: percent 0..100 }   cut this category's monthly spending by that %
//   incomeIncrease:     amount >= 0                       extra monthly income
//   savingsTargetPct:   0..100 | null                     wanted savings as % of (simulated) income
//   budgetAdjustments:  { [category]: newMonthlyLimit }   compare a hypothetical limit with simulated spending
// }
//
//   simulated category   = current x (1 - reduction/100)
//   simulated expenses   = sum of simulated categories
//   simulated income     = current income + incomeIncrease
//   simulated savings    = simulated income - simulated expenses
//   savings rate         = savings / income x 100            (null when income is 0)
//   required max expenses for a target t% = simulated income x (1 - t/100)
// ---------------------------------------------------------------------------

const pct = (savings, income) => (income > 0 ? round1((savings / income) * 100) : null);

const simulate = (baseline, inputs = {}) => {
  const reductions = inputs.categoryReductions || {};
  const incomeIncrease = Number(inputs.incomeIncrease) || 0;
  const adjustments = inputs.budgetAdjustments || {};
  const target = inputs.savingsTargetPct === undefined || inputs.savingsTargetPct === null ? null : Number(inputs.savingsTargetPct);

  const curIncome = baseline.income;
  const curExpense = baseline.categories.reduce((s, c) => s + c.monthly, 0);
  const curSavings = curIncome - curExpense;

  const categories = baseline.categories.map((c) => {
    const reductionPct = Math.min(100, Math.max(0, Number(reductions[c.category]) || 0));
    const simulated = c.monthly * (1 - reductionPct / 100);
    return { category: c.category, current: round2(c.monthly), reductionPct, simulated: round2(simulated), change: round2(simulated - c.monthly), _sim: simulated };
  });
  const simExpense = categories.reduce((s, c) => s + c._sim, 0);
  const simIncome = curIncome + incomeIncrease;
  const simSavings = simIncome - simExpense;

  const result = {
    current: { income: round2(curIncome), expenses: round2(curExpense), savings: round2(curSavings), savingsRatePercent: pct(curSavings, curIncome) },
    simulated: { income: round2(simIncome), expenses: round2(simExpense), savings: round2(simSavings), savingsRatePercent: pct(simSavings, simIncome) },
    savingsImprovement: round2(simSavings - curSavings),
    expenseReduction: round2(curExpense - simExpense),
    incomeChange: round2(incomeIncrease),
    categories: categories.map(({ _sim, ...c }) => c),
    savingsTarget: null,
    budgetComparison: [],
  };

  if (target !== null) {
    if (simIncome <= 0) {
      result.savingsTarget = { targetPercent: target, available: false, message: 'A savings target needs some income to be calculated against.' };
    } else {
      const maxExpenses = simIncome * (1 - target / 100);
      const gap = simExpense - maxExpenses; // > 0: still spending too much to hit the target
      result.savingsTarget = {
        targetPercent: target, available: true,
        targetSavings: round2(simIncome * (target / 100)),
        requiredMaxExpenses: round2(maxExpenses),
        simulatedExpenses: round2(simExpense),
        achieved: gap <= 0.005,
        additionalReductionNeeded: round2(Math.max(0, gap)),
        reductionNeededFromCurrent: round2(Math.max(0, curExpense - maxExpenses)),
      };
    }
  }

  const known = new Map(categories.map((c) => [c.category, c]));
  Object.entries(adjustments).forEach(([category, limit]) => {
    const c = known.get(category);
    if (!c) return;
    const newLimit = Math.max(0, Number(limit) || 0);
    const spend = c._sim;
    result.budgetComparison.push({
      category, newLimit: round2(newLimit), currentMonthlySpend: c.current, simulatedSpend: round2(spend),
      difference: round2(newLimit - spend), isOver: spend > newLimit + 0.005,
      percentUsed: newLimit > 0 ? round1((spend / newLimit) * 100) : null,
    });
  });
  return result;
};

module.exports = { simulate };
