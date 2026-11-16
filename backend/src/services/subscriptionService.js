const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { startOfUtcDay, isoDay, DAY_MS } = require('../utils/dateRange');
const { firstOnOrAfter, nextAfter } = require('../utils/recurrence');
const M = require('../utils/subscriptionMath');
const { invalidate } = require('./derivedCache');
const notifications = require('./notificationService');

// ---------------------------------------------------------------------------
// Phase 13 - subscription tracker (lifecycle + estimated cost + actual payment history).
//
// How it relates to the rest of the app (documented in backend/README.md):
//  * A SUBSCRIPTION is a service you pay for (Netflix-style): status, renewal date, estimated cost.
//  * A RECURRING TRANSACTION (Phase 12) is a repeated ledger entry. They are separate; creating both for the same service would
//    double-record the cost, so create() returns a warning when it sees that.
//  * A renewal is NEVER assumed paid because its date arrived. It is recorded only when the user confirms it
//    (POST /:id/payments) or when they opted in with autoRecord. Either way the payment is one SubscriptionPayment row
//    (unique per subscription + due date) and, if wanted, ONE linked expense Transaction, so a cost is never counted twice in analytics.
//  * ESTIMATED costs (utils/subscriptionMath.js) are shown separately from ACTUAL payments and are never added to expense analytics.
// ---------------------------------------------------------------------------

const MAX_PER_USER = 200;
const AUTO_LATE_GRACE_DAYS = 62; // an auto-record run more than this late skips the missed renewal instead of back-filling it
const AUTO_MAX_PER_RUN = 24;

const stale = () => Object.assign(new Error('Subscription changed while recording'), { code: 'STALE' });
const isDuplicate = (e) => e && e.code === 'P2002';
const day = (d) => (d ? isoDay(d) : null);
const todayOf = (now) => startOfUtcDay(now);

const serialize = (s, today, extra = {}) => {
  const status = M.effectiveStatus(s, today);
  const next = s.nextRenewalDate;
  return {
    id: s.id, name: s.name, provider: s.provider ?? null, category: s.category, amount: Number(s.amount), currency: s.currency,
    frequency: s.frequency, customIntervalDays: s.customIntervalDays ?? null,
    startDate: day(s.startDate), nextRenewalDate: day(next), endDate: day(s.endDate),
    paymentMethod: s.paymentMethod ?? null, notes: s.notes ?? null,
    status, storedStatus: s.status.toLowerCase(), autoRecord: s.autoRecord, reminderDays: s.reminderDays ?? null,
    pausedAt: s.pausedAt, cancelledAt: s.cancelledAt, createdAt: s.createdAt,
    estimate: { monthly: M.monthlyEstimate(s), yearly: M.yearlyEstimate(s), basis: 'estimated' },
    daysUntilRenewal: next ? M.daysBetween(today, next) : null,
    isDue: !!next && next <= today && status === 'active', // date reached: needs the user's confirmation, NOT assumed paid
    ...extra,
  };
};

const userCurrency = async (userId) => (await prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }))?.currency || 'BDT';
const findOwned = async (id, userId, db = prisma) => {
  const s = await db.subscription.findFirst({ where: { id, userId } });
  if (!s) throw httpError(404, 'Subscription not found');
  return s;
};

const emitEvent = (userId, event, sub, extra) => {
  try { if (notifications.onSubscriptionEvent) notifications.onSubscriptionEvent(userId, event, sub, extra); } catch (e) { console.error('[subscriptions] notification hook failed:', e.message); }
};

