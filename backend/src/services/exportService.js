const crypto = require('crypto');
const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { toCsv } = require('../utils/csv');
const { toNumber } = require('../utils/serialize');
const { getBudgetsWithSpending } = require('./budgetService');
const subscriptions = require('./subscriptionService');

// ---------------------------------------------------------------------------
// Phase 16 - exports.
//
// CSV exports (transactions, budgets, goals, subscriptions, recurring) go through utils/csv.js: every text cell that starts with
// = + - @ (tab / CR) gets a leading apostrophe, so a description such as =HYPERLINK(...) cannot run as a spreadsheet formula.
// The transactions export uses the SAME columns as the import template, so an exported file can be imported again.
//
// The full JSON backup contains the user's own data only. EXCLUDED (and documented to the user): password hash, e-mail address,
// login tokens / secrets (none are stored server-side), notifications and notification preferences, unusual-spending findings,
// saved what-if simulations, saved report snapshots, import history, subscription payment history and recurring occurrence logs
// (derived or regenerated data), and all internal database ids of other records. A checksum detects a corrupted or hand-edited file
// (it is NOT a signature: it does not prove who made the file).
// ---------------------------------------------------------------------------

const MAX_EXPORT_ROWS = 200000;
const BACKUP_FORMAT = 1;
const day = (d) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d) => (d ? d.toISOString() : null);
const stamp = () => new Date().toISOString().slice(0, 10);

// ----- transactions (all or filtered) -----
async function transactionsCsv(userId, q = {}) {
  const where = { userId };
  if (q.type) where.type = q.type;
  if (q.category) where.category = q.category;
  if (q.search) where.OR = [{ description: { contains: q.search, mode: 'insensitive' } }, { notes: { contains: q.search, mode: 'insensitive' } }];
  if (q.dateFrom || q.dateTo) where.date = { ...(q.dateFrom ? { gte: q.dateFrom } : {}), ...(q.dateTo ? { lte: q.dateTo } : {}) };
  if (q.minAmount !== undefined || q.maxAmount !== undefined) where.amount = { ...(q.minAmount !== undefined ? { gte: q.minAmount } : {}), ...(q.maxAmount !== undefined ? { lte: q.maxAmount } : {}) };
  const count = await prisma.transaction.count({ where });
  if (count > MAX_EXPORT_ROWS) throw httpError(400, `That is ${count.toLocaleString('en-US')} transactions. Narrow the export with a date range (limit ${MAX_EXPORT_ROWS.toLocaleString('en-US')}).`);
  const rows = await prisma.transaction.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }] });
  const filtered = Object.keys(q).length > 0;
  return {
    filename: `fintrack-transactions${filtered ? '-filtered' : ''}-${stamp()}.csv`, count: rows.length,
    csv: toCsv([['date', 'type', 'amount', 'category', 'description', 'notes'], ...rows.map((t) => [day(t.date), t.type, toNumber(t.amount), t.category, t.description, t.notes])]),
  };
}

async function budgetsCsv(userId) {
  const b = await getBudgetsWithSpending(userId);
  return { filename: `fintrack-budgets-${stamp()}.csv`, count: b.length, csv: toCsv([['category', 'limit', 'start_date', 'end_date', 'status', 'spent', 'remaining', 'percent_used'], ...b.map((x) => [x.category, x.limit, day(x.startDate), day(x.endDate), x.status, x.spent, x.remaining, x.percentage])]) };
}

async function goalsCsv(userId) {
  const g = await prisma.savingsGoal.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { filename: `fintrack-goals-${stamp()}.csv`, count: g.length, csv: toCsv([['title', 'target_amount', 'saved_amount', 'percent_saved', 'target_date', 'category', 'description', 'created'], ...g.map((x) => [x.title, toNumber(x.targetAmount), toNumber(x.savedAmount), toNumber(x.targetAmount) > 0 ? Math.round((toNumber(x.savedAmount) / toNumber(x.targetAmount)) * 100) : 0, day(x.targetDate), x.category, x.description, day(x.createdAt)])]) };
}

async function subscriptionsCsv(userId) {
  const s = await subscriptions.list(userId, { status: 'all' });
  return {
    filename: `fintrack-subscriptions-${stamp()}.csv`, count: s.length,
    csv: toCsv([['name', 'provider', 'category', 'amount', 'currency', 'frequency', 'custom_interval_days', 'start_date', 'next_renewal_date', 'end_date', 'status', 'auto_record', 'estimated_monthly_cost', 'estimated_yearly_cost', 'payment_method', 'notes'],
      ...s.map((x) => [x.name, x.provider, x.category, x.amount, x.currency, x.frequency, x.customIntervalDays, x.startDate, x.nextRenewalDate, x.endDate, x.status, x.autoRecord, x.estimate && x.estimate.monthly, x.estimate && x.estimate.yearly, x.paymentMethod, x.notes])]),
  };
}

