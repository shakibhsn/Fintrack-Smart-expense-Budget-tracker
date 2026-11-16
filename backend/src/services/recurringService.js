const prisma = require('../config/prisma');
const httpError = require('../utils/httpError');
const { startOfUtcDay, isoDay, DAY_MS } = require('../utils/dateRange');
const { firstOnOrAfter, nextAfter, upcoming, countBetween } = require('../utils/recurrence');
const { invalidate } = require('./derivedCache');
const { checkBudgetByCategoryAndDate, notifyRecurring } = require('./notificationService');

// ---------------------------------------------------------------------------
// Phase 12 - recurring transactions.
//
// HOW GENERATION STAYS CORRECT (see also backend/README.md):
//  * A schedule stores `nextOccurrence`, the next date still to handle. Generating a date = create the
//    Transaction + the RecurringOccurrence row + move `nextOccurrence` forward, all in ONE database transaction.
//  * Idempotency is enforced by the database: Transaction has UNIQUE(recurringId, occurrenceDate) and
//    RecurringOccurrence has UNIQUE(recurringId, scheduledDate). Running the job twice, or from two server
//    instances at once, cannot create a second transaction for the same date: the loser hits the unique
//    constraint, rolls back and simply continues.
//  * Moving `nextOccurrence` is a compare-and-set (UPDATE ... WHERE nextOccurrence = <expected> AND isActive).
//    If the schedule was paused/edited/handled meanwhile, nothing is generated for that attempt.
//  * Failures are recorded (status FAILED, error text) and NOT advanced, so the same date is retried on the
//    next run; a failed date is never reported as generated.
// ---------------------------------------------------------------------------

const MAX_SCHEDULES_PER_USER = 100;
const LATE_GRACE_DAYS = 31;   // a date missed by more than this (e.g. long downtime) is SKIPPED, not generated
const MAX_BACKFILL = 60;      // most past occurrences that can be created on purpose (backfill / catch-up)
const MAX_PER_RUN = 400;      // safety cap on occurrences handled for one schedule in one run

const stale = () => Object.assign(new Error('Schedule changed while generating'), { code: 'STALE' });
const isDuplicate = (e) => e && e.code === 'P2002';
const rule = (r) => ({ frequency: r.frequency, startDate: r.startDate });
const day = (d) => (d ? isoDay(d) : null);
const dayAfter = (d) => new Date(d.getTime() + DAY_MS);

const statusOf = (r) => (!r.nextOccurrence ? 'completed' : r.isActive ? 'active' : 'paused');

const serialize = (r, extra = {}) => ({
  id: r.id,
  title: r.title,
  type: r.type,
  amount: Number(r.amount),
  category: r.category,
  notes: r.notes ?? null,
  frequency: r.frequency,
  startDate: day(r.startDate),
  endDate: day(r.endDate),
  nextOccurrence: day(r.nextOccurrence),
  isActive: r.isActive,
  status: statusOf(r),
  lastGeneratedAt: r.lastGeneratedAt,
  pausedAt: r.pausedAt,
  createdAt: r.createdAt,
  scheduleNote: ['MONTHLY', 'YEARLY'].includes(r.frequency) && r.startDate.getUTCDate() > 28
    ? (r.frequency === 'MONTHLY'
      ? `Runs on day ${r.startDate.getUTCDate()}; in months that are shorter it runs on the last day of the month.`
      : 'Runs every year on this date; on Feb 29 schedules it runs on Feb 28 in non-leap years.')
    : null,
  ...extra,
});

const findOwned = async (id, userId) => {
  const r = await prisma.recurringTransaction.findFirst({ where: { id, userId } });
  if (!r) throw httpError(404, 'Recurring transaction not found');
  return r;
};

// ----- notifications: central notify() (preferences + database-level de-duplication by event key) -----
const money = (n) => `৳${Number(n).toLocaleString('en-US')}`;