// ----- create / read / update / delete -----
const create = async (userId, input, now = new Date()) => {
  const count = await prisma.subscription.count({ where: { userId } });
  if (count >= MAX_PER_USER) throw httpError(409, `You can track at most ${MAX_PER_USER} subscriptions.`);
  const base = await userCurrency(userId);
  const currency = input.currency || base;
  if (input.autoRecord && currency !== base) throw httpError(400, `Automatic payment recording is only available for subscriptions in your account currency (${base}).`);

  const today = todayOf(now);
  const startDate = startOfUtcDay(input.startDate);
  const endDate = input.endDate ? startOfUtcDay(input.endDate) : null;
  const anchor = input.nextRenewalDate ? startOfUtcDay(input.nextRenewalDate) : startDate;
  const draft = { frequency: input.frequency, customIntervalDays: input.frequency === 'CUSTOM' ? input.customIntervalDays : null, billingAnchor: anchor };
  let next = input.nextRenewalDate ? anchor : firstOnOrAfter(M.recurrenceRule(draft), today, endDate);
  if (next && endDate && next > endDate) next = null;

  const row = await prisma.subscription.create({
    data: {
      userId, name: input.name, provider: input.provider ?? null, category: input.category, amount: input.amount, currency,
      frequency: input.frequency, customIntervalDays: draft.customIntervalDays ?? null, startDate, nextRenewalDate: next, billingAnchor: anchor, endDate,
      paymentMethod: input.paymentMethod ?? null, notes: input.notes ?? null, autoRecord: !!input.autoRecord, reminderDays: input.reminderDays ?? null,
    },
  });

  // Warn (never block) if a recurring transaction with the same title and amount exists: recording both would double-count the cost.
  const warnings = [];
  const twin = await prisma.recurringTransaction.findFirst({ where: { userId, type: 'EXPENSE', title: { equals: input.name, mode: 'insensitive' }, amount: input.amount } });
  if (twin) warnings.push(`You already have a recurring transaction called "${twin.title}" with the same amount. Recording both would count this cost twice; keep only one of them.`);
  emitEvent(userId, 'created', row);
  return { subscription: serialize(row, today), warnings };
};

const list = async (userId, { status = 'all', days = 30 } = {}, now = new Date()) => {
  const today = todayOf(now);
  const rows = await prisma.subscription.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  const horizon = new Date(today.getTime() + days * DAY_MS);
  let items = rows.map((r) => serialize(r, today));
  if (status === 'upcoming') items = items.filter((s) => s.status === 'active' && s.nextRenewalDate && utcDate(s.nextRenewalDate) <= horizon).sort((a, b) => a.nextRenewalDate.localeCompare(b.nextRenewalDate));
  else if (status !== 'all') items = items.filter((s) => s.status === status);
  return items;
};
const utcDate = (s) => new Date(`${s}T00:00:00Z`);

const get = async (userId, id, now = new Date()) => {
  const s = await findOwned(id, userId);
  const payments = await prisma.subscriptionPayment.findMany({ where: { subscriptionId: id, userId }, orderBy: [{ dueDate: 'desc' }, { id: 'asc' }], take: 200 });
  return serialize(s, todayOf(now), {
    payments: payments.map((p) => ({ id: p.id, dueDate: day(p.dueDate), amount: Number(p.amount), currency: p.currency, status: p.status, source: p.source, transactionId: p.transactionId, paidAt: p.paidAt })),
  });
};

const update = async (userId, id, input, now = new Date()) => {
  const s = await findOwned(id, userId);
  const today = todayOf(now);
  const base = await userCurrency(userId);
  const data = {};
  ['name', 'category', 'amount', 'reminderDays'].forEach((k) => { if (input[k] !== undefined) data[k] = input[k]; });
  ['provider', 'paymentMethod', 'notes'].forEach((k) => { if (input[k] !== undefined) data[k] = input[k] || null; }); // '' clears, omitted keeps
  if (input.currency !== undefined) data.currency = input.currency;
  const currency = data.currency ?? s.currency;
  const autoRecord = input.autoRecord ?? s.autoRecord;
  if (autoRecord && currency !== base) throw httpError(400, `Automatic payment recording is only available for subscriptions in your account currency (${base}).`);
  if (input.autoRecord !== undefined) data.autoRecord = input.autoRecord;

  const frequency = input.frequency ?? s.frequency;
  const interval = frequency === 'CUSTOM' ? (input.customIntervalDays ?? s.customIntervalDays) : null;
  if (frequency === 'CUSTOM' && !interval) throw httpError(400, 'Custom billing needs the interval in days');
  const startDate = input.startDate ? startOfUtcDay(input.startDate) : s.startDate;
  const endDate = input.endDate === undefined ? s.endDate : (input.endDate ? startOfUtcDay(input.endDate) : null);
  if (endDate && endDate < startDate) throw httpError(400, 'End date must be on or after the start date');
  Object.assign(data, { frequency, customIntervalDays: interval, startDate, endDate });

  let anchor = s.billingAnchor;
  let next = s.nextRenewalDate;
  if (input.nextRenewalDate) { anchor = startOfUtcDay(input.nextRenewalDate); next = anchor; }
  else if ((frequency !== s.frequency || interval !== s.customIntervalDays) && next) anchor = next; // cadence changed: keep the date, follow the new cadence from it
  const rule = M.recurrenceRule({ frequency, customIntervalDays: interval, billingAnchor: anchor });
  if (next === null && (!endDate || endDate >= today)) next = firstOnOrAfter(rule, today, endDate); // an extended end date revives the schedule
  if (next && endDate && next > endDate) next = null;
  Object.assign(data, { billingAnchor: anchor, nextRenewalDate: next });

  const row = await prisma.subscription.update({ where: { id }, data });
  invalidate(userId);
  return serialize(row, today);
};

