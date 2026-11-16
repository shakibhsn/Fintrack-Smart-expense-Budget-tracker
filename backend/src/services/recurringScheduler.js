const prisma = require('../config/prisma');
const { startOfUtcDay, isoDay, DAY_MS } = require('../utils/dateRange');
const { processSchedule, processUser, dueWhere } = require('./recurringService');
const subscriptions = require('./subscriptionService');
const { notifyRecurring } = require('./notificationService');
const notificationJobs = require('./notificationJobs');

// ---------------------------------------------------------------------------
// Scheduling design (Phase 12).
//
// The schedule itself lives in the DATABASE (RecurringTransaction.nextOccurrence), not in memory or a cron
// table, so restarts lose nothing. The in-process timer below is only a "wake-up" that asks the database
// "what is due?". Because that question is answered from stored state and generation is idempotent
// (unique keys + compare-and-set), it does not matter how the wake-up happens:
//   1. on server start      -> catches up everything that fell due while the server was down/asleep
//   2. every RECURRING_TICK_MS (default 15 min) while the server is running
//   3. lazily when a user opens the dashboard / transactions / recurring page (see processDueForUser),
//      which covers hosts that put the server to sleep: the first visit after waking processes what is due
// Multiple instances are safe: they may all run the job, and the database guarantees one transaction per date.
// Set RECURRING_SCHEDULER=off to disable the timer (e.g. when an external cron calls runDue instead).
// ---------------------------------------------------------------------------

let running = false;
let timer = null;
// heartbeat for /api/health/ready: has the background job run recently and without failing?
const stats = { enabled: false, everyMs: 0, startedAt: null, runs: 0, lastStartedAt: null, lastFinishedAt: null, lastDurationMs: null, lastError: null, lastResult: null };

// Heads-up notification (once per schedule+date) for schedules that will run tomorrow.
const notifyUpcoming = async (now) => {
  const tomorrow = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  const soon = await prisma.recurringTransaction.findMany({ where: { isActive: true, nextOccurrence: tomorrow } });
  for (const r of soon) {
    // eslint-disable-next-line no-await-in-loop
    await notifyRecurring(r.userId, { title: `Upcoming: ${r.title} on ${isoDay(tomorrow)}`, message: `${r.type === 'INCOME' ? 'Income' : 'An expense'} of ৳${Number(r.amount).toLocaleString('en-US')} ("${r.title}") will be recorded tomorrow.`, dedupeKey: `rec:${r.id}:${isoDay(tomorrow)}:upcoming`, relatedId: r.id });
  }
};

// One pass over every user's due schedules. Failures of one schedule never stop the others.
const runDue = async (now = new Date()) => {
  const due = await prisma.recurringTransaction.findMany({ where: dueWhere(now), select: { id: true }, orderBy: { nextOccurrence: 'asc' } });
  const total = { schedules: due.length, generated: 0, skipped: 0, failed: 0 };
  for (const { id } of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await processSchedule(id, now);
      total.generated += r.generated.length; total.skipped += r.skipped; total.failed += r.failed;
    } catch (e) {
      console.error(`[recurring] schedule ${id} crashed:`, e.message);
      total.failed += 1;
    }
  }
  try { await notifyUpcoming(now); } catch (e) { console.error('[recurring] upcoming notifications failed:', e.message); }
  try { await subscriptions.processAll(now); } catch (e) { console.error('[subscriptions] scheduler pass failed:', e.message); }
  try { await notificationJobs.runAll(now); } catch (e) { console.error('[notifications] scheduler pass failed:', e.message); }
  return total;
};

const tick = async () => {
  if (running) return; // never overlap with a previous pass in this process
  running = true;
  const began = Date.now(); stats.lastStartedAt = new Date(began).toISOString();
  try {
    const t = await runDue();
    stats.lastResult = { generated: t.generated, skipped: t.skipped, failed: t.failed }; stats.lastError = null;
    if (t.generated || t.skipped || t.failed) console.log(`[recurring] generated=${t.generated} skipped=${t.skipped} failed=${t.failed}`);
  } catch (e) {
    console.error('[recurring] scheduler pass failed:', e.message);
    stats.lastError = String(e.message).split('\n')[0].slice(0, 200);
  } finally {
    running = false;
    stats.runs += 1; stats.lastFinishedAt = new Date().toISOString(); stats.lastDurationMs = Date.now() - began;
  }
};

const start = () => {
  if (process.env.RECURRING_SCHEDULER === 'off') { console.log('[recurring] scheduler disabled (RECURRING_SCHEDULER=off)'); return; }
  const every = Number(process.env.RECURRING_TICK_MS) || 15 * 60 * 1000;
  stats.enabled = true; stats.everyMs = every; stats.startedAt = new Date().toISOString();
  setTimeout(tick, 1000).unref(); // startup catch-up, without delaying the server becoming ready
  timer = setInterval(tick, every);
  timer.unref();
};

const stop = () => { if (timer) clearInterval(timer); timer = null; stats.enabled = false; };

// healthy = disabled on purpose, or it has finished a pass within 3 intervals (a start-up grace period of 3 intervals) and the last pass did not fail
const status = (now = Date.now()) => {
  if (!stats.enabled) return { ok: true, enabled: false, note: 'disabled (RECURRING_SCHEDULER=off)' };
  const limit = 3 * stats.everyMs;
  const sinceStart = now - Date.parse(stats.startedAt);
  const age = stats.lastFinishedAt ? now - Date.parse(stats.lastFinishedAt) : null;
  const fresh = age === null ? sinceStart < limit : age < limit;
  return { ok: fresh && !stats.lastError, enabled: true, everyMs: stats.everyMs, runs: stats.runs, lastStartedAt: stats.lastStartedAt, lastFinishedAt: stats.lastFinishedAt, lastDurationMs: stats.lastDurationMs, lastError: stats.lastError, lastResult: stats.lastResult };
};

// Express middleware (mount AFTER `protect`): process the caller's own due schedules before the page's data is
// read, so a dashboard/transaction list opened after the server slept is already up to date. Never fails the request.
const processDueForUser = async (req, res, next) => {
  try { if (req.user) await processUser(req.user.id); } catch (e) { console.error('[recurring] on-demand processing failed:', e.message); }
  next();
};

module.exports = { runDue, start, stop, tick, status, processDueForUser, notifyUpcoming };