// ----- generation -----
const advance = async (db, rec, due, following, generated, now) => {
  const { count } = await db.recurringTransaction.updateMany({
    where: { id: rec.id, isActive: true, nextOccurrence: due },
    data: { nextOccurrence: following, ...(generated ? { lastGeneratedAt: now } : {}) },
  });
  if (count !== 1) throw stale();
};

const recordFailure = async (rec, due, err) => {
  const message = String(err.message || err).slice(0, 300);
  console.error(`[recurring] schedule ${rec.id} failed for ${isoDay(due)}: ${message}`);
  try {
    await prisma.recurringOccurrence.create({
      data: { recurringId: rec.id, userId: rec.userId, scheduledDate: due, status: 'FAILED', amount: rec.amount, error: message, attempts: 1 },
    });
  } catch (e) {
    if (!isDuplicate(e)) { console.error('[recurring] could not record failure:', e.message); return; }
    await prisma.recurringOccurrence.updateMany({
      where: { recurringId: rec.id, scheduledDate: due, status: 'FAILED' },
      data: { error: message, attempts: { increment: 1 } },
    });
  }
  await notifyRecurring(rec.userId, { title: `Recurring failed: ${rec.title} (${isoDay(due)})`, message: `"${rec.title}" could not be recorded for ${isoDay(due)}. It will be retried automatically.`, dedupeKey: `rec:${rec.id}:${isoDay(due)}:failed`, relatedId: rec.id });
};

