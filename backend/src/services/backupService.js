const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { keyOf, validDay } = require('./importService');
const { checksumOf, BACKUP_FORMAT, EXCLUSIONS } = require('./exportService');
const subscriptionService = require('./subscriptionService');

// ---------------------------------------------------------------------------
// Phase 16 - user-level backup RESTORE.
//
// Safety rules (each one is tested):
//   * the file is validated BEFORE anything is shown or written: app/kind/version, checksum (corruption / hand edits), size caps, and
//     every single item against a strict schema. Invalid items are listed and skipped, never imported.
//   * PREVIEW writes nothing. It reports what would be added, what already exists (conflicts) and what a replace would delete.
//   * RESTORE needs confirm:true. The default mode is MERGE: existing data is never deleted or modified, items that already exist
//     are skipped (so restoring the same backup twice adds nothing). REPLACE (delete my current data first) additionally needs the
//     exact typed phrase REPLACE MY DATA.
//   * everything happens in ONE database transaction. Any error rolls the whole restore back, leaving the account exactly as it was.
//   * ownership: every row is created for the signed-in user with a NEW id. Ids inside the file are only labels used to re-link
//     transactions to their subscription / recurring schedule; they can never address another user's rows.
//   * restored recurring schedules come back PAUSED (so nothing is generated behind the user's back); resume them on the Recurring page.
//   * the account's name, currency and e-mail are not changed. Amounts are copied as numbers (no currency conversion).
// ---------------------------------------------------------------------------

const CONFIRM_PHRASE = 'REPLACE MY DATA';
const CAPS = { transactions: 50000, budgets: 1000, goals: 500, contributionsPerGoal: 5000, subscriptions: 200, recurring: 100, payments: 20000 };
const BACKUP_MAX_BYTES = 5 * 1024 * 1024;

const day = z.string().refine(validDay, 'Must be a real date written as YYYY-MM-DD');
const dayOpt = day.nullish();
const money = z.number({ error: 'Must be a number' }).positive('Must be greater than 0').max(999999999.99, 'Too large').refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimals');
const text = (max, min = 1) => z.string().trim().min(min, 'Required').max(max, `At most ${max} characters`);
const optText = (max) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const isoStamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid timestamp').nullish();

const txSchema = z.object({
  ref: z.string().max(100).nullish(), type: z.enum(['INCOME', 'EXPENSE']), amount: money, category: text(50), description: text(200), notes: optText(500), date: day,
  recurringRef: z.string().max(100).nullish(), subscriptionRef: z.string().max(100).nullish(), occurrenceDate: dayOpt,
});
const budgetSchema = z.object({ category: text(50), limit: money, startDate: day, endDate: day }).refine((b) => b.endDate >= b.startDate, { message: 'End date must be on or after the start date', path: ['endDate'] });
const goalSchema = z.object({
  title: text(100), targetAmount: money, savedAmount: z.number().min(0).max(999999999.99).optional(), targetDate: dayOpt, category: optText(50), description: optText(500), icon: optText(60),
  createdAt: isoStamp,
  contributions: z.array(z.object({ amount: money, date: day, note: optText(300) })).max(CAPS.contributionsPerGoal).default([]),
});
const subSchema = z.object({
  ref: z.string().max(100).nullish(), name: text(100), provider: optText(100), category: text(50), amount: money, currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM']), customIntervalDays: z.number().int().min(1).max(3650).nullish(), startDate: day, nextRenewalDate: dayOpt, billingAnchor: day, endDate: dayOpt,
  paymentMethod: optText(100), notes: optText(500), status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']), autoRecord: z.boolean().default(false), reminderDays: z.number().int().min(0).max(60).nullish(), pausedAt: isoStamp, cancelledAt: isoStamp,
}).refine((s) => s.frequency !== 'CUSTOM' || s.customIntervalDays, { message: 'Custom billing needs customIntervalDays', path: ['customIntervalDays'] });
const recSchema = z.object({
  ref: z.string().max(100).nullish(), title: text(100), type: z.enum(['INCOME', 'EXPENSE']), amount: money, category: text(50), notes: optText(500), frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  startDate: day, endDate: dayOpt, nextOccurrence: dayOpt, lastGeneratedAt: isoStamp,
});
const paySchema = z.object({
  subscriptionRef: z.string().min(1).max(100), dueDate: day, amount: money, currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  status: z.enum(['PAID', 'SKIPPED']), source: z.string().trim().max(30).default('MANUAL'), transactionRef: z.string().max(100).nullish(), paidAt: isoStamp,
});
const SCHEMAS = { transactions: txSchema, budgets: budgetSchema, goals: goalSchema, subscriptions: subSchema, payments: paySchema, recurring: recSchema };
const ENTITIES = Object.keys(SCHEMAS);
const D = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);

