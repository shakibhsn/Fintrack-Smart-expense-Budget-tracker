const { eq, done } = require('./lib');
const R = require('../../src/utils/recurrence');

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const seq = (freq, start, n) => Array.from({ length: n }, (_, i) => iso(R.occurrenceAt({ frequency: freq, startDate: D(start) }, i)));

// ---- monthly: 29th / 30th / 31st ----
eq('monthly 31st (2027, not leap): Jan31 Feb28 Mar31 Apr30 May31 Jun30', seq('MONTHLY', '2027-01-31', 6), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
eq('monthly 31st (2028, leap): Feb falls on the 29th', seq('MONTHLY', '2028-01-31', 3), ['2028-01-31', '2028-02-29', '2028-03-31']);
eq('monthly 30th: Feb 28 then back to Mar 30 (no drift)', seq('MONTHLY', '2027-01-30', 3), ['2027-01-30', '2027-02-28', '2027-03-30']);
eq('monthly 30th in a leap year: Feb 29', seq('MONTHLY', '2028-01-30', 2), ['2028-01-30', '2028-02-29']);
eq('monthly 29th: Feb 28 (non-leap) / Feb 29 (leap)', [seq('MONTHLY', '2027-01-29', 2)[1], seq('MONTHLY', '2028-01-29', 2)[1]], ['2027-02-28', '2028-02-29']);
eq('monthly from the 15th is always the 15th', seq('MONTHLY', '2027-01-15', 4), ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15']);
eq('monthly crosses the year boundary', seq('MONTHLY', '2026-11-30', 4), ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28']);
eq('monthly starting on Feb 28 stays on the 28th', seq('MONTHLY', '2027-02-28', 3), ['2027-02-28', '2027-03-28', '2027-04-28']);
eq('monthly starting on the 31st, 13 months later is still the 31st', iso(R.occurrenceAt({ frequency: 'MONTHLY', startDate: D('2027-01-31') }, 12)), '2028-01-31');

// ---- yearly / leap day ----
eq('yearly Feb 29: Feb 28 in non-leap years, Feb 29 in leap years', seq('YEARLY', '2024-02-29', 5), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
eq('yearly Jan 1', seq('YEARLY', '2026-01-01', 3), ['2026-01-01', '2027-01-01', '2028-01-01']);

// ---- weekly / daily ----
const weekly = seq('WEEKLY', '2026-11-02', 6);
eq('weekly keeps the weekday (all Mondays) across month/year ends', weekly.every((d) => D(d).getUTCDay() === D('2026-11-02').getUTCDay()), true);
eq('weekly sequence', weekly.slice(0, 4), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
eq('weekly crosses the year', seq('WEEKLY', '2026-12-28', 3), ['2026-12-28', '2027-01-04', '2027-01-11']);
eq('daily across a leap day', seq('DAILY', '2028-02-28', 4), ['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']);
eq('daily across a non-leap Feb', seq('DAILY', '2027-02-27', 3), ['2027-02-27', '2027-02-28', '2027-03-01']);

// ---- first on/after (property check against brute force) ----
let mismatches = 0; let checked = 0;
for (const [freq, start] of [['DAILY', '2027-03-05'], ['WEEKLY', '2027-03-05'], ['MONTHLY', '2027-01-31'], ['MONTHLY', '2027-01-30'], ['MONTHLY', '2027-01-29'], ['MONTHLY', '2028-01-31'], ['MONTHLY', '2027-05-15'], ['YEARLY', '2024-02-29'], ['YEARLY', '2027-03-05']]) {
  const rule = { frequency: freq, startDate: D(start) };
  const occ = Array.from({ length: 400 }, (_, i) => R.occurrenceAt(rule, i));
  for (let k = -40; k < 900; k += 1) {
    const q = new Date(D('2027-01-01').getTime() + k * 86400000);
    const brute = occ.find((o) => o >= q);
    if (brute && iso(R.firstOnOrAfter(rule, q)) !== iso(brute)) { mismatches += 1; console.log('MISMATCH', freq, start, iso(q), iso(R.firstOnOrAfter(rule, q)), iso(brute)); }
    checked += 1;
  }
  // strictly increasing, no duplicates
  eq(`${freq} ${start}: occurrences strictly increasing`, occ.every((o, i) => i === 0 || o > occ[i - 1]), true);
}
eq(`firstOnOrAfter agrees with brute force (${checked} lookups)`, mismatches, 0);
eq('nextAfter steps over exactly one occurrence', iso(R.nextAfter({ frequency: 'MONTHLY', startDate: D('2027-01-31') }, D('2027-02-28'))), '2027-03-31');

// ---- end date (inclusive) ----
const w = { frequency: 'WEEKLY', startDate: D('2027-03-01') };
eq('end date is inclusive: Mar 1, 8, 15 then stops', R.upcoming(w, D('2027-03-01'), D('2027-03-15'), 10).map(iso), ['2027-03-01', '2027-03-08', '2027-03-15']);
eq('end the day before an occurrence excludes it', R.upcoming(w, D('2027-03-01'), D('2027-03-14'), 10).map(iso), ['2027-03-01', '2027-03-08']);
eq('nextAfter the last occurrence => null', R.nextAfter(w, D('2027-03-15'), D('2027-03-15')), null);
eq('firstOnOrAfter after the end => null', R.firstOnOrAfter(w, D('2027-04-01'), D('2027-03-15')), null);
eq('start == end gives exactly one occurrence', R.upcoming({ frequency: 'DAILY', startDate: D('2027-03-05') }, D('2027-03-05'), D('2027-03-05'), 5).map(iso), ['2027-03-05']);
eq('countBetween (monthly 31st over a year)', R.countBetween({ frequency: 'MONTHLY', startDate: D('2027-01-31') }, D('2027-01-01'), D('2027-12-31')), 12);
eq('date-times are treated as UTC calendar days', iso(R.firstOnOrAfter({ frequency: 'DAILY', startDate: D('2027-03-05') }, new Date('2027-03-07T18:30:00Z'))), '2027-03-07');
done();
