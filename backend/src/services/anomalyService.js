const prisma = require('../config/prisma');
const { addMonths, startOfUtcDay, DAY_MS } = require('../utils/dateRange');
const { round1, round2 } = require('../utils/finance');
const { cached } = require('./derivedCache');
const { notify } = require('./notificationService');

// ---------------------------------------------------------------------------
// Phase 10 - unusual spending detection.
//
// Explainable statistical rules over the user's OWN expense history. Every finding says what was
// compared with what. Nothing here claims fraud, and nothing modifies a transaction.
//
// Rules (thresholds below; override any of them with the ANOMALY_THRESHOLDS env var, a JSON object
// merged over the defaults, e.g. ANOMALY_THRESHOLDS={"large":{"iqrMultiplier":2}}):
//
//  LARGE_TRANSACTION   An expense from the last `windowDays` days is flagged when, within its OWN category,
//                      amount > Q3 + iqrMultiplier x IQR of the user's other transactions in that category
//                      (last `historyDays` days) AND amount >= minMedianRatio x that category's median.
//                      Needs >= minCategoryTx other transactions in the category: no per-category baseline,
//                      no alert. At most maxPerRun are reported (largest ratio first).
//  CATEGORY_INCREASE   Spending in a category over the last 30 days vs the average of the previous
//                      `baselineWindows` 30-day windows (only windows inside the user's history). Flagged when
//                      it is >= minIncreasePct higher, the baseline category was active in >= minActiveWindows
//                      windows, and the rise is >= minDiffShare% of the user's average monthly expenses
//                      (so tiny categories do not raise alerts).
//  UNUSUAL_MONTH       Total expenses of the last complete month, and of the current month so far, vs the mean of
//                      up to `maxPriorMonths` earlier complete months (>= minPriorMonths needed). Flagged when it is
//                      >= minZ standard deviations above the mean AND >= minIncreasePct above it.
//  REPEATED_INCREASE   A category whose 30-day spending rose by >= minStepPct in each of `windows` consecutive
//                      30-day windows (a sustained change rather than a one-off). Replaces CATEGORY_INCREASE for it.
//
// No detection is produced at all unless there are >= minExpenseTransactions expense transactions spanning
// >= minHistoryDays days.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  minExpenseTransactions: 15,
  minHistoryDays: 45,
  large: { windowDays: 30, historyDays: 180, minCategoryTx: 8, iqrMultiplier: 1.5, minMedianRatio: 2, maxPerRun: 5 },
  categoryIncrease: { baselineWindows: 3, minActiveWindows: 2, minIncreasePct: 30, minDiffShare: 5 },
  monthly: { minPriorMonths: 3, maxPriorMonths: 5, minZ: 1.5, minIncreasePct: 25 },
  repeated: { windows: 4, minStepPct: 15 },
};

const mergeDeep = (base, over) => {
  const out = { ...base };
  Object.keys(over || {}).forEach((k) => {
    out[k] = over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object'
      ? mergeDeep(base[k], over[k]) : over[k];
  });
  return out;
};
const loadThresholds = () => {
  try { return process.env.ANOMALY_THRESHOLDS ? mergeDeep(DEFAULTS, JSON.parse(process.env.ANOMALY_THRESHOLDS)) : DEFAULTS; } catch (e) {
    console.error('Invalid ANOMALY_THRESHOLDS, using defaults:', e.message);
    return DEFAULTS;
  }
};

const WINDOW = 30;
const dayOf = (d) => Math.floor(d.getTime() / DAY_MS);
const dateOfDay = (n) => new Date(n * DAY_MS);
const money = (n) => `৳${Math.round(n).toLocaleString('en-US')}`;
const monthKey = (d) => d.toISOString().slice(0, 7);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

// ----- statistics (exported for tests) -----
const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const stdDev = (v) => (v.length < 2 ? 0 : Math.sqrt(v.reduce((a, b) => a + (b - mean(v)) ** 2, 0) / v.length));