// ----- envelope -----
function checkEnvelope(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw httpError(400, 'This is not a FinTrack backup file.');
  if (backup.app !== 'FinTrack' || backup.kind !== 'user-backup') throw httpError(400, 'This is not a FinTrack backup file (it was not created by "Download full backup").');
  if (typeof backup.formatVersion !== 'number') throw httpError(400, 'The backup has no format version.');
  if (backup.formatVersion > BACKUP_FORMAT) throw httpError(400, `This backup was made by a newer version of FinTrack (format ${backup.formatVersion}). Update FinTrack to restore it.`);
  if (backup.formatVersion < 1) throw httpError(400, 'Unsupported backup format.');
  if (!backup.data || typeof backup.data !== 'object') throw httpError(400, 'The backup has no data section.');
  if (typeof backup.checksum !== 'string' || backup.checksum !== checksumOf(backup.data)) throw httpError(400, 'The backup file is damaged or was edited (its checksum does not match). Download a fresh backup and try again.');
  ENTITIES.forEach((e) => {
    const v = backup.data[e];
    if (v !== undefined && !Array.isArray(v)) throw httpError(400, `The backup section "${e}" is not a list.`);
    if (Array.isArray(v) && v.length > CAPS[e]) throw httpError(400, `The backup has too many ${e} (limit ${CAPS[e].toLocaleString('en-US')}).`);
  });
}

