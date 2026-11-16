// ---------------------------------------------------------------------------
// Phase 13 - subscription maths. PURE (no DB, no clock unless passed in).
//
// ESTIMATED cost normalisation. Every subscription is converted to a yearly and a monthly EQUIVALENT with one rule:
//
//   payments per year:  WEEKLY 365.25 / 7 (52.18)   MONTHLY 12   QUARTERLY 4   YEARLY 1   CUSTOM 365.25 / N days
//   yearly estimate  = amount x payments per year
//   monthly estimate = yearly estimate / 12
//
// These are ESTIMATES of what an active subscription costs over time. They are never "actual payments": actual
// payments are SubscriptionPayment rows the user (or an opted-in auto-record) confirmed.
// ---------------------------------------------------------------------------
const { DAY_MS } = require('./recurrence');

const DAYS_PER_YEAR = 365.25;
const CATEGORIES = ['Entertainment', 'Software', 'Education', 'Cloud Services', 'Productivity', 'Other'];
const FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM'];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const paymentsPerYear = (frequency, customIntervalDays) => {
  switch (frequency) {
    case 'WEEKLY': return DAYS_PER_YEAR / 7;
    case 'MONTHLY': return 12;
    case 'QUARTERLY': return 4;
    case 'YEARLY': return 1;
    case 'CUSTOM': return DAYS_PER_YEAR / Math.max(1, Number(customIntervalDays) || 1);
    default: throw new Error(`Unknown billing frequency: ${frequency}`);
  }
};

const yearlyEstimate = (sub) => round2(Number(sub.amount) * paymentsPerYear(sub.frequency, sub.customIntervalDays));
const monthlyEstimate = (sub) => round2((Number(sub.amount) * paymentsPerYear(sub.frequency, sub.customIntervalDays)) / 12);

// Maps a billing frequency onto the shared recurrence engine (utils/recurrence.js), anchored at the billing anchor date.
const recurrenceRule = (sub) => {
  const startDate = sub.billingAnchor;
  switch (sub.frequency) {
    case 'WEEKLY': return { frequency: 'WEEKLY', interval: 1, startDate };
    case 'MONTHLY': return { frequency: 'MONTHLY', interval: 1, startDate };
    case 'QUARTERLY': return { frequency: 'MONTHLY', interval: 3, startDate };
    case 'YEARLY': return { frequency: 'YEARLY', interval: 1, startDate };
    case 'CUSTOM': return { frequency: 'DAILY', interval: Math.max(1, Number(sub.customIntervalDays) || 1), startDate };
    default: throw new Error(`Unknown billing frequency: ${sub.frequency}`);
  }
};

// What the user sees. Priority: cancelled > expired > paused > active.
//  - cancelled / paused: exactly what the user chose
//  - expired: the end date has passed, or there is no further renewal (the plan ran out). Never stored.
const effectiveStatus = (sub, today) => {
  if (sub.status === 'CANCELLED') return 'cancelled';
  if ((sub.endDate && sub.endDate < today) || !sub.nextRenewalDate) return 'expired';
  if (sub.status === 'PAUSED') return 'paused';
  return 'active';
};

const daysBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

module.exports = { CATEGORIES, FREQUENCIES, DAYS_PER_YEAR, round2, paymentsPerYear, yearlyEstimate, monthlyEstimate, recurrenceRule, effectiveStatus, daysBetween };
