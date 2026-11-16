const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { addMonths, startOfUtcDay, isoDay } = require('../utils/dateRange');
const { round2 } = require('../utils/finance');
const { simulate } = require('../utils/simulation');

const MAX_REFERENCE_MONTHS = 12;
const MAX_SAVED = 50;
const NO_DATA = 'Not enough financial history to start a simulation. Add transactions covering at least one complete calendar month.';

// The "current financial summary": monthly averages over the last `months` COMPLETE calendar months, never
// reaching before the user's first transaction (months with nothing recorded after that count as real zeros).
const getBaseline = async (userId, months = 3, now = new Date()) => {
  const thisMonth = addMonths(startOfUtcDay(now), 0);
  const first = await prisma.transaction.aggregate({ where: { userId }, _min: { date: true } });
  const firstDate = first._min.date;
  const empty = { available: false, message: NO_DATA, referencePeriod: null, income: 0, expense: 0, categories: [] };
  if (!firstDate) return empty;

  let start = addMonths(thisMonth, -Math.min(months, MAX_REFERENCE_MONTHS));
  const firstMonth = addMonths(startOfUtcDay(firstDate), 0);
  if (firstMonth > start) start = firstMonth;
  if (start >= thisMonth) return empty; // the only month with data is the current, incomplete one

  const n = Math.round((thisMonth.getUTCFullYear() * 12 + thisMonth.getUTCMonth()) - (start.getUTCFullYear() * 12 + start.getUTCMonth()));
  const rows = await prisma.transaction.groupBy({
    by: ['type', 'category'],
    where: { userId, date: { gte: start, lt: thisMonth } },
    _sum: { amount: true },
  });
  const income = rows.filter((r) => r.type === 'INCOME').reduce((s, r) => s + Number(r._sum.amount), 0) / n;
  const categories = rows.filter((r) => r.type === 'EXPENSE')
    .map((r) => ({ category: r.category, monthly: round2(Number(r._sum.amount) / n) }))
    .sort((a, b) => b.monthly - a.monthly || a.category.localeCompare(b.category));
  const expense = categories.reduce((s, c) => s + c.monthly, 0);

  return {
    available: true,
    message: null,
    referencePeriod: { start: isoDay(start), end: isoDay(new Date(thisMonth.getTime() - 86400000)), months: n },
    income: round2(income),
    expense: round2(expense),
    categories,
  };
};

// Server-side validation beyond the schema: every category an adjustment names must exist in the baseline.
const checkCategories = (baseline, inputs) => {
  const known = new Set(baseline.categories.map((c) => c.category));
  const unknown = [...Object.keys(inputs.categoryReductions || {}), ...Object.keys(inputs.budgetAdjustments || {})].filter((c) => !known.has(c));
  if (unknown.length) throw httpError(400, `Not found in your spending history: ${[...new Set(unknown)].join(', ')}`);
};

const calculate = async (userId, inputs, months) => {
  const baseline = await getBaseline(userId, months);
  if (!baseline.available) throw httpError(409, baseline.message);
  checkCategories(baseline, inputs);
  return { baseline, results: simulate(baseline, inputs) };
};

const serializeSaved = (r) => ({ id: r.id, name: r.name, inputs: r.inputs, baseline: r.baseline, results: r.results, createdAt: r.createdAt });

const save = async (userId, name, inputs, months) => {
  const count = await prisma.savedSimulation.count({ where: { userId } });
  if (count >= MAX_SAVED) throw httpError(409, `You can keep at most ${MAX_SAVED} saved simulations. Delete one first.`);
  const { baseline, results } = await calculate(userId, inputs, months); // re-validated + recomputed here; client numbers are never trusted
  const row = await prisma.savedSimulation.create({ data: { userId, name, inputs, baseline, results } });
  return serializeSaved(row);
};

const list = async (userId) => {
  const rows = await prisma.savedSimulation.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  return rows.map((r) => ({
    id: r.id, name: r.name, createdAt: r.createdAt,
    referencePeriod: r.baseline.referencePeriod,
    savingsImprovement: r.results.savingsImprovement, simulatedSavings: r.results.simulated.savings,
  }));
};

// A saved simulation plus the same inputs re-run against today's data, so the UI can show
// "original saved result" next to "recalculated now" and say whether the underlying data moved.
const get = async (userId, id) => {
  const row = await prisma.savedSimulation.findFirst({ where: { id, userId } });
  if (!row) throw httpError(404, 'Simulation not found');
  const saved = serializeSaved(row);
  const baseline = await getBaseline(userId, row.baseline.referencePeriod?.months || 3);
  let recalculated = null;
  if (baseline.available) {
    const known = new Set(baseline.categories.map((c) => c.category));
    // categories that vanished from the data simply drop out of the recalculation
    const prune = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => known.has(k)));
    const inputs = { ...row.inputs, categoryReductions: prune(row.inputs.categoryReductions), budgetAdjustments: prune(row.inputs.budgetAdjustments) };
    recalculated = { baseline, results: simulate(baseline, inputs) };
  }
  const changed = !recalculated
    || Math.abs(recalculated.baseline.income - row.baseline.income) > 0.005
    || Math.abs(recalculated.baseline.expense - row.baseline.expense) > 0.005;
  return { ...saved, recalculated, dataChangedSinceSaved: changed };
};

const remove = async (userId, id) => {
  const { count } = await prisma.savedSimulation.deleteMany({ where: { id, userId } });
  if (!count) throw httpError(404, 'Simulation not found');
};

module.exports = { getBaseline, calculate, save, list, get, remove, MAX_SAVED };