// ----- analysis -----
async function analyze(userId, backup, mode = 'merge') {
  checkEnvelope(backup);
  const valid = {}; const invalid = {};
  ENTITIES.forEach((e) => {
    valid[e] = []; invalid[e] = [];
    (backup.data[e] || []).forEach((item, i) => {
      const r = SCHEMAS[e].safeParse(item);
      if (r.success) valid[e].push({ index: i, v: r.data }); else invalid[e].push({ index: i + 1, errors: r.error.issues.slice(0, 4).map((x) => `${x.path.join('.') || 'item'}: ${x.message}`) });
    });
  });
  // goals: savedAmount is always the sum of contributions (the invariant the app keeps); report a mismatch instead of trusting it
  const warnings = [];
  valid.goals.forEach((g) => {
    const sum = Math.round(g.v.contributions.reduce((s, c) => s + c.amount, 0) * 100) / 100;
    g.sum = sum;
    if (g.v.savedAmount !== undefined && Math.abs(g.v.savedAmount - sum) > 0.005) warnings.push(`Goal "${g.v.title}": saved amount ${g.v.savedAmount} differs from its contributions (${sum}); the contributions are used.`);
    if (sum > g.v.targetAmount) { invalid.goals.push({ index: g.index + 1, errors: ['Contributions add up to more than the target'] }); g.bad = true; }
  });
  valid.goals = valid.goals.filter((g) => !g.bad);

  const merge = mode !== 'replace';
  const [exTx, exBud, exGoal, exSub, exRec, exPay] = merge ? await Promise.all([
    prisma.transaction.findMany({ where: { userId }, select: { type: true, amount: true, category: true, description: true, date: true } }),
    prisma.budget.findMany({ where: { userId }, select: { category: true, startDate: true, endDate: true } }),
    prisma.savingsGoal.findMany({ where: { userId }, select: { title: true, targetAmount: true, targetDate: true } }),
    prisma.subscription.findMany({ where: { userId }, select: { id: true, name: true, amount: true, frequency: true, startDate: true } }),
    prisma.recurringTransaction.findMany({ where: { userId }, select: { id: true, title: true, type: true, amount: true, frequency: true, startDate: true } }),
    prisma.subscriptionPayment.findMany({ where: { userId }, select: { subscriptionId: true, dueDate: true } }),
  ]) : [[], [], [], [], [], []];

  const plan = { add: {}, skip: {}, reasons: {} };
  // transactions: multiset match, so two genuinely identical transactions on both sides cancel pairwise (restoring twice adds nothing, real repeats survive)
  const have = new Map();
  exTx.forEach((t) => { const k = keyOf({ type: t.type, date: t.date.toISOString().slice(0, 10), amount: Number(t.amount), category: t.category, description: t.description }); have.set(k, (have.get(k) || 0) + 1); });
  valid.transactions.forEach((t) => { const k = keyOf(t.v); const n = have.get(k) || 0; if (n > 0) { have.set(k, n - 1); t.skip = 'already exists'; } });
  valid.budgets.forEach((b) => {
    if (exBud.some((x) => x.category === b.v.category && x.startDate.toISOString().slice(0, 10) === b.v.startDate && x.endDate.toISOString().slice(0, 10) === b.v.endDate)) b.skip = 'already exists';
    else if (exBud.some((x) => x.category === b.v.category && x.startDate <= D(b.v.endDate) && x.endDate >= D(b.v.startDate))) b.skip = 'overlaps an existing budget for the same category';
  });
  valid.goals.forEach((g) => { if (exGoal.some((x) => x.title.toLowerCase() === g.v.title.toLowerCase() && Number(x.targetAmount) === g.v.targetAmount && (x.targetDate ? x.targetDate.toISOString().slice(0, 10) : null) === (g.v.targetDate || null))) g.skip = 'already exists'; });
  valid.subscriptions.forEach((s) => { const m = exSub.find((x) => x.name.toLowerCase() === s.v.name.toLowerCase() && Number(x.amount) === s.v.amount && x.frequency === s.v.frequency && x.startDate.toISOString().slice(0, 10) === s.v.startDate); if (m) { s.skip = 'already exists'; s.existingId = m.id; } });
  valid.recurring.forEach((r) => { const m = exRec.find((x) => x.title.toLowerCase() === r.v.title.toLowerCase() && x.type === r.v.type && Number(x.amount) === r.v.amount && x.frequency === r.v.frequency && x.startDate.toISOString().slice(0, 10) === r.v.startDate); if (m) { r.skip = 'already exists'; r.existingId = m.id; } });
  // payments: a payment needs its subscription in the backup; one already recorded for the same (subscription, due date) is skipped
  const refToExisting = new Map(valid.subscriptions.filter((s) => s.existingId && s.v.ref).map((s) => [s.v.ref, s.existingId]));
  const refKnown = new Set(valid.subscriptions.filter((s) => s.v.ref).map((s) => s.v.ref));
  const havePay = new Set(exPay.map((p) => `${p.subscriptionId}|${p.dueDate.toISOString().slice(0, 10)}`));
  const seenPay = new Set();
  valid.payments.forEach((p) => {
    const key = `${p.v.subscriptionRef}|${p.v.dueDate}`;
    if (!refKnown.has(p.v.subscriptionRef)) p.skip = 'its subscription is not in the backup';
    else if (seenPay.has(key)) p.skip = 'duplicate payment for the same due date';
    else if (refToExisting.has(p.v.subscriptionRef) && havePay.has(`${refToExisting.get(p.v.subscriptionRef)}|${p.v.dueDate}`)) p.skip = 'already exists';
    else if (valid.subscriptions.find((s) => s.v.ref === p.v.subscriptionRef).skip && !refToExisting.has(p.v.subscriptionRef)) p.skip = 'its subscription was skipped';
    seenPay.add(key);
  });
  // caps on what the account may hold
  const room = { subscriptions: subscriptionService.MAX_PER_USER - exSub.length, recurring: 100 - exRec.length };
  ['subscriptions', 'recurring'].forEach((e) => { let left = room[e]; valid[e].forEach((x) => { if (x.skip) return; if (left > 0) left -= 1; else x.skip = `the account limit (${e === 'subscriptions' ? subscriptionService.MAX_PER_USER : 100}) would be exceeded`; }); });

  ENTITIES.forEach((e) => {
    const toAdd = valid[e].filter((x) => !x.skip);
    plan.add[e] = toAdd.length; plan.skip[e] = valid[e].length - toAdd.length;
    plan.reasons[e] = [...new Set(valid[e].filter((x) => x.skip).map((x) => x.skip))];
  });
  const fileCounts = Object.fromEntries(ENTITIES.map((e) => [e, (backup.data[e] || []).length]));
  return { valid, invalid, plan, warnings, fileCounts };
}