const remove = async (userId, id) => {
  const { count } = await prisma.subscription.deleteMany({ where: { id, userId } });
  if (!count) throw httpError(404, 'Subscription not found');
  invalidate(userId); // linked payment transactions are kept (their subscription link is cleared)
};

// ----- status changes (the USER's choice; nothing here moves money) -----
const pause = async (userId, id, now = new Date()) => {
  const s = await findOwned(id, userId);
  if (s.status === 'PAUSED') return serialize(s, todayOf(now));
  if (s.status === 'CANCELLED') throw httpError(409, 'A cancelled subscription cannot be paused. Resume it first if you re-subscribed.');
  const row = await prisma.subscription.update({ where: { id }, data: { status: 'PAUSED', pausedAt: now } });
  emitEvent(userId, 'paused', row);
  return serialize(row, todayOf(now));
};

// Resume policy: renewals missed while paused/cancelled are NOT charged or back-filled; the next renewal is the first one on or after today.
const resume = async (userId, id, now = new Date()) => {
  const s = await findOwned(id, userId);
  if (s.status === 'ACTIVE') return serialize(s, todayOf(now));
  const today = todayOf(now);
  let next = firstOnOrAfter(M.recurrenceRule(s), today, s.endDate);
  if (next && s.endDate && next > s.endDate) next = null;
  const row = await prisma.subscription.update({ where: { id }, data: { status: 'ACTIVE', pausedAt: null, cancelledAt: null, nextRenewalDate: next } });
  emitEvent(userId, 'resumed', row);
  return serialize(row, today);
};

const cancel = async (userId, id, now = new Date()) => {
  const s = await findOwned(id, userId);
  if (s.status === 'CANCELLED') return serialize(s, todayOf(now));
  const row = await prisma.subscription.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now, pausedAt: null } });
  emitEvent(userId, 'cancelled', row);
  return serialize(row, todayOf(now));
};

// ----- payments (actual, user-confirmed) -----
const advance = async (db, sub, due) => {
  const following = nextAfter(M.recurrenceRule(sub), due, sub.endDate);
  const { count } = await db.subscription.updateMany({ where: { id: sub.id, status: 'ACTIVE', nextRenewalDate: due }, data: { nextRenewalDate: following } });
  if (count !== 1) throw stale();
  return following;
};

const createTransactionFor = (db, sub, due, paidDate) => db.transaction.create({
  data: {
    userId: sub.userId, type: 'EXPENSE', amount: sub.amount, category: sub.category, description: sub.name,
    notes: `Subscription payment (renewal ${isoDay(due)})`, date: paidDate, subscriptionId: sub.id, occurrenceDate: due,
  },
});

// Records the payment for the CURRENT renewal date, advances to the next one, all-or-nothing.
const markPaid = async (userId, id, input = {}, now = new Date()) => {
  const base = await userCurrency(userId);
  const result = await prisma.$transaction(async (db) => {
    const sub = await findOwned(id, userId, db);
    if (sub.status !== 'ACTIVE') throw httpError(409, 'Only an active subscription can record a payment. Resume it first.');
    if (!sub.nextRenewalDate) throw httpError(409, 'This subscription has no upcoming renewal to record.');
    if (input.recordTransaction === true && sub.currency !== base) throw httpError(400, `An expense can only be recorded for subscriptions in your account currency (${base}).`);
    const due = sub.nextRenewalDate;
    const paidDate = input.paidDate ? startOfUtcDay(input.paidDate) : todayOf(now);
    const wantTx = input.recordTransaction !== false && sub.currency === base;

    let payment;
    try {
      payment = await db.subscriptionPayment.create({ data: { subscriptionId: sub.id, userId, dueDate: due, amount: sub.amount, currency: sub.currency, status: 'PAID', source: 'MANUAL', paidAt: now } });
    } catch (e) {
      if (isDuplicate(e)) throw httpError(409, `The renewal due ${isoDay(due)} was already recorded.`);
      throw e;
    }
    let txn = null;
    if (wantTx) {
      txn = await createTransactionFor(db, sub, due, paidDate);
      await db.subscriptionPayment.update({ where: { id: payment.id }, data: { transactionId: txn.id } });
    }
    const following = await advance(db, sub, due);
    return { sub, due, following, txn, paymentId: payment.id };
  });
  invalidate(userId);
  if (result.txn) await notifications.checkBudgetByCategoryAndDate(userId, result.sub.category, result.txn.date);
  return { subscription: await get(userId, id, now), recordedDueDate: isoDay(result.due), transactionId: result.txn ? result.txn.id : null };
};