// ----- pure detection over loaded expense rows -----
// expenses: [{ id, amount, category, date: Date, description }]; firstExpenseDate: earliest expense ever.
const detect = ({ expenses, firstExpenseDate }, th = DEFAULTS, now = new Date()) => {
  const todayN = dayOf(startOfUtcDay(now));
  const rows = expenses
    .map((e) => ({ ...e, amount: Number(e.amount), day: dayOf(e.date) }))
    .filter((e) => e.day <= todayN); // future-dated entries are not "spending so far"
  const firstDay = firstExpenseDate ? dayOf(firstExpenseDate) : todayN;
  const base = {
    config: th,
    dataAvailability: { expenseTransactions: rows.length, historyDays: rows.length ? todayN - firstDay + 1 : 0 },
  };
  if (rows.length < th.minExpenseTransactions || todayN - firstDay + 1 < th.minHistoryDays) {
    return { ...base, sufficient: false, detections: [] };
  }

  const out = [];
  const thisKey = monthKey(dateOfDay(todayN));

  // 30-day window k (0 = most recent): days [todayN-29-30k, todayN-30k]
  const winStart = (k) => todayN - (WINDOW - 1) - WINDOW * k;
  const winEnd = (k) => todayN - WINDOW * k;
  const sumIn = (list, k) => list.filter((e) => e.day >= winStart(k) && e.day <= winEnd(k)).reduce((s, e) => s + e.amount, 0);
  const byCat = new Map();
  rows.forEach((e) => { if (!byCat.has(e.category)) byCat.set(e.category, []); byCat.get(e.category).push(e); });

  // --- LARGE_TRANSACTION ---
  const L = th.large;
  const large = [];
  rows.filter((e) => e.day >= todayN - L.windowDays + 1).forEach((e) => {
    const others = (byCat.get(e.category) || []).filter((o) => o.id !== e.id && o.day >= todayN - L.historyDays + 1).map((o) => o.amount).sort((a, b) => a - b);
    if (others.length < L.minCategoryTx) return;
    const q1 = quantile(others, 0.25); const q3 = quantile(others, 0.75); const med = quantile(others, 0.5);
    const fence = q3 + L.iqrMultiplier * (q3 - q1);
    if (e.amount > fence && med > 0 && e.amount >= L.minMedianRatio * med) {
      large.push({ e, med, fence, ratio: e.amount / med });
    }
  });
  large.sort((a, b) => b.ratio - a.ratio).slice(0, L.maxPerRun).forEach(({ e, med, fence }) => {
    out.push({
      type: 'LARGE_TRANSACTION', fingerprint: `LARGE_TRANSACTION:${e.id}`, category: e.category, transactionId: e.id,
      periodKey: monthKey(e.date), actual: e.amount, baseline: med, difference: e.amount - med,
      percentChange: round1(((e.amount - med) / med) * 100), windowStart: e.date, windowEnd: e.date,
      explanation: `This ${money(e.amount)} ${e.category} expense is ${money(e.amount - med)} higher than your typical ${e.category} transaction (median ${money(med)}; your usual upper range is about ${money(fence)}).`,
      details: { rule: 'Amount above Q3 + IQR multiplier x IQR of your other transactions in this category, and at least the minimum multiple of the median.', description: e.description, median: round2(med), upperFence: round2(fence), comparedWith: 'your other expenses in this category over the last 180 days' },
    });
  });

  // --- monthly average expenses (for materiality) & valid baseline windows ---
  const validWindows = (from, to) => { const ks = []; for (let k = from; k <= to; k += 1) if (winStart(k) >= firstDay) ks.push(k); return ks; };
  const CI = th.categoryIncrease;
  const baseKs = validWindows(1, CI.baselineWindows);
  const avgMonthlyExpense = baseKs.length ? mean(baseKs.map((k) => sumIn(rows, k))) : 0;

  // --- REPEATED_INCREASE (computed first so it can replace CATEGORY_INCREASE) ---
  const R = th.repeated;
  const repeatedCats = new Set();
  const repKs = validWindows(0, R.windows - 1);
  if (repKs.length === R.windows) {
    byCat.forEach((list, category) => {
      const v = []; // oldest -> newest
      for (let k = R.windows - 1; k >= 0; k -= 1) v.push(sumIn(list, k));
      const rising = v[0] > 0 && v.every((x, i) => i === 0 || x >= v[i - 1] * (1 + R.minStepPct / 100));
      if (!rising) return;
      repeatedCats.add(category);
      out.push({
        type: 'REPEATED_INCREASE', fingerprint: `REPEATED_INCREASE:${category}:${thisKey}`, category, transactionId: null,
        periodKey: thisKey, actual: v[v.length - 1], baseline: v[0], difference: v[v.length - 1] - v[0],
        percentChange: round1(((v[v.length - 1] - v[0]) / v[0]) * 100), windowStart: dateOfDay(winStart(0)), windowEnd: dateOfDay(winEnd(0)),
        explanation: `Your ${category} spending has risen in each of the last ${R.windows - 1} periods of 30 days: ${v.map(money).join(' → ')}.`,
        details: { rule: `${category} spending grew by at least ${R.minStepPct}% in every consecutive 30-day period.`, periods: v.map(round2) },
      });
    });
  }

  // --- CATEGORY_INCREASE ---
  if (baseKs.length >= CI.minActiveWindows && avgMonthlyExpense > 0) {
    byCat.forEach((list, category) => {
      if (repeatedCats.has(category)) return;
      const bs = baseKs.map((k) => sumIn(list, k));
      if (bs.filter((x) => x > 0).length < CI.minActiveWindows) return;
      const avg = mean(bs); const cur = sumIn(list, 0);
      if (avg <= 0) return;
      const pct = ((cur - avg) / avg) * 100; const diff = cur - avg;
      if (pct >= CI.minIncreasePct && (diff / avgMonthlyExpense) * 100 >= CI.minDiffShare) {
        out.push({
          type: 'CATEGORY_INCREASE', fingerprint: `CATEGORY_INCREASE:${category}:${thisKey}`, category, transactionId: null,
          periodKey: thisKey, actual: cur, baseline: avg, difference: diff, percentChange: round1(pct),
          windowStart: dateOfDay(winStart(0)), windowEnd: dateOfDay(winEnd(0)),
          explanation: `Your ${category} spending in the last 30 days is ${money(cur)}, which is ${round1(pct)}% (${money(diff)}) higher than your recent 30-day average of ${money(avg)}.`,
          details: { rule: `${category} spending vs the average of the previous ${bs.length} 30-day period(s), flagged at +${CI.minIncreasePct}% or more.`, baselinePeriods: bs.map(round2) },
        });
      }
    });
  }

  // --- UNUSUAL_MONTH ---
  const M = th.monthly;
  const monthTotals = new Map();
  rows.forEach((e) => monthTotals.set(monthKey(e.date), (monthTotals.get(monthKey(e.date)) || 0) + e.amount));
  const firstMonthKey = monthKey(dateOfDay(firstDay));
  const monthsBefore = (key) => { // complete months strictly before `key`, oldest -> newest, inside history
    const list = []; let d = new Date(`${key}-01T00:00:00Z`);
    for (let i = 0; i < M.maxPriorMonths; i += 1) { d = addMonths(d, -1); if (monthKey(d) < firstMonthKey) break; list.unshift(monthKey(d)); }
    return list;
  };
  const lastComplete = monthKey(addMonths(dateOfDay(todayN), -1));
  [[lastComplete, false], [thisKey, true]].forEach(([key, partial]) => {
    if (key < firstMonthKey) return;
    const priorKeys = monthsBefore(key);
    if (priorKeys.length < M.minPriorMonths) return;
    const prior = priorKeys.map((k) => monthTotals.get(k) || 0);
    const mu = mean(prior); const sd = stdDev(prior); const actual = monthTotals.get(key) || 0;
    if (mu <= 0 || actual <= mu) return;
    const pct = ((actual - mu) / mu) * 100;
    const z = sd > 0 ? (actual - mu) / sd : Infinity;
    if (z >= M.minZ && pct >= M.minIncreasePct) {
      out.push({
        type: 'UNUSUAL_MONTH', fingerprint: `UNUSUAL_MONTH:${key}`, category: null, transactionId: null, periodKey: key,
        actual, baseline: mu, difference: actual - mu, percentChange: round1(pct),
        windowStart: new Date(`${key}-01T00:00:00Z`), windowEnd: partial ? dateOfDay(todayN) : addMonths(new Date(`${key}-01T00:00:00Z`), 1),
        explanation: partial
          ? `So far this month you have spent ${money(actual)}, already ${round1(pct)}% (${money(actual - mu)}) above your average monthly spending of ${money(mu)} over the previous ${prior.length} months.`
          : `Your total spending in ${monthName(key)} was ${money(actual)}, ${round1(pct)}% (${money(actual - mu)}) above your average monthly spending of ${money(mu)} over the ${prior.length} months before it.`,
        details: { rule: `Monthly total at least ${M.minZ} standard deviations and ${M.minIncreasePct}% above the average of earlier complete months.`, priorMonths: priorKeys.map((k, i) => ({ month: k, total: round2(prior[i]) })), standardDeviation: round2(sd), partialMonth: partial },
      });
    }
  });

  return { ...base, sufficient: true, detections: out };
};

