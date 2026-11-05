// Tiny per-user, in-process cache for derived results (insights, health score).
// An entry is served only while ALL of these hold:
//   - it was computed today (all windows are relative to "today", so they shift at midnight)
//   - it is younger than TTL_MS
//   - the user hasn't changed any transaction/budget/goal/contribution since (invalidate())
// So repeated page loads reuse one calculation, while any relevant change recalculates.
// Note: in-process, so with several server instances each keeps its own copy (TTL bounds staleness).
const TTL_MS = 5 * 60 * 1000;
const MAX_USERS = 1000;
const store = new Map();    // userId -> Map(kind -> { day, expires, value })
const versions = new Map(); // userId -> number, bumped by every invalidate()

const today = () => new Date().toISOString().slice(0, 10);
const version = (userId) => versions.get(userId) || 0;

const get = (userId, kind) => {
  const entry = store.get(userId)?.get(kind);
  if (!entry || entry.day !== today() || entry.expires < Date.now()) return undefined;
  return entry.value;
};

// `startedAtVersion` is version(userId) read BEFORE computing. If a write happened while we were
// computing, the version moved on and the (possibly stale) result is simply not cached.
const set = (userId, kind, value, startedAtVersion) => {
  if (startedAtVersion !== version(userId)) return;
  if (!store.has(userId)) {
    if (store.size >= MAX_USERS) store.delete(store.keys().next().value); // evict the oldest user
    store.set(userId, new Map());
  }
  store.get(userId).set(kind, { day: today(), expires: Date.now() + TTL_MS, value });
};

const invalidate = (userId) => {
  versions.set(userId, version(userId) + 1);
  store.delete(userId);
};

// Express middleware for the data routes: once a non-GET request has finished (success or not -
// clearing is always safe) that user's cache is cleared. Anything computed from before the write
// is dropped here, and a calculation still running at that moment is rejected by set() above.
const invalidateOnWrite = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next();
  res.on('finish', () => { if (req.user) invalidate(req.user.id); });
  return next();
};

// Run `compute` once per user per change: returns the cached value or computes + caches it.
const cached = async (userId, kind, compute) => {
  const hit = get(userId, kind);
  if (hit !== undefined) return hit;
  const v = version(userId);
  const value = await compute();
  set(userId, kind, value, v);
  return value;
};

module.exports = { get, set, version, invalidate, invalidateOnWrite, cached };