// Auto-record (opt-in): same effect as markPaid, run by the scheduler / on demand, with the same duplicate protection.
const processSubscription = async (id, now = new Date()) => {
  const out = { recorded: 0, skipped: 0 };
  const today = todayOf(now);
  for (let guard = 0; guard < AUTO_MAX_PER_RUN; guard += 1) {
    // eslint-disable-next-line no-await-in-loop
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub || !sub.autoRecord || sub.status !== 'ACTIVE' || !sub.nextRenewalDate || sub.nextRenewalDate > today) break;
    const due = sub.nextRenewalDate;
    const late = Math.round((today - due) / DAY_MS);
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$transaction(async (db) => {
        if (late > AUTO_LATE_GRACE_DAYS) {
          await db.subscriptionPayment.upsert({ where: { subscriptionId_dueDate: { subscriptionId: id, dueDate: due } }, create: { subscriptionId: id, userId: sub.userId, dueDate: due, amount: sub.amount, currency: sub.currency, status: 'SKIPPED', source: 'AUTO' }, update: {} });
          await advance(db, sub, due);
          return;
        }
        const existing = await db.subscriptionPayment.findUnique({ where: { subscriptionId_dueDate: { subscriptionId: id, dueDate: due } } });
        if (existing) { await advance(db, sub, due); return; } // already handled elsewhere
        const payment = await db.subscriptionPayment.create({ data: { subscriptionId: id, userId: sub.userId, dueDate: due, amount: sub.amount, currency: sub.currency, status: 'PAID', source: 'AUTO', paidAt: now } });
        const txn = await createTransactionFor(db, sub, due, due);
        await db.subscriptionPayment.update({ where: { id: payment.id }, data: { transactionId: txn.id } });
        await advance(db, sub, due);
      });
      if (late > AUTO_LATE_GRACE_DAYS) out.skipped += 1; else out.recorded += 1;
    } catch (err) {
      if (isDuplicate(err) || err.code === 'STALE') continue;
      console.error(`[subscriptions] auto-record failed for ${id}:`, err.message);
      break;
    }
  }
  if (out.recorded) {
    const sub = await prisma.subscription.findUnique({ where: { id } });
    invalidate(sub.userId);
    emitEvent(sub.userId, 'auto-recorded', sub, { count: out.recorded });
  }
  return out;
};

const dueAutoWhere = (now, userId) => ({ ...(userId ? { userId } : {}), autoRecord: true, status: 'ACTIVE', nextRenewalDate: { not: null, lte: todayOf(now) } });
const processUser = async (userId, now = new Date()) => {
  const due = await prisma.subscription.findMany({ where: dueAutoWhere(now, userId), select: { id: true } });
  const total = { recorded: 0, skipped: 0 };
  for (const { id } of due) { const r = await processSubscription(id, now); total.recorded += r.recorded; total.skipped += r.skipped; } // eslint-disable-line no-await-in-loop
  return total;
};
const processAll = async (now = new Date()) => {
  const due = await prisma.subscription.findMany({ where: dueAutoWhere(now), select: { id: true } });
  const total = { subscriptions: due.length, recorded: 0, skipped: 0 };
  for (const { id } of due) {
    try { const r = await processSubscription(id, now); total.recorded += r.recorded; total.skipped += r.skipped; } catch (e) { console.error('[subscriptions] crashed:', e.message); } // eslint-disable-line no-await-in-loop
  }
  return total;
};