// ----- persistence -----
const loadData = async (userId, now) => {
  const todayStart = startOfUtcDay(now);
  const since = new Date(Math.min(todayStart.getTime() - 235 * DAY_MS, addMonths(todayStart, -6).getTime()));
  const [expenses, first] = await Promise.all([
    prisma.transaction.findMany({ where: { userId, type: 'EXPENSE', date: { gte: since } }, select: { id: true, amount: true, category: true, date: true, description: true } }),
    prisma.transaction.aggregate({ where: { userId, type: 'EXPENSE' }, _min: { date: true } }),
  ]);
  return { expenses, firstExpenseDate: first._min.date };
};

// Runs detection and reconciles the stored rows. Idempotent: the (userId, fingerprint) unique key means the
// same finding is never stored twice, and a finding the user has reviewed/dismissed is never touched again.
const sync = async (userId, now = new Date()) => {
  const result = detect(await loadData(userId, now), loadThresholds(), now);
  const found = new Set(result.detections.map((d) => d.fingerprint));

  const existing = new Set((await prisma.unusualDetection.findMany({ where: { userId, fingerprint: { in: result.detections.map((x) => x.fingerprint) } }, select: { fingerprint: true } })).map((x) => x.fingerprint));
  for (const d of result.detections) {
    const data = {
      type: d.type, category: d.category, transactionId: d.transactionId, periodKey: d.periodKey,
      actualAmount: round2(d.actual), baselineAmount: round2(d.baseline), difference: round2(d.difference),
      percentChange: d.percentChange, windowStart: d.windowStart, windowEnd: d.windowEnd, explanation: d.explanation, details: d.details,
    };
    // eslint-disable-next-line no-await-in-loop
    await prisma.unusualDetection.upsert({
      where: { userId_fingerprint: { userId, fingerprint: d.fingerprint } },
      create: { userId, fingerprint: d.fingerprint, ...data },
      update: {}, // placeholder; NEW rows are refreshed below so reviewed/dismissed ones stay exactly as they were
    });
    // eslint-disable-next-line no-await-in-loop
    await prisma.unusualDetection.updateMany({ where: { userId, fingerprint: d.fingerprint, status: 'NEW' }, data });
    if (!existing.has(d.fingerprint)) {
      // eslint-disable-next-line no-await-in-loop
      await notify(userId, { category: 'UNUSUAL_SPENDING', type: 'INFO', title: 'Unusual spending noticed', message: `${d.explanation} (A comparison with your own history, not a problem by itself.)`, dedupeKey: `ud:${d.fingerprint}`, relatedType: 'detection', link: '/anomaly-detection' });
    }
  }

  // Unreviewed findings from the last 30 days that no longer hold (e.g. the transaction was deleted/edited)
  // are removed. Older ones are kept as history; reviewed/dismissed ones are never removed.
  await prisma.unusualDetection.deleteMany({
    where: { userId, status: 'NEW', detectedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) }, fingerprint: { notIn: [...found] } },
  });
  return { sufficient: result.sufficient, dataAvailability: result.dataAvailability, config: result.config };
};

