const DAY_MS = 24 * 60 * 60 * 1000;

// Start (inclusive) and end (exclusive) of a calendar month, in UTC.
// Used by analytics (monthly trend, spending forecast) - these are always
// calendar-month based, unlike Budget, which has its own arbitrary date range.
const monthRange = (month, year) => ({
  start: new Date(Date.UTC(year, month - 1, 1)),
  end: new Date(Date.UTC(year, month, 1)),
});

const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const isoDay = (d) => d.toISOString().slice(0, 10);

const PERIODS = ['this_month', 'last_month', 'last_3_months', 'last_6_months', 'this_year', 'custom'];

// Resolves an analytics period to the range being reported and the "previous equivalent"
// range it is compared against. All ranges are [start, end) in UTC.
//
//   this_month      1st of this month -> today (inclusive)   vs the same number of days of last month
//   last_month      last calendar month                      vs the month before it
//   last_3_months   this month + the 2 before it (to today)  vs the 3 months before that
//   last_6_months   this month + the 5 before it (to today)  vs the 6 months before that
//   this_year       1 Jan -> today (inclusive)               vs the same span of last year
//   custom          startDate..endDate (both inclusive)      vs the equal-length window right before it
//
// "To-date" periods stop at today so a half-finished month is never compared against a whole one.
const resolveAnalyticsPeriod = (period, customStart, customEnd, now = new Date()) => {
  const today = startOfUtcDay(now);
  const tomorrow = addDays(today, 1);
  const monthStart = addMonths(today, 0);

  let start;
  let end;
  let prevStart;
  let prevEnd;
  let label;

  switch (period) {
    case 'last_month':
      start = addMonths(monthStart, -1);
      end = monthStart;
      prevStart = addMonths(start, -1);
      prevEnd = start;
      label = 'Last Month';
      break;
    case 'last_3_months':
    case 'last_6_months': {
      const n = period === 'last_3_months' ? 3 : 6;
      start = addMonths(monthStart, -(n - 1));
      end = tomorrow;
      prevStart = addMonths(start, -n);
      prevEnd = start;
      label = `Last ${n} Months`;
      break;
    }
    case 'this_year':
      start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      end = tomorrow;
      prevStart = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
      prevEnd = new Date(Math.min(prevStart.getTime() + (end.getTime() - start.getTime()), start.getTime()));
      label = 'This Year';
      break;
    case 'custom': {
      start = startOfUtcDay(customStart);
      end = addDays(startOfUtcDay(customEnd), 1);
      const len = end.getTime() - start.getTime();
      prevEnd = start;
      prevStart = new Date(start.getTime() - len);
      label = 'Custom Range';
      break;
    }
    case 'this_month':
    default:
      start = monthStart;
      end = tomorrow;
      prevStart = addMonths(monthStart, -1);
      // same number of days as elapsed this month, never spilling into the current month
      prevEnd = new Date(Math.min(prevStart.getTime() + (end.getTime() - start.getTime()), start.getTime()));
      label = 'This Month';
  }

  const describe = (s, e) => ({ start: isoDay(s), end: isoDay(addDays(e, -1)), days: Math.round((e - s) / DAY_MS) });
  return {
    label,
    start,
    end,
    prevStart,
    prevEnd,
    range: describe(start, end),
    previousRange: describe(prevStart, prevEnd),
  };
};

module.exports = { monthRange, resolveAnalyticsPeriod, PERIODS, DAY_MS, startOfUtcDay, addDays, addMonths, isoDay };
