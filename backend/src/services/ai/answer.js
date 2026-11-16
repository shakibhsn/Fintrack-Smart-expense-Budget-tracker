// Deterministic, plain-language answers built ONLY from the computed facts (never from a model). Every number shown comes from a tool result.
const SYM = { BDT: '৳', USD: '$', EUR: '€', GBP: '£', INR: '₹' };
const money = (n, cur = 'BDT') => `${Number(n) < 0 ? '-' : ''}${SYM[cur] || `${cur} `}${Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const pct = (n) => `${n}%`;

function render(result, { currency = 'BDT', focus } = {}) {
  const f = result.facts || {}; const m = (n) => money(n, currency); const rg = result.range;
  if (result.insufficient) return { text: result.insufficient, figures: [] };
  switch (result.tool) {
    case 'summary': {
      const lead = focus === 'savings'
        ? (f.savings >= 0 ? `In ${rg.label} you saved ${m(f.savings)}` : `In ${rg.label} you spent ${m(-f.savings)} more than you earned (savings ${m(f.savings)})`)
        : focus === 'income' ? `In ${rg.label} your income was ${m(f.income)}` : `In ${rg.label} you spent ${m(f.expense)}`;
      return {
        text: `${lead}. Income ${m(f.income)}, expenses ${m(f.expense)}, savings ${m(f.savings)}${f.savingsRate === null ? ' (no income recorded, so no savings rate)' : ` (a savings rate of ${pct(f.savingsRate)})`}, from ${f.transactionCount} transactions.`,
        figures: [['Income', m(f.income)], ['Expenses', m(f.expense)], ['Savings', m(f.savings)], ['Savings rate', f.savingsRate === null ? 'n/a' : pct(f.savingsRate)], ['Average daily expense', m(f.averageDailyExpense)], ['Transactions', String(f.transactionCount)]],
      };
    }
    case 'categories': {
      const t = f.top; const what = f.type === 'INCOME' ? 'income' : 'spending';
      return { text: `Your biggest ${what} category in ${rg.label} was ${t.category}: ${m(t.amount)}, which is ${pct(t.share)} of your ${m(f.total)} total across ${f.categoryCount} ${f.categoryCount === 1 ? 'category' : 'categories'}.`, figures: result.rows.map((r) => [r.category, `${m(r.amount)} (${pct(r.share)})`]) };
    }
    case 'compare': {
      const dir = f.change > 0 ? 'more' : f.change < 0 ? 'less' : 'the same';
      const head = f.change === 0 ? `Your ${f.what} was the same in both periods (${m(f.a.total)}).` : `Your ${f.what} was ${m(f.a.total)} in ${f.a.label} and ${m(f.b.total)} in ${f.b.label}: ${m(Math.abs(f.change))} ${dir}${f.changePercent === null ? ' (no percentage, because the earlier period was 0)' : ` (${f.change > 0 ? '+' : '-'}${pct(Math.abs(f.changePercent))})`}.`;
      return { text: `${head}${f.partialPeriodWarning ? ` Note: ${f.partialPeriodWarning}` : ''}`, figures: [[f.a.label, `${m(f.a.total)} (${f.a.transactions} transactions)`], [f.b.label, `${m(f.b.total)} (${f.b.transactions} transactions)`], ['Change', m(f.change)]] };
    }
    case 'budgets': {
      const parts = [`You have ${f.activeBudgets} active ${f.activeBudgets === 1 ? 'budget' : 'budgets'}.`];
      parts.push(f.over ? `${f.over} ${f.over === 1 ? 'is' : 'are'} over the limit.` : 'None is over its limit.');
      if (f.nearLimit) parts.push(`${f.nearLimit} ${f.nearLimit === 1 ? 'is' : 'are'} close to the limit (70% or more used).`);
      return { text: parts.join(' '), figures: result.rows.map((r) => [r.category, `${m(r.spent)} of ${m(r.limit)} (${pct(r.percentUsed)}, ${r.status}, ${r.daysLeft} days left)`]) };
    }
    case 'savings_outlook':
      return { text: `ESTIMATE: based on your recent months, next month you might earn about ${m(f.estimatedIncome)} and spend about ${m(f.estimatedExpense)} (likely between ${m(f.expenseLow)} and ${m(f.expenseHigh)}), which would leave about ${m(f.estimatedSavings)}${f.isDeficit ? ' (a shortfall)' : ''}. This is an estimate from past patterns, not a promise.`, figures: [['Estimated income', m(f.estimatedIncome)], ['Estimated expenses', m(f.estimatedExpense)], ['Likely expense range', `${m(f.expenseLow)} to ${m(f.expenseHigh)}`], ['Estimated savings', m(f.estimatedSavings)]] };
    case 'habits':
      return { text: `Across ${f.expenseTransactions} expense transactions in ${rg.label} you spent ${m(f.totalExpense)} (about ${m(f.averageDailyExpense)} a day). Most money went to ${f.topByAmount.map((c) => `${c.category} (${pct(c.share)})`).join(', ')}; your most frequent category is ${f.mostFrequent.category} (${f.mostFrequent.transactions} transactions).`, figures: [['Average per transaction', m(f.averageExpense)], ...result.rows.map((r, i) => [`Largest expense #${i + 1}`, `${m(r.amount)} (${r.category}, ${r.date})`])] };
    case 'health':
      return { text: `Your Financial Health Score is ${f.score}/100 (${f.level})${f.partial ? `, based on ${f.componentsEvaluated} of 5 components because some data is missing` : ''}.${(result.rows || []).length ? ` ${(result.rows || []).map((r) => (r.kind === 'strength' ? 'Strength: ' : 'To improve: ') + r.text).join(' ')}` : ''}`, figures: [['Score', `${f.score}/100`], ['Level', String(f.level)]] };
    case 'transactions':
      return { text: `${f.count} matching ${f.count === 1 ? 'transaction' : 'transactions'} in ${rg.label}, totalling ${m(f.total)}${f.shown < f.count ? `. The ${f.shown} newest are listed` : ''}.`, figures: result.rows.map((r) => [`${r.date} · ${r.category}`, `${r.type === 'INCOME' ? '+' : '-'}${m(r.amount)} ${r.description}`]) };
    default: return { text: 'Done.', figures: [] };
  }
}

module.exports = { render, money };
