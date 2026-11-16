const prisma = require('../config/prisma');
const { getBudgetsWithSpending } = require('./budgetService');
const { toNumber } = require('../utils/serialize');
const { isoDay } = require('../utils/dateRange');
const httpError = require('../utils/httpError');
const email = require('./emailService');

// ---------------------------------------------------------------------------
// Phase 14 - the ONE place notifications are created.
//
//   notify(userId, { category, type, title, message, dedupeKey, relatedType, relatedId, link })
//
//  * Preferences: if the user switched that category off, NOTHING is stored (not hidden, never created).
//  * De-duplication: every event has a deterministic dedupeKey; (userId, dedupeKey) is UNIQUE in the database, so the same event
//    can never notify twice, whatever the number of requests, retries or scheduler runs, even concurrent ones.
//  * Safety: it never throws. A failing notification must never break the transaction/budget/goal request that triggered it.
//  * Delivery: in-app only (stored in PostgreSQL, shown in the bell and the Notification Center). No email/SMS is sent.
// ---------------------------------------------------------------------------

const CATEGORIES = ['BUDGET', 'GOALS', 'SUBSCRIPTIONS', 'RECURRING', 'UNUSUAL_SPENDING', 'INSIGHTS', 'SYSTEM'];
const PREF_KEY = { BUDGET: 'budget', GOALS: 'goals', SUBSCRIPTIONS: 'subscriptions', RECURRING: 'recurring', UNUSUAL_SPENDING: 'unusualSpending', INSIGHTS: 'insights', SYSTEM: 'system' };
const DEFAULT_PREFS = { budget: true, goals: true, subscriptions: true, recurring: true, unusualSpending: true, insights: true, system: true, renewalReminderDays: 3, emailEnabled: false };
const money = (n) => `৳${Number(n).toLocaleString('en-US')}`;

// ----- preferences -----
const pickPrefs = (row) => ({ ...DEFAULT_PREFS, ...Object.fromEntries(Object.keys(DEFAULT_PREFS).map((k) => [k, row && row[k] !== undefined ? row[k] : DEFAULT_PREFS[k]])) });
const getPreferences = async (userId) => {
  const row = await prisma.notificationPreference.findUnique({ where: { userId } });
  return pickPrefs(row);
};
const updatePreferences = async (userId, patch) => {
  // e-mail can only be switched on when the server can really send it: no promise the product cannot keep
  if (patch.emailEnabled === true && !email.isConfigured()) throw httpError(409, 'E-mail delivery is not set up on this server, so it cannot be switched on. Notifications stay in the app.');
  const row = await prisma.notificationPreference.upsert({ where: { userId }, create: { userId, ...patch }, update: patch });
  return pickPrefs(row);
};

// ----- core -----
const notify = async (userId, { category, type = 'INFO', title, message, dedupeKey, relatedType = null, relatedId = null, link = null }) => {
  try {
    if (!CATEGORIES.includes(category)) throw new Error(`Unknown notification category: ${category}`);
    if (!dedupeKey) throw new Error('notify() needs a dedupeKey');
    const prefs = await getPreferences(userId);
    if (!prefs[PREF_KEY[category]]) return null; // the user opted out of this category
    const created = await prisma.notification.create({ data: { userId, category, type, title, message, dedupeKey, relatedType, relatedId, link } });
    if (prefs.emailEnabled && email.isConfigured()) setImmediate(() => deliverEmail(created).catch(() => {})); // after the in-app row exists; never blocks or breaks the caller
    return created;
  } catch (err) {
    if (err && err.code === 'P2002') return null; // this event was already notified
    console.error('notify failed:', err.message);
    return null;
  }
};

// ----- e-mail copy (only for users who opted in, only on a freshly created notification, at most once per notification) -----
const deliverEmail = async (n) => {
  const claimed = await prisma.notification.updateMany({ where: { id: n.id, emailStatus: null }, data: { emailStatus: 'SENDING' } }); // compare-and-set: two instances cannot both send
  if (!claimed.count) return;
  const user = await prisma.user.findUnique({ where: { id: n.userId }, select: { email: true, name: true } });
  const r = user ? await email.send(n.userId, user, n) : { ok: false, reason: 'NO_USER' };
  await prisma.notification.update({ where: { id: n.id }, data: r.ok ? { emailStatus: 'SENT', emailedAt: new Date() } : { emailStatus: r.reason === 'RATE_LIMITED' ? 'SKIPPED' : 'FAILED' } }).catch(() => {});
};

// ----- budgets -----
// A notification is raised only when spending reaches a threshold: 70%, 90%, 100% (limit reached) and over 100%.
// The highest level reached is announced once per budget + limit (the limit is part of the key, so raising the limit re-arms it).
const budgetLevel = (b) => (b.isOverBudget ? 'over' : b.percentage >= 100 ? 'full' : b.percentage >= 90 ? '90' : b.percentage >= 70 ? '70' : null);