// ----- dashboard numbers -----
const summary = async (userId, { days = 30 } = {}, now = new Date()) => {
  const today = todayOf(now);
  const base = await userCurrency(userId);
  const rows = await prisma.subscription.findMany({ where: { userId } });
  const items = rows.map((r) => ({ raw: r, s: serialize(r, today) }));
  const by = (st) => items.filter((i) => i.s.status === st);
  const active = by('active');

  const perCurrency = new Map();
  active.forEach(({ s }) => {
    const c = perCurrency.get(s.currency) || { currency: s.currency, count: 0, monthly: 0, yearly: 0 };
    c.count += 1; c.monthly = M.round2(c.monthly + s.estimate.monthly); c.yearly = M.round2(c.yearly + s.estimate.yearly);
    perCurrency.set(s.currency, c);
  });
  const primary = perCurrency.get(base) || { currency: base, count: 0, monthly: 0, yearly: 0 };

  const horizon = new Date(today.getTime() + days * DAY_MS);
  const upcoming = active.filter(({ s }) => s.nextRenewalDate && utcDate(s.nextRenewalDate) <= horizon)
    .map(({ s }) => ({ id: s.id, name: s.name, provider: s.provider, category: s.category, renewalDate: s.nextRenewalDate, amount: s.amount, currency: s.currency, frequency: s.frequency, daysUntilRenewal: s.daysUntilRenewal, isDue: s.isDue }))
    .sort((a, b) => a.renewalDate.localeCompare(b.renewalDate));
  const upcomingTotals = {};
  upcoming.forEach((u) => { upcomingTotals[u.currency] = M.round2((upcomingTotals[u.currency] || 0) + u.amount); });

  const catMap = new Map();
  active.filter(({ s }) => s.currency === base).forEach(({ s }) => catMap.set(s.category, M.round2((catMap.get(s.category) || 0) + s.estimate.monthly)));
  const catTotal = [...catMap.values()].reduce((a, b) => a + b, 0);
  const categoryBreakdown = [...catMap.entries()].map(([category, monthly]) => ({ category, monthly, share: catTotal > 0 ? Math.round((monthly / catTotal) * 1000) / 10 : 0 })).sort((a, b) => b.monthly - a.monthly || a.category.localeCompare(b.category));

  const cancelledSince = new Date(today.getTime() - 90 * DAY_MS);
  const recentlyCancelled = by('cancelled').filter(({ raw }) => raw.cancelledAt && raw.cancelledAt >= cancelledSince)
    .map(({ s }) => ({ id: s.id, name: s.name, category: s.category, amount: s.amount, currency: s.currency, frequency: s.frequency, cancelledAt: s.cancelledAt, monthlyEstimate: s.estimate.monthly }))
    .sort((a, b) => new Date(b.cancelledAt) - new Date(a.cancelledAt));

  const topExpensive = active.filter(({ s }) => s.currency === base).map(({ s }) => ({ id: s.id, name: s.name, category: s.category, monthlyEstimate: s.estimate.monthly, yearlyEstimate: s.estimate.yearly, amount: s.amount, frequency: s.frequency }))
    .sort((a, b) => b.monthlyEstimate - a.monthlyEstimate || a.name.localeCompare(b.name)).slice(0, 5);

  // ACTUAL payments (confirmed ones only), last 12 calendar months, in the account currency
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const pays = await prisma.subscriptionPayment.findMany({ where: { userId, status: 'PAID', currency: base, paidAt: { gte: from } }, select: { amount: true, paidAt: true } });
  const months = [];
  for (let i = 11; i >= 0; i -= 1) { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)); months.push({ month: d.toISOString().slice(0, 7), total: 0 }); }
  pays.forEach((p) => { const m = months.find((x) => x.month === p.paidAt.toISOString().slice(0, 7)); if (m) m.total = M.round2(m.total + Number(p.amount)); });

  return {
    generatedAt: now.toISOString(), baseCurrency: base,
    counts: { active: active.length, paused: by('paused').length, cancelled: by('cancelled').length, expired: by('expired').length, total: items.length },
    estimated: { monthly: primary.monthly, yearly: primary.yearly, currency: base, basis: 'ESTIMATE: what your active subscriptions cost per month/year, normalised from their billing cycles (see formula). Not payments.', otherCurrencies: [...perCurrency.values()].filter((c) => c.currency !== base) },
    upcoming: { days, items: upcoming, totals: upcomingTotals, dueNow: upcoming.filter((u) => u.isDue).length },
    categoryBreakdown, topExpensive, recentlyCancelled,
    actualPayments: { basis: 'ACTUAL: renewals you confirmed (or auto-recorded) as paid.', currency: base, last12Months: M.round2(months.reduce((s, m) => s + m.total, 0)), thisMonth: months[months.length - 1].total, byMonth: months },
  };
};

module.exports = { create, list, get, update, remove, pause, resume, cancel, markPaid, processUser, processAll, processSubscription, summary, serialize, MAX_PER_USER, AUTO_LATE_GRACE_DAYS };
