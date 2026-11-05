// Shared money/percentage helpers. Every service that reports a savings rate or a
// "% change" goes through these so the whole app rounds and handles zero the same way.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round1 = (n) => Math.round((Number(n) + Number.EPSILON) * 10) / 10;

// Savings rate = (income - expense) / income * 100.
// Returns null (NOT 0) when there is no income: a rate cannot be computed, and
// showing "0%" would wrongly suggest the user saved nothing of a real income.
// Negative savings give a negative rate.
const savingsRate = (income, expense) => (income > 0 ? round1(((income - expense) / income) * 100) : null);

// Percentage change from `previous` to `current`.
// Returns null when previous <= 0 - a percentage against zero is meaningless/misleading.
const percentChange = (current, previous) => (previous > 0 ? round1(((current - previous) / previous) * 100) : null);

module.exports = { round1, round2, savingsRate, percentChange };