// Handles every due date of one schedule (<= today), oldest first. Safe to call any number of times, from any
// number of processes. Returns what happened in THIS call.
const processSchedule = async (id, now = new Date(), { allowLate = false } = {}) => {
  const out = { generated: [], skipped: 0, failed: 0 };
  const today = startOfUtcDay(now);
  let owner = null;
  let last = null;

  for (let guard = 0; guard < MAX_PER_RUN; guard += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await prisma.recurringTransaction.findUnique({ where: { id } });
    if (!rec || !rec.isActive || !rec.nextOccurrence || rec.nextOccurrence > today) break;
    owner = rec.userId; last = rec;
    const due = rec.nextOccurrence;
    if (rec.endDate && due > rec.endDate) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.recurringTransaction.updateMany({ where: { id, nextOccurrence: due }, data: { nextOccurrence: null } });
      break;
    }
    const following = nextAfter(rule(rec), due, rec.endDate);
    const lateDays = Math.round((today - due) / DAY_MS);
    const key = { recurringId_scheduledDate: { recurringId: id, scheduledDate: due } };

    try {
      if (!allowLate && lateDays > LATE_GRACE_DAYS) {
        // Long outage: do not flood the user's ledger with old entries. Record the gap and move on.
        // eslint-disable-next-line no-await-in-loop
        await prisma.$transaction(async (db) => {
          await db.recurringOccurrence.upsert({
            where: key,
            create: { recurringId: id, userId: rec.userId, scheduledDate: due, status: 'SKIPPED', amount: rec.amount, error: `Missed by more than ${LATE_GRACE_DAYS} days (the server was not running), so it was skipped instead of back-filled.` },
            update: {},
          });
          await advance(db, rec, due, following, false, now);
        });
        out.skipped += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const txn = await prisma.$transaction(async (db) => {
        const existing = await db.recurringOccurrence.findUnique({ where: key });
        if (existing && existing.status !== 'FAILED') { // this date was already handled (e.g. by another instance)
          await advance(db, rec, due, following, false, now);
          return null;
        }
        const created = await db.transaction.create({
          data: {
            userId: rec.userId, type: rec.type, amount: rec.amount, category: rec.category,
            description: rec.title, notes: rec.notes, date: due, recurringId: rec.id, occurrenceDate: due,
          },
        });
        const data = { status: 'GENERATED', transactionId: created.id, amount: rec.amount, error: null, generatedAt: now };
        if (existing) await db.recurringOccurrence.update({ where: { id: existing.id }, data });
        else await db.recurringOccurrence.create({ data: { recurringId: rec.id, userId: rec.userId, scheduledDate: due, ...data } });
        await advance(db, rec, due, following, true, now);
        return created;
      });
      if (txn) out.generated.push(txn);
    } catch (err) {
      if (isDuplicate(err) || err.code === 'STALE') {
        // Someone else handled this date, or the schedule changed. If the pointer is still on this date the
        // date is evidently done: step over it so we can never loop on it.
        // eslint-disable-next-line no-await-in-loop
        const again = await prisma.recurringTransaction.findUnique({ where: { id } });
        if (again && again.isActive && again.nextOccurrence && again.nextOccurrence.getTime() === due.getTime() && isDuplicate(err)) {
          // eslint-disable-next-line no-await-in-loop
          await prisma.recurringTransaction.updateMany({ where: { id, nextOccurrence: due }, data: { nextOccurrence: following } });
        }
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await recordFailure(rec, due, err);
      out.failed += 1;
      break;
    }
  }

  if (out.generated.length && owner) await afterGenerated(owner, last, out.generated);
  return out;
};

// Everything that must react to new transactions: caches, budget alerts, user notifications.
const afterGenerated = async (userId, rec, txns) => {
  invalidate(userId);
  for (const t of txns) {
    if (t.type === 'EXPENSE') {
      // eslint-disable-next-line no-await-in-loop
      await checkBudgetByCategoryAndDate(userId, t.category, t.date);
    }
  }
  if (txns.length <= 3) {
    for (const t of txns) {
      // eslint-disable-next-line no-await-in-loop
      await notifyRecurring(userId, { title: `Recurring added: ${rec.title} (${isoDay(t.date)})`, message: `${t.type === 'INCOME' ? 'Income' : 'Expense'} of ${money(t.amount)} was recorded for "${rec.title}" (${t.category}).`, dedupeKey: `rec:${rec.id}:${isoDay(t.date)}:generated`, relatedId: rec.id });
    }
  } else {
    const dates = txns.map((t) => t.date).sort((a, b) => a - b);
    await notifyRecurring(userId, { title: `Recurring added: ${rec.title} (${isoDay(dates[0])} – ${isoDay(dates[dates.length - 1])})`, message: `${txns.length} transactions were recorded for "${rec.title}".`, dedupeKey: `rec:${rec.id}:${isoDay(dates[0])}:${isoDay(dates[dates.length - 1])}:digest`, relatedId: rec.id });
  }
};

const dueWhere = (now, userId) => ({
  ...(userId ? { userId } : {}),
  isActive: true,
  nextOccurrence: { not: null, lte: startOfUtcDay(now) },
});

// Processes every due schedule belonging to ONE user (used lazily when they open the app, and by the manual button).
const processUser = async (userId, now = new Date()) => {
  const due = await prisma.recurringTransaction.findMany({ where: dueWhere(now, userId), select: { id: true } });
  const total = { schedules: due.length, generated: 0, skipped: 0, failed: 0 };
  for (const { id } of due) {
    // eslint-disable-next-line no-await-in-loop
    const r = await processSchedule(id, now);
    total.generated += r.generated.length; total.skipped += r.skipped; total.failed += r.failed;
  }
  return total;
};

// ----- CRUD -----
const create = async (userId, input, now = new Date()) => {
  const count = await prisma.recurringTransaction.count({ where: { userId } });
  if (count >= MAX_SCHEDULES_PER_USER) throw httpError(409, `You can have at most ${MAX_SCHEDULES_PER_USER} recurring transactions.`);

  const today = startOfUtcDay(now);
  const startDate = startOfUtcDay(input.startDate);
  const endDate = input.endDate ? startOfUtcDay(input.endDate) : null;
  const r = { frequency: input.frequency, startDate };

  let next;
  if (input.backfill) {
    const past = countBetween(r, startDate, today, endDate, MAX_BACKFILL + 1);
    if (past > MAX_BACKFILL) throw httpError(400, `That would create more than ${MAX_BACKFILL} past transactions. Choose a more recent start date.`);
    next = firstOnOrAfter(r, startDate, endDate);
  } else {
    // Default policy: dates before today are NOT created. The schedule starts from the first occurrence >= today.
    next = firstOnOrAfter(r, today, endDate);
    if (!next) throw httpError(400, 'The end date has already passed, so this schedule would never create anything. Turn on "record past occurrences" to back-fill it instead.');
  }

  const row = await prisma.recurringTransaction.create({
    data: {
      userId, title: input.title, type: input.type, amount: input.amount, category: input.category, notes: input.notes ?? null,
      frequency: input.frequency, startDate, endDate, nextOccurrence: next,
    },
  });
  await processSchedule(row.id, now, { allowLate: !!input.backfill }); // anything due today (or back-filled) appears immediately
  return serialize(await prisma.recurringTransaction.findUnique({ where: { id: row.id } }), await extras(row.id));
};

const extras = async (id) => {
  const [generated, failed] = await Promise.all([
    prisma.recurringOccurrence.count({ where: { recurringId: id, status: 'GENERATED' } }),
    prisma.recurringOccurrence.count({ where: { recurringId: id, status: 'FAILED' } }),
  ]);
  return { generatedCount: generated, failedCount: failed };
};

const list = async (userId) => {
  const rows = await prisma.recurringTransaction.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  const groups = await prisma.recurringOccurrence.groupBy({ by: ['recurringId', 'status'], where: { userId }, _count: { _all: true } });
  const n = (id, s) => groups.find((g) => g.recurringId === id && g.status === s)?._count._all || 0;
  return rows.map((r) => serialize(r, { generatedCount: n(r.id, 'GENERATED'), failedCount: n(r.id, 'FAILED') }));
};

const get = async (userId, id) => {
  const r = await findOwned(id, userId);
  return serialize(r, await extras(id));
};

// Edits. Only the schedule changes: transactions already generated are never touched. Because future dates are
// generated on the day they fall due, every not-yet-generated occurrence automatically uses the new values.
const update = async (userId, id, input, now = new Date()) => {
  const rec = await findOwned(id, userId);
  const today = startOfUtcDay(now);
  const data = {};
  ['title', 'type', 'amount', 'category'].forEach((k) => { if (input[k] !== undefined) data[k] = input[k]; });
  if (input.notes !== undefined) data.notes = input.notes || null;

  const frequency = input.frequency ?? rec.frequency;
  const startDate = input.startDate ? startOfUtcDay(input.startDate) : rec.startDate;
  const endDate = input.endDate === undefined ? rec.endDate : (input.endDate ? startOfUtcDay(input.endDate) : null);
  if (endDate && endDate < startDate) throw httpError(400, 'End date must be on or after the start date');
  const structural = frequency !== rec.frequency || startDate.getTime() !== rec.startDate.getTime()
    || (endDate ? endDate.getTime() : null) !== (rec.endDate ? rec.endDate.getTime() : null);

  if (structural) {
    // Never re-create dates that were already handled: look forward from today or the day after the last handled date.
    const lastHandled = await prisma.recurringOccurrence.findFirst({ where: { recurringId: id }, orderBy: { scheduledDate: 'desc' } });
    const floor = new Date(Math.max(today.getTime(), lastHandled ? dayAfter(lastHandled.scheduledDate).getTime() : 0));
    Object.assign(data, { frequency, startDate, endDate, nextOccurrence: firstOnOrAfter({ frequency, startDate }, floor, endDate) });
  }

  const { count } = await prisma.recurringTransaction.updateMany({ where: { id, userId }, data });
  if (count !== 1) throw httpError(404, 'Recurring transaction not found');
  invalidate(userId);
  await processSchedule(id, now); // e.g. the edit moved the next date to today
  return get(userId, id);
};

const pause = async (userId, id, now = new Date()) => {
  const rec = await findOwned(id, userId);
  if (rec.isActive) {
    await prisma.recurringTransaction.updateMany({ where: { id, userId, isActive: true }, data: { isActive: false, pausedAt: now } });
    await notifyRecurring(userId, { title: `Recurring paused: ${rec.title}`, message: `"${rec.title}" is paused. Nothing will be recorded until you resume it.`, dedupeKey: `rec:${rec.id}:paused:${now.getTime()}`, relatedId: rec.id });
  }
  return get(userId, id);
};

// Resume policy: by default dates missed while paused are SKIPPED (recorded as such, up to the last 60) and the
// schedule continues from the next date on/after today, so nothing unexpected appears in the ledger.
// With catchUp: true the missed dates (max 60) are generated instead, on purpose.
const resume = async (userId, id, { catchUp = false } = {}, now = new Date()) => {
  const rec = await findOwned(id, userId);
  if (rec.isActive) return get(userId, id);
  const today = startOfUtcDay(now);
  const r = rule(rec);

  if (!rec.nextOccurrence) {
    await prisma.recurringTransaction.updateMany({ where: { id, userId }, data: { isActive: true, pausedAt: null } });
    return get(userId, id);
  }

  const missedEnd = new Date(today.getTime() - DAY_MS);
  const missed = rec.nextOccurrence <= missedEnd ? countBetween(r, rec.nextOccurrence, missedEnd, rec.endDate, MAX_BACKFILL * 40) : 0;

  if (catchUp) {
    if (missed > MAX_BACKFILL) throw httpError(400, `Catching up would create ${missed} transactions (the limit is ${MAX_BACKFILL}). Resume without catching up instead.`);
    await prisma.recurringTransaction.updateMany({ where: { id, userId }, data: { isActive: true, pausedAt: null } });
    await processSchedule(id, now, { allowLate: true });
  } else {
    const dates = [];
    for (let d = rec.nextOccurrence; d && d <= missedEnd && dates.length < MAX_BACKFILL * 40; d = nextAfter(r, d, rec.endDate)) dates.push(d);
    const next = firstOnOrAfter(r, today, rec.endDate);
    await prisma.$transaction(async (db) => {
      if (dates.length) {
        await db.recurringOccurrence.createMany({
          data: dates.slice(-MAX_BACKFILL).map((d) => ({ recurringId: id, userId, scheduledDate: d, status: 'SKIPPED', amount: rec.amount, error: 'Skipped while the schedule was paused.' })),
          skipDuplicates: true,
        });
      }
      await db.recurringTransaction.updateMany({ where: { id, userId }, data: { isActive: true, pausedAt: null, nextOccurrence: next } });
    });
    await processSchedule(id, now);
  }
  invalidate(userId);
  return get(userId, id);
};

// Deleting a schedule removes the schedule and its occurrence log. The transactions it already generated stay
// in the ledger (they simply no longer point at a schedule).
const remove = async (userId, id) => {
  const { count } = await prisma.recurringTransaction.deleteMany({ where: { id, userId } });
  if (!count) throw httpError(404, 'Recurring transaction not found');
  invalidate(userId);
};

const occurrences = async (userId, id, now = new Date()) => {
  const rec = await findOwned(id, userId);
  const rows = await prisma.recurringOccurrence.findMany({
    where: { recurringId: id, userId }, orderBy: [{ scheduledDate: 'desc' }, { id: 'asc' }], take: 200,
  });
  const history = rows.map((o) => ({
    id: o.id,
    scheduledDate: day(o.scheduledDate),
    generatedAt: o.generatedAt,
    amount: Number(o.amount),
    status: o.status,
    transactionId: o.transactionId,
    transactionDeleted: o.status === 'GENERATED' && !o.transactionId,
    error: o.error,
    attempts: o.attempts,
  }));
  const next = rec.nextOccurrence
    ? upcoming(rule(rec), rec.nextOccurrence, rec.endDate, 5).map((d) => ({
      scheduledDate: isoDay(d), amount: Number(rec.amount), status: 'UPCOMING', paused: !rec.isActive,
    }))
    : [];
  return { schedule: serialize(rec), upcoming: next, history };
};

module.exports = {
  create, list, get, update, pause, resume, remove, occurrences,
  processSchedule, processUser, dueWhere,
  MAX_SCHEDULES_PER_USER, LATE_GRACE_DAYS, MAX_BACKFILL,
};