const serialize = (r) => ({
  id: r.id, type: r.type, category: r.category, transactionId: r.transactionId,
  actualAmount: Number(r.actualAmount), baselineAmount: Number(r.baselineAmount), difference: Number(r.difference),
  percentChange: r.percentChange, explanation: r.explanation, details: r.details, status: r.status,
  detectedAt: r.detectedAt, statusUpdatedAt: r.statusUpdatedAt,
  windowStart: r.windowStart.toISOString().slice(0, 10), windowEnd: r.windowEnd.toISOString().slice(0, 10),
});

const MESSAGE = 'Not enough transaction history to identify unusual spending patterns.';

const getUnusualSpending = async (userId, status = 'active', now = new Date()) => {
  const meta = await cached(userId, 'anomaly-sync', () => sync(userId, now));
  const [groups, rows] = await Promise.all([
    prisma.unusualDetection.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
    prisma.unusualDetection.findMany({
      where: { userId, ...(status === 'all' ? {} : { status: status === 'active' ? 'NEW' : status.toUpperCase() }) },
      orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }],
    }),
  ]);
  const count = (s) => groups.find((g) => g.status === s)?._count._all || 0;
  return {
    sufficient: meta.sufficient,
    message: meta.sufficient ? null : MESSAGE,
    dataAvailability: meta.dataAvailability,
    requirement: `At least ${meta.config.minExpenseTransactions} expense transactions spanning at least ${meta.config.minHistoryDays} days.`,
    counts: { new: count('NEW'), reviewed: count('REVIEWED'), dismissed: count('DISMISSED') },
    disclaimer: 'These are statistical comparisons with your own past spending, not accusations. An unusual amount is often perfectly normal (a planned purchase, a one-off bill). Nothing is blocked or changed.',
    detections: meta.sufficient || status !== 'active' ? rows.map(serialize) : [],
  };
};

module.exports = { getUnusualSpending, detect, sync, serialize, quantile, DEFAULTS, loadThresholds, MESSAGE };
