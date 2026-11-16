// ---------------------------------------------------------------------------
// Phase 12 - recurrence maths. PURE (no DB, no clock). All dates are UTC calendar days (midnight UTC).
//
// A rule is { frequency: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', startDate }. The n-th occurrence (n = 0, 1, 2...)
// is ALWAYS computed from the original startDate, never from the previous occurrence, so rounding a date down
// in a short month can never "drift" later occurrences:
//
//   DAILY     startDate + n days
//   WEEKLY    startDate + 7n days                      (the weekday of startDate is preserved)
//   MONTHLY   same day-of-month as startDate, n months later. If that month is shorter than the day
//             (a schedule that starts on the 29th/30th/31st) the LAST DAY of that month is used instead,
//             and the original day is used again in months that have it.
//             e.g. start Jan 31 -> Feb 28 (Feb 29 in a leap year) -> Mar 31 -> Apr 30 -> May 31 ...
//   (every rule accepts an optional `interval` k >= 1, default 1: every k days / k weeks / k months / k years.
//    Subscriptions use it for QUARTERLY = MONTHLY x3 and CUSTOM = DAILY x N.)
//   YEARLY    same month/day as startDate, n years later. A Feb 29 start runs on Feb 29 in leap years
//             and on Feb 28 in other years.
//
// endDate (optional, inclusive): no occurrence after it is ever produced.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const toDay = (d) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// The n-th occurrence of the rule (n >= 0).
const stepOf = (rule) => Math.max(1, Math.floor(Number(rule.interval) || 1));

const occurrenceAt = (rule, n) => {
  const s = rule.startDate;
  const k = stepOf(rule);
  const sy = s.getUTCFullYear(); const sm = s.getUTCMonth(); const sd = s.getUTCDate();
  switch (rule.frequency) {
    case 'DAILY': return new Date(s.getTime() + n * k * DAY_MS);
    case 'WEEKLY': return new Date(s.getTime() + n * k * 7 * DAY_MS);
    case 'MONTHLY': {
      const total = sm + n * k;
      const y = sy + Math.floor(total / 12);
      const m = ((total % 12) + 12) % 12;
      return utc(y, m, Math.min(sd, daysInMonth(y, m)));
    }
    case 'YEARLY': {
      const y = sy + n * k;
      return utc(y, sm, Math.min(sd, daysInMonth(y, sm)));
    }
    default: throw new Error(`Unknown frequency: ${rule.frequency}`);
  }
};

// Index of the first occurrence on or after `date`.
const indexOnOrAfter = (rule, date) => {
  const d = toDay(date);
  const s = rule.startDate;
  const k = stepOf(rule);
  if (d <= s) return 0;
  switch (rule.frequency) {
    case 'DAILY': return Math.ceil((d - s) / (k * DAY_MS));
    case 'WEEKLY': return Math.ceil((d - s) / (k * 7 * DAY_MS));
    case 'MONTHLY': {
      const months = (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + (d.getUTCMonth() - s.getUTCMonth());
      let n = Math.floor(months / k);
      if (occurrenceAt(rule, n) < d) n += 1;
      return n;
    }
    case 'YEARLY': {
      let n = Math.floor((d.getUTCFullYear() - s.getUTCFullYear()) / k);
      if (occurrenceAt(rule, n) < d) n += 1;
      return n;
    }
    default: throw new Error(`Unknown frequency: ${rule.frequency}`);
  }
};

const withinEnd = (date, endDate) => !endDate || date <= endDate;

// First occurrence on or after `date`, or null if it would fall after endDate.
const firstOnOrAfter = (rule, date, endDate = null) => {
  const occ = occurrenceAt(rule, indexOnOrAfter(rule, date));
  return withinEnd(occ, endDate) ? occ : null;
};

// First occurrence strictly after `date` (which should itself be an occurrence), or null past endDate.
const nextAfter = (rule, date, endDate = null) => firstOnOrAfter(rule, new Date(toDay(date).getTime() + DAY_MS), endDate);

// Up to `count` occurrences starting at `from` (inclusive).
const upcoming = (rule, from, endDate = null, count = 5) => {
  const out = [];
  let d = firstOnOrAfter(rule, from, endDate);
  while (d && out.length < count) { out.push(d); d = nextAfter(rule, d, endDate); }
  return out;
};

// How many occurrences fall in [from, to] (to inclusive), capped.
const countBetween = (rule, from, to, endDate = null, cap = 5000) => {
  let n = 0;
  let d = firstOnOrAfter(rule, from, endDate);
  while (d && d <= to && n < cap) { n += 1; d = nextAfter(rule, d, endDate); }
  return n;
};

module.exports = { FREQUENCIES, DAY_MS, occurrenceAt, indexOnOrAfter, firstOnOrAfter, nextAfter, upcoming, countBetween, toDay, daysInMonth };
