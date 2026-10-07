// Start (inclusive) and end (exclusive) of a calendar month, in UTC.
// Used by analytics (monthly trend, spending forecast) - these are always
// calendar-month based, unlike Budget, which now has its own arbitrary date range.
const monthRange = (month, year) => ({
  start: new Date(Date.UTC(year, month - 1, 1)),
  end: new Date(Date.UTC(year, month, 1)),
});

module.exports = { monthRange };
