const prisma = require('../config/prisma');
const { startOfUtcDay, isoDay, DAY_MS } = require('../utils/dateRange');
const { notify, getPreferences } = require('./notificationService');
const { toNumber } = require('../utils/serialize');

// ---------------------------------------------------------------------------
// Time-based notifications (nothing user-triggered fires them): subscription reminders, expiring plans, overdue goals,
// high-priority insights. Same rules as everything else: preferences respected, each event has a deterministic dedupeKey, so running
// these any number of times (scheduler tick, a page load, two instances) produces each notification exactly once.
//
// They run (1) in the existing scheduler tick for everyone and (2) for ONE user, throttled to once a minute, whenever that user
// opens their notifications, so hosts that sleep still catch up.
// ---------------------------------------------------------------------------

const money = (n) => `৳${Number(n).toLocaleString('en-US')}`;
const amountText = (s) => (s.currency === 'BDT' ? money(toNumber(s.amount)) : `${s.currency} ${toNumber(s.amount)}`);

async function subscriptionReminders({ userId, now = new Date() } = {}) {
  const today = startOfUtcDay(now);
  const subs = await prisma.subscription.findMany({ where: { ...(userId ? { userId } : {}), status: 'ACTIVE' } });
  const prefsCache = new Map();
  let created = 0;
  for (const s of subs) {
    if (!prefsCache.has(s.userId)) prefsCache.set(s.userId, await getPreferences(s.userId)); // eslint-disable-line no-await-in-loop
    const remind = s.reminderDays ?? prefsCache.get(s.userId).renewalReminderDays;
    const base = { category: 'SUBSCRIPTIONS', relatedType: 'subscription', relatedId: s.id, link: '/subscriptions' };
    const post = async (extra) => { if (await notify(s.userId, { ...base, ...extra })) created += 1; }; // eslint-disable-line no-await-in-loop
    const next = s.nextRenewalDate;
    if (next) {
      const days = Math.round((next - today) / DAY_MS);
      const date = isoDay(next);
      if (days <= 0 && !s.autoRecord) {
        await post({ type: 'INFO', title: `Renewal date reached: ${s.name}`, message: `"${s.name}" (${amountText(s)}) was due on ${date}. FinTrack has not recorded a payment: confirm it once you have paid.`, dedupeKey: `sub:${s.id}:renewal:${date}:due` });
      } else if (days > 0 && days <= remind) {
        await post({ type: 'INFO', title: `Upcoming renewal: ${s.name}`, message: `"${s.name}" renews on ${date} (${amountText(s)}), in ${days} day${days === 1 ? '' : 's'}.`, dedupeKey: `sub:${s.id}:renewal:${date}:reminder` });
      }
    }
    if (s.endDate) {
      const left = Math.round((s.endDate - today) / DAY_MS);
      if (left >= 0 && left <= remind) {
        await post({ type: 'INFO', title: `Subscription ending: ${s.name}`, message: `"${s.name}" ends on ${isoDay(s.endDate)} and will not renew after that.`, dedupeKey: `sub:${s.id}:expiring:${isoDay(s.endDate)}` });
      }
    }
  }
  return created;
}

async function goalOverdue({ userId, now = new Date() } = {}) {
  const today = startOfUtcDay(now);
  const goals = await prisma.savingsGoal.findMany({ where: { ...(userId ? { userId } : {}), targetDate: { lt: today } } });
  let created = 0;
  for (const g of goals) {
    if (toNumber(g.savedAmount) >= toNumber(g.targetAmount)) continue; // completed goals are never "overdue"
    // eslint-disable-next-line no-await-in-loop
    const n = await notify(g.userId, { category: 'GOALS', type: 'GOAL_PROGRESS', title: `Goal overdue: ${g.title}`, message: `The target date for "${g.title}" (${isoDay(g.targetDate)}) has passed and you have saved ${money(toNumber(g.savedAmount))} of ${money(toNumber(g.targetAmount))}.`, dedupeKey: `goal:${g.id}:overdue`, relatedType: 'goal', relatedId: g.id, link: '/savings-goals' });
    if (n) created += 1;
  }
  return created;
}

// Alert-level insights only (the most important ones), at most 3 per run, once per insight per period.
async function insightAlerts({ userId }) {
  const { getInsights } = require('./insightService'); // lazy: insights pull in analytics
  const data = await getInsights(userId);
  if (!data.sufficient) return 0;
  let created = 0;
  for (const i of data.insights.filter((x) => x.type === 'alert').slice(0, 3)) {
    // eslint-disable-next-line no-await-in-loop
    const n = await notify(userId, { category: 'INSIGHTS', type: 'INFO', title: i.title, message: i.message, dedupeKey: `insight:${i.id}:${data.period.start}`, relatedType: 'insight', relatedId: i.id, link: '/insights' });
    if (n) created += 1;
  }
  return created;
}

const lastRun = new Map();
const THROTTLE_MS = 60 * 1000;
async function runUserChecks(userId, now = new Date(), { force = false } = {}) {
  const prev = lastRun.get(userId) || 0;
  if (!force && Date.now() - prev < THROTTLE_MS) return null;
  lastRun.set(userId, Date.now());
  if (lastRun.size > 5000) lastRun.delete(lastRun.keys().next().value);
  const out = {};
  for (const [name, fn] of [['subscriptions', subscriptionReminders], ['goals', goalOverdue], ['insights', insightAlerts]]) {
    try { out[name] = await fn({ userId, now }); } catch (e) { console.error(`[notifications] ${name} check failed:`, e.message); out[name] = 0; } // eslint-disable-line no-await-in-loop
  }
  return out;
}

async function runAll(now = new Date()) {
  const out = {};
  for (const [name, fn] of [['subscriptions', subscriptionReminders], ['goals', goalOverdue]]) {
    try { out[name] = await fn({ now }); } catch (e) { console.error(`[notifications] ${name} pass failed:`, e.message); out[name] = 0; } // eslint-disable-line no-await-in-loop
  }
  return out;
}

module.exports = { subscriptionReminders, goalOverdue, insightAlerts, runUserChecks, runAll };