async function existingCounts(userId) {
  const [t, b, g, s, r, p] = await Promise.all([prisma.transaction.count({ where: { userId } }), prisma.budget.count({ where: { userId } }), prisma.savingsGoal.count({ where: { userId } }), prisma.subscription.count({ where: { userId } }), prisma.recurringTransaction.count({ where: { userId } }), prisma.subscriptionPayment.count({ where: { userId } })]);
  return { transactions: t, budgets: b, goals: g, subscriptions: s, recurring: r, payments: p };
}

async function preview(userId, { backup, mode = 'merge' }, user = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw httpError(400, 'Mode must be "merge" or "replace".');
  const a = await analyze(userId, backup, mode);
  const existing = await existingCounts(userId);
  const warnings = [...a.warnings];
  if (backup.profile && backup.profile.currency && user.currency && backup.profile.currency !== user.currency) warnings.push(`The backup was made in ${backup.profile.currency} but your account currency is ${user.currency}. Amounts are copied as they are (no conversion).`);
  if (a.plan.add.recurring) warnings.push('Recurring schedules are restored paused, so nothing is generated until you resume them.');
  const invalidTotal = ENTITIES.reduce((s, e) => s + a.invalid[e].length, 0);
  if (invalidTotal) warnings.push(`${invalidTotal} item${invalidTotal === 1 ? '' : 's'} in the file are invalid and will be skipped.`);
  if (mode === 'replace') warnings.push(`REPLACE will permanently delete your current data first: ${existing.transactions} transactions, ${existing.budgets} budgets, ${existing.goals} goals, ${existing.subscriptions} subscriptions and ${existing.recurring} recurring schedules.`);
  return {
    mode, format: { app: backup.app, version: backup.formatVersion, exportedAt: backup.exportedAt || null, checksumOk: true },
    fileCounts: a.fileCounts, existingCounts: existing,
    willAdd: a.plan.add, willSkip: a.plan.skip, skipReasons: a.plan.reasons,
    willDelete: mode === 'replace' ? existing : null,
    invalid: Object.fromEntries(ENTITIES.map((e) => [e, a.invalid[e].slice(0, 50)])), invalidTotal,
    warnings, exclusions: EXCLUSIONS, confirmPhrase: mode === 'replace' ? CONFIRM_PHRASE : null,
    conflicts: Object.fromEntries(ENTITIES.map((e) => [e, a.plan.skip[e]])),
  };
}