async function recurringCsv(userId) {
  const r = await prisma.recurringTransaction.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { filename: `fintrack-recurring-${stamp()}.csv`, count: r.length, csv: toCsv([['title', 'type', 'amount', 'category', 'frequency', 'start_date', 'end_date', 'next_occurrence', 'status', 'notes'], ...r.map((x) => [x.title, x.type, toNumber(x.amount), x.category, x.frequency, day(x.startDate), day(x.endDate), day(x.nextOccurrence), x.isActive ? 'active' : 'paused', x.notes])]) };
}

// ----- full backup -----
const EXCLUSIONS = [
  'Password hash and e-mail address (the backup contains your name and currency only)',
  'Login tokens and any other secrets (the server stores none)',
  'Notifications and notification preferences',
  'Unusual-spending findings, saved what-if simulations and saved report snapshots (derived data that can be recreated)',
  'Import history',
  'Recurring occurrence logs (the transactions they created ARE included, linked to their schedule). Subscription payment history IS included.',
];

const checksumOf = (data) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;

async function buildBackup(user, now = new Date()) {
  const userId = user.id;
  const [tx, budgets, goals, subs, rec, pays] = await Promise.all([
    prisma.transaction.findMany({ where: { userId }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.budget.findMany({ where: { userId }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] }),
    prisma.savingsGoal.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { contributions: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] } } }),
    prisma.subscription.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.recurringTransaction.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.subscriptionPayment.findMany({ where: { userId }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] }),
  ]);
  const data = {
    transactions: tx.map((t) => ({ ref: t.id, type: t.type, amount: toNumber(t.amount), category: t.category, description: t.description, notes: t.notes, date: day(t.date), recurringRef: t.recurringId, subscriptionRef: t.subscriptionId, occurrenceDate: day(t.occurrenceDate) })),
    budgets: budgets.map((b) => ({ category: b.category, limit: toNumber(b.limit), startDate: day(b.startDate), endDate: day(b.endDate) })),
    goals: goals.map((g) => ({ title: g.title, targetAmount: toNumber(g.targetAmount), savedAmount: toNumber(g.savedAmount), targetDate: day(g.targetDate), category: g.category, description: g.description, icon: g.icon, createdAt: iso(g.createdAt), contributions: g.contributions.map((c) => ({ amount: toNumber(c.amount), date: day(c.date), note: c.note })) })),
    subscriptions: subs.map((s) => ({ ref: s.id, name: s.name, provider: s.provider, category: s.category, amount: toNumber(s.amount), currency: s.currency, frequency: s.frequency, customIntervalDays: s.customIntervalDays, startDate: day(s.startDate), nextRenewalDate: day(s.nextRenewalDate), billingAnchor: day(s.billingAnchor), endDate: day(s.endDate), paymentMethod: s.paymentMethod, notes: s.notes, status: s.status, autoRecord: s.autoRecord, reminderDays: s.reminderDays, pausedAt: iso(s.pausedAt), cancelledAt: iso(s.cancelledAt) })),
    payments: pays.map((p) => ({ subscriptionRef: p.subscriptionId, dueDate: day(p.dueDate), amount: toNumber(p.amount), currency: p.currency, status: p.status, source: p.source, transactionRef: p.transactionId, paidAt: iso(p.paidAt) })),
    recurring: rec.map((r) => ({ ref: r.id, title: r.title, type: r.type, amount: toNumber(r.amount), category: r.category, notes: r.notes, frequency: r.frequency, startDate: day(r.startDate), endDate: day(r.endDate), nextOccurrence: day(r.nextOccurrence), lastGeneratedAt: iso(r.lastGeneratedAt) })),
  };
  return {
    filename: `fintrack-backup-${stamp()}.json`,
    backup: {
      app: 'FinTrack', kind: 'user-backup', formatVersion: BACKUP_FORMAT, exportedAt: now.toISOString(),
      profile: { name: user.name, currency: user.currency },
      counts: { transactions: data.transactions.length, budgets: data.budgets.length, goals: data.goals.length, goalContributions: data.goals.reduce((s, g) => s + g.contributions.length, 0), subscriptions: data.subscriptions.length, subscriptionPayments: data.payments.length, recurring: data.recurring.length },
      exclusions: EXCLUSIONS, checksum: checksumOf(data), data,
    },
  };
}

module.exports = { transactionsCsv, budgetsCsv, goalsCsv, subscriptionsCsv, recurringCsv, buildBackup, checksumOf, EXCLUSIONS, BACKUP_FORMAT, MAX_EXPORT_ROWS };
