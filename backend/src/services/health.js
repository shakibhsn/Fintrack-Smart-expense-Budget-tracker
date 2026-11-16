const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const scheduler = require('./recurringScheduler');

// Readiness = "can this instance serve real traffic right now?":
//   database    reachable within 3 s
//   migrations  every migration committed in prisma/migrations has been applied (a release that forgot its migration is NOT ready)
//   scheduler   the background jobs (recurring transactions, subscriptions, reminders) ran recently and did not fail
// Liveness (/api/health) only says the process answers. A platform should restart on failed liveness and stop sending traffic on failed readiness.
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const startedAt = Date.now();

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function readiness() {
  const checks = {};
  const t0 = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000);
    checks.database = { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    checks.database = { ok: false, error: e.message === 'timeout' ? 'timeout' : 'unreachable' };
  }
  if (checks.database.ok) {
    try {
      const onDisk = fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      const rows = await withTimeout(prisma.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`, 3000);
      const applied = new Set(rows.map((r) => r.migration_name));
      const pending = onDisk.filter((n) => !applied.has(n));
      checks.migrations = { ok: pending.length === 0, applied: applied.size, pending: pending.length, ...(pending.length ? { pendingNames: pending.slice(0, 5) } : {}) };
    } catch (e) {
      checks.migrations = { ok: false, error: 'cannot read migration state' };
    }
  }
  checks.scheduler = scheduler.status();
  const ok = Object.values(checks).every((c) => c.ok);
  return {
    httpStatus: ok ? 200 : 503,
    body: { status: ok ? 'ready' : 'not_ready', version: process.env.GIT_SHA || 'unknown', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), checks },
  };
}

module.exports = { readiness };