// opts.failAfter is a TEST HOOK (never reachable from HTTP): throws inside the transaction after the named step to prove the rollback.
async function restore(userId, { backup, mode = 'merge', confirm, confirmText, fileName }, opts = {}) {
  if (confirm !== true) throw httpError(400, 'Restoring needs your explicit confirmation (confirm: true).');
  if (mode !== 'merge' && mode !== 'replace') throw httpError(400, 'Mode must be "merge" or "replace".');
  if (mode === 'replace' && confirmText !== CONFIRM_PHRASE) throw httpError(400, `To replace your data, type exactly: ${CONFIRM_PHRASE}`);
  const a = await analyze(userId, backup, mode);
  const invalidTotal = ENTITIES.reduce((s, e) => s + a.invalid[e].length, 0);
  const totalAdd = ENTITIES.reduce((s, e) => s + a.plan.add[e], 0);
  if (!totalAdd && mode === 'merge') throw httpError(400, 'Nothing to restore: everything in this backup already exists in your account.');

  const subMap = new Map(); const recMap = new Map();
  const counts = {};
  try {
    const batch = await prisma.$transaction(async (tx) => {
      const failIf = (step) => { if (opts.failAfter === step) throw new Error(`injected failure after ${step}`); };
      const removed = {};
      if (mode === 'replace') {
        removed.transactions = (await tx.transaction.deleteMany({ where: { userId } })).count;
        removed.budgets = (await tx.budget.deleteMany({ where: { userId } })).count;
        removed.goals = (await tx.savingsGoal.deleteMany({ where: { userId } })).count;
        removed.payments = await tx.subscriptionPayment.count({ where: { userId } });
        removed.subscriptions = (await tx.subscription.deleteMany({ where: { userId } })).count;
        removed.recurring = (await tx.recurringTransaction.deleteMany({ where: { userId } })).count;
        failIf('delete');
      }
      // subscriptions + recurring first: new ids, so restored transactions can be re-linked
      const newSubs = [];
      a.valid.subscriptions.forEach((s) => {
        if (s.skip) { if (s.existingId && s.v.ref) subMap.set(s.v.ref, s.existingId); return; }
        const id = crypto.randomUUID(); if (s.v.ref) subMap.set(s.v.ref, id);
        newSubs.push({ id, userId, name: s.v.name, provider: s.v.provider, category: s.v.category, amount: s.v.amount, currency: s.v.currency, frequency: s.v.frequency, customIntervalDays: s.v.customIntervalDays ?? null, startDate: D(s.v.startDate), nextRenewalDate: D(s.v.nextRenewalDate), billingAnchor: D(s.v.billingAnchor), endDate: D(s.v.endDate), paymentMethod: s.v.paymentMethod, notes: s.v.notes, status: s.v.status, autoRecord: s.v.autoRecord, reminderDays: s.v.reminderDays ?? null, pausedAt: s.v.pausedAt ? new Date(s.v.pausedAt) : null, cancelledAt: s.v.cancelledAt ? new Date(s.v.cancelledAt) : null });
      });
      if (newSubs.length) await tx.subscription.createMany({ data: newSubs });
      counts.subscriptions = newSubs.length;
      const newRec = []; const now = new Date();
      a.valid.recurring.forEach((r) => {
        if (r.skip) { if (r.existingId && r.v.ref) recMap.set(r.v.ref, r.existingId); return; }
        const id = crypto.randomUUID(); if (r.v.ref) recMap.set(r.v.ref, id);
        newRec.push({ id, userId, title: r.v.title, type: r.v.type, amount: r.v.amount, category: r.v.category, notes: r.v.notes, frequency: r.v.frequency, startDate: D(r.v.startDate), endDate: D(r.v.endDate), nextOccurrence: D(r.v.nextOccurrence), lastGeneratedAt: r.v.lastGeneratedAt ? new Date(r.v.lastGeneratedAt) : null, isActive: false, pausedAt: now });
      });
      if (newRec.length) await tx.recurringTransaction.createMany({ data: newRec });
      counts.recurring = newRec.length;
      failIf('schedules');

      // goals with their contributions (savedAmount = sum of contributions, the app's invariant)
      let goalCount = 0; let contribCount = 0;
      for (const g of a.valid.goals.filter((x) => !x.skip)) {
        // eslint-disable-next-line no-await-in-loop
        const created = await tx.savingsGoal.create({ data: { userId, title: g.v.title, targetAmount: g.v.targetAmount, savedAmount: g.sum, targetDate: D(g.v.targetDate), category: g.v.category, description: g.v.description, ...(g.v.icon ? { icon: g.v.icon } : {}) } });
        goalCount += 1;
        if (g.v.contributions.length) { await tx.goalContribution.createMany({ data: g.v.contributions.map((c) => ({ goalId: created.id, userId, amount: c.amount, date: D(c.date), note: c.note })) }); contribCount += g.v.contributions.length; } // eslint-disable-line no-await-in-loop
      }
      counts.goals = goalCount; counts.goalContributions = contribCount;
      const budgets = a.valid.budgets.filter((x) => !x.skip);
      if (budgets.length) await tx.budget.createMany({ data: budgets.map((b) => ({ userId, category: b.v.category, limit: b.v.limit, startDate: D(b.v.startDate), endDate: D(b.v.endDate) })) });
      counts.budgets = budgets.length;
      failIf('budgets');

      // transactions: keep a link only when its schedule/subscription exists now; never create a second row for the same occurrence
      const linkedSubs = [...new Set([...subMap.values()])];
      const takenSub = new Set((linkedSubs.length ? await tx.transaction.findMany({ where: { userId, subscriptionId: { in: linkedSubs }, occurrenceDate: { not: null } }, select: { subscriptionId: true, occurrenceDate: true } }) : []).map((t) => `${t.subscriptionId}|${t.occurrenceDate.toISOString().slice(0, 10)}`));
      const linkedRecs = [...new Set([...recMap.values()])];
      const takenRec = new Set((linkedRecs.length ? await tx.transaction.findMany({ where: { userId, recurringId: { in: linkedRecs }, occurrenceDate: { not: null } }, select: { recurringId: true, occurrenceDate: true } }) : []).map((t) => `${t.recurringId}|${t.occurrenceDate.toISOString().slice(0, 10)}`));
      const rows = []; let linkedSkipped = 0; const txIdByRef = new Map();
      a.valid.transactions.filter((x) => !x.skip).forEach((t) => {
        const subscriptionId = t.v.subscriptionRef ? subMap.get(t.v.subscriptionRef) || null : null;
        const recurringId = !subscriptionId && t.v.recurringRef ? recMap.get(t.v.recurringRef) || null : null;
        const link = subscriptionId || recurringId; const od = link ? t.v.occurrenceDate : null;
        if (subscriptionId && od) { const k = `${subscriptionId}|${od}`; if (takenSub.has(k)) { linkedSkipped += 1; return; } takenSub.add(k); }
        if (recurringId && od) { const k = `${recurringId}|${od}`; if (takenRec.has(k)) { linkedSkipped += 1; return; } takenRec.add(k); }
        const id = crypto.randomUUID(); if (t.v.ref) txIdByRef.set(t.v.ref, id);
        rows.push({ id, userId, type: t.v.type, amount: t.v.amount, category: t.v.category, description: t.v.description, notes: t.v.notes, date: D(t.v.date), subscriptionId, recurringId, occurrenceDate: link && od ? D(od) : null });
      });
      for (let i = 0; i < rows.length; i += 500) await tx.transaction.createMany({ data: rows.slice(i, i + 500) }); // eslint-disable-line no-await-in-loop
      counts.transactions = rows.length; counts.transactionsSkippedAsDuplicateOccurrence = linkedSkipped;
      failIf('transactions');
      // subscription payment history (after the transactions it may point at)
      const payRows = a.valid.payments.filter((p) => !p.skip).map((p) => ({ subscriptionId: subMap.get(p.v.subscriptionRef), userId, dueDate: D(p.v.dueDate), amount: p.v.amount, currency: p.v.currency, status: p.v.status, source: p.v.source, transactionId: p.v.transactionRef ? txIdByRef.get(p.v.transactionRef) || null : null, paidAt: p.v.paidAt ? new Date(p.v.paidAt) : new Date() })).filter((p) => p.subscriptionId);
      for (let i = 0; i < payRows.length; i += 500) await tx.subscriptionPayment.createMany({ data: payRows.slice(i, i + 500), skipDuplicates: true }); // eslint-disable-line no-await-in-loop
      counts.payments = payRows.length;
      failIf('payments');

      return tx.importBatch.create({ data: { userId, kind: 'BACKUP_RESTORE', status: 'COMPLETED', fileName: fileName ? String(fileName).slice(0, 200) : null, mode, totalRows: ENTITIES.reduce((s, e) => s + a.fileCounts[e], 0), importedRows: Object.values({ t: counts.transactions, b: counts.budgets, g: counts.goals, s: counts.subscriptions, r: counts.recurring, p: counts.payments }).reduce((x, y) => x + y, 0), duplicateSkipped: ENTITIES.reduce((s, e) => s + a.plan.skip[e], 0) + linkedSkipped, invalidRows: invalidTotal, summary: { added: counts, skipped: a.plan.skip, removed: mode === 'replace' ? removed : null } } });
    }, { timeout: 120000, maxWait: 10000 });
    return { batchId: batch.id, mode, added: counts, skipped: a.plan.skip, invalid: invalidTotal, warnings: a.warnings };
  } catch (err) {
    if (err && err.statusCode) throw err;
    console.error('[restore] failed:', err.code || err.name);
    await prisma.importBatch.create({ data: { userId, kind: 'BACKUP_RESTORE', status: 'FAILED', fileName: fileName ? String(fileName).slice(0, 200) : null, mode, totalRows: ENTITIES.reduce((s, e) => s + a.fileCounts[e], 0), invalidRows: invalidTotal, errorMessage: 'The restore could not be completed and was rolled back. Your data was not changed.' } }).catch(() => {});
    throw httpError(500, 'The restore could not be completed and was rolled back. Your data was not changed.');
  }
}

module.exports = { preview, restore, analyze, CONFIRM_PHRASE, CAPS, BACKUP_MAX_BYTES };