const checkBudgetByCategoryAndDate = async (userId, category, onDate) => {
  try {
    const budgets = await getBudgetsWithSpending(userId);
    const matches = budgets.filter((b) => b.category === category && b.startDate <= onDate && onDate <= b.endDate);
    for (const b of matches) {
      const level = budgetLevel(b);
      if (!level) continue;
      const range = `${isoDay(b.startDate)} – ${isoDay(b.endDate)}`;
      const base = { userId, category: 'BUDGET', relatedType: 'budget', relatedId: b.id, link: '/budgets', dedupeKey: `budget:${b.id}:${level}:${b.limit}` };
      const text = {
        70: ['BUDGET_WARNING', `Budget at 70%: ${category}`, `Your ${category} budget has reached 70% usage (${money(b.spent)} of ${money(b.limit)}, ${range}).`],
        90: ['BUDGET_CRITICAL', `Budget at 90%: ${category}`, `Your ${category} budget has reached 90% usage (${money(b.spent)} of ${money(b.limit)}, ${range}).`],
        full: ['BUDGET_CRITICAL', `Budget limit reached: ${category}`, `Your ${category} budget has reached 100% of its limit (${money(b.limit)}, ${range}).`],
        over: ['BUDGET_EXCEEDED', `Budget exceeded: ${category}`, `You've gone over your ${category} budget by ${money(b.overBy)} (${b.percentage}% used, ${range}).`],
      }[level];
      // eslint-disable-next-line no-await-in-loop
      await notify(userId, { ...base, type: text[0], title: text[1], message: text[2] });
    }
  } catch (err) {
    console.error('checkBudgetByCategoryAndDate failed:', err.message);
  }
};

// ----- savings goals -----
const MILESTONES = [75, 50, 25];
const progressOf = (goal) => { const t = toNumber(goal.targetAmount); return t > 0 ? (toNumber(goal.savedAmount) / t) * 100 : 0; };

const onGoalCreated = (userId, goal) => notify(userId, {
  category: 'GOALS', type: 'GOAL_PROGRESS', title: `Goal created: ${goal.title}`,
  message: `You're saving ${money(toNumber(goal.targetAmount))} for "${goal.title}".`,
  dedupeKey: `goal:${goal.id}:created`, relatedType: 'goal', relatedId: goal.id, link: '/savings-goals',
});

// After a contribution: ONE notification. A milestone/completion message replaces the plain "contribution added" one, and each
// milestone (25/50/75%) and completion is announced only once per goal.
const onGoalContribution = async (userId, goal, contribution = null) => {
  try {
    const pct = progressOf(goal);
    const t = toNumber(goal.targetAmount);
    const base = { category: 'GOALS', type: 'GOAL_PROGRESS', relatedType: 'goal', relatedId: goal.id, link: '/savings-goals' };
    let sent = null;
    if (pct >= 100) {
      sent = await notify(userId, { ...base, title: `Goal completed: ${goal.title}`, message: `Congratulations! You reached your ${money(t)} target for "${goal.title}".`, dedupeKey: `goal:${goal.id}:completed` });
    } else {
      const m = MILESTONES.find((x) => pct >= x);
      if (m) sent = await notify(userId, { ...base, title: `${m}% of your goal: ${goal.title}`, message: `Congratulations! Your ${goal.title} goal is now ${m}% complete (${money(toNumber(goal.savedAmount))} of ${money(t)}).`, dedupeKey: `goal:${goal.id}:m${m}` });
    }
    if (!sent && contribution) {
      await notify(userId, { ...base, title: `Contribution added: ${goal.title}`, message: `${money(toNumber(contribution.amount))} was added to "${goal.title}" (${Math.round(pct)}% complete).`, dedupeKey: `goal:${goal.id}:contribution:${contribution.id}` });
    }
  } catch (err) { console.error('onGoalContribution failed:', err.message); }
};
// kept for older call sites: milestone check without a specific contribution
const checkGoalMilestones = (userId, goal) => onGoalContribution(userId, goal, null);

// ----- subscriptions (events from subscriptionService; renewal reminders live in notificationJobs) -----
const onSubscriptionEvent = async (userId, event, sub, extra = {}) => {
  const base = { category: 'SUBSCRIPTIONS', relatedType: 'subscription', relatedId: sub.id, link: '/subscriptions' };
  const stamp = Date.now();
  const text = {
    paused: [`Subscription paused: ${sub.name}`, `"${sub.name}" is paused. No renewals or reminders until you resume it.`, `sub:${sub.id}:paused:${stamp}`],
    resumed: [`Subscription resumed: ${sub.name}`, `"${sub.name}" is active again. Renewals missed meanwhile were not charged.`, `sub:${sub.id}:resumed:${stamp}`],
    cancelled: [`Subscription cancelled: ${sub.name}`, `You marked "${sub.name}" as cancelled. Remember to cancel it with the provider too.`, `sub:${sub.id}:cancelled:${stamp}`],
    'auto-recorded': [`Payment recorded: ${sub.name}`, `${extra.count || 1} renewal payment(s) for "${sub.name}" were recorded automatically.`, `sub:${sub.id}:auto:${stamp}`],
  }[event];
  if (text) await notify(userId, { ...base, title: text[0], message: text[1], dedupeKey: text[2] });
};

// ----- recurring transactions (used by recurringService / scheduler) -----
const notifyRecurring = (userId, { title, message, dedupeKey, relatedId }) =>
  notify(userId, { category: 'RECURRING', type: 'RECURRING', title, message, dedupeKey, relatedType: 'recurring', relatedId: relatedId || null, link: '/recurring' });

// ----- system -----
const createWelcomeNotification = (userId) => notify(userId, {
  category: 'SYSTEM', type: 'INFO', title: 'Welcome to FinTrack',
  message: 'Add your first transaction, set a budget, and create a savings goal to get started.', dedupeKey: 'welcome', link: '/dashboard',
});
const notifySystem = (userId, { title, message, dedupeKey, link = null }) => notify(userId, { category: 'SYSTEM', type: 'INFO', title, message, dedupeKey, link });

module.exports = {
  CATEGORIES, PREF_KEY, DEFAULT_PREFS, getPreferences, updatePreferences, notify, deliverEmail,
  checkBudgetByCategoryAndDate, budgetLevel, onGoalCreated, onGoalContribution, checkGoalMilestones, onSubscriptionEvent, notifyRecurring,
  createWelcomeNotification, notifySystem,
};
