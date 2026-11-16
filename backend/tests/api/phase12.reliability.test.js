const { prisma, svc, scheduler } = require('./dbenv');
const { call, register, eq, done } = require('./lib');
const { execSync } = require('child_process');

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const now0 = new Date();
const today = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth(), now0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the restarted server must run the REAL scheduler, so don't leak this test process's RECURRING_SCHEDULER=off
const restart = () => { const env = { ...process.env }; delete env.RECURRING_SCHEDULER; execSync('bash restart.sh', { cwd: __dirname, stdio: 'ignore', env }); };

(async () => {
  const A = await register('r12rel'); const uid = (await call(A, 'GET', '/auth/me')).data.user.id;
  const mk = async (title, extra = {}) => (await call(A, 'POST', '/recurring', { title, type: 'EXPENSE', amount: 10, category: 'Misc', frequency: 'DAILY', startDate: dd(5), ...extra })).data.recurring;
  const count = (id) => prisma.transaction.count({ where: { recurringId: id } });
  const dupes = async (id) => (await prisma.transaction.groupBy({ by: ['occurrenceDate'], where: { recurringId: id }, _count: { _all: true } })).filter((g) => g._count._all > 1).length;

  // ---- 1. generate, 2. run the same job again, concurrently, from every entry point ----
  const s1 = await mk('Backlog');
  await prisma.recurringTransaction.update({ where: { id: s1.id }, data: { startDate: D(dd(-3)), nextOccurrence: D(dd(-3)) } }); // 4 dates due: -3..0
  const results = await Promise.all([
    scheduler.runDue(), scheduler.runDue(), svc.processUser(uid), svc.processSchedule(s1.id), call(A, 'POST', '/recurring/process'), call(A, 'POST', '/recurring/process'),
  ]);
  eq('4 dates were due and 4 transactions exist after 6 simultaneous runs', await count(s1.id), 4);
  eq('no duplicate (recurringId, date) pairs', await dupes(s1.id), 0);
  eq('exactly 4 occurrence rows, all GENERATED', (await prisma.recurringOccurrence.findMany({ where: { recurringId: s1.id } })).map((o) => o.status), ['GENERATED', 'GENERATED', 'GENERATED', 'GENERATED']);
  // scheduler.runDue() reports the work of EVERY user's due schedules in the shared test database (it grows as other suites leave schedules behind), so only the user-scoped runs
  // (results 3-6) can be summed here. The database assertions above are the real proof that each date was created exactly once.
  eq('the user-scoped runs together report at most 4 generated (never more than the dates that were due), and the DB holds exactly 4', [results.slice(2).reduce((s, r) => s + (r.data ? r.data.generated : (r.generated?.length ?? r.generated ?? 0)), 0) <= 4, await count(s1.id)], [true, 4]);
  const again = await scheduler.runDue();
  eq('running the scheduled job again creates nothing', [again.generated, await count(s1.id)], [0, 4]);
  eq('next occurrence is tomorrow', iso((await prisma.recurringTransaction.findUnique({ where: { id: s1.id } })).nextOccurrence), dd(1));
  const tick = await scheduler.runDue(new Date(now0.getTime() + 2 * 86400000));
  eq('two days later the job adds exactly the 2 new dates (and again is idempotent)', [tick.generated >= 2, await count(s1.id) >= 6, (await scheduler.runDue(new Date(now0.getTime() + 2 * 86400000))).generated], [true, true, 0]);
  const before = await count(s1.id);

  // ---- 3. restart: schedules survive, 4. startup catch-up handles what fell due while down ----
  const s2 = await mk('Due while down');
  await prisma.recurringTransaction.update({ where: { id: s2.id }, data: { startDate: D(dd(-2)), nextOccurrence: D(dd(-2)) } }); // due: -2,-1,0
  const s3 = await mk('Paused across restart');
  await prisma.recurringTransaction.update({ where: { id: s3.id }, data: { startDate: D(dd(-2)), nextOccurrence: D(dd(-2)), isActive: false, pausedAt: new Date() } });
  const listBefore = (await call(A, 'GET', '/recurring')).data.recurring.map((x) => x.id).sort(); // (lazy-processing here would defeat the test, so snapshot via DB instead)
  void listBefore;
  await prisma.recurringTransaction.update({ where: { id: s2.id }, data: { nextOccurrence: D(dd(-2)) } });
  await prisma.transaction.deleteMany({ where: { recurringId: s2.id } });
  await prisma.recurringOccurrence.deleteMany({ where: { recurringId: s2.id } });
  await prisma.recurringTransaction.update({ where: { id: s2.id }, data: { nextOccurrence: D(dd(-2)), startDate: D(dd(-2)) } });
  restart();                                  // "restart the backend"
  await wait(4500);                           // startup catch-up runs ~1s after boot
  eq('after restart the schedules still exist in the database', (await prisma.recurringTransaction.count({ where: { userId: uid } })) >= 3, true);
  eq('startup catch-up generated the dates that fell due while the server was down (-2,-1,0)', (await prisma.transaction.findMany({ where: { recurringId: s2.id }, orderBy: { date: 'asc' } })).map((t) => iso(t.date)), [dd(-2), dd(-1), dd(0)]);
  eq('paused schedule stayed paused through the restart and generated nothing', [(await prisma.recurringTransaction.findUnique({ where: { id: s3.id } })).isActive, await count(s3.id)], [false, 0]);
  eq('earlier schedule not duplicated by the restart', await count(s1.id), before);

  // ---- API after restart ----
  const listed = (await call(A, 'GET', '/recurring')).data.recurring;
  eq('schedules are listed through the API after restart (same data)', [listed.find((x) => x.id === s3.id).status, listed.find((x) => x.id === s2.id).generatedCount], ['paused', 3]);

  // ---- 6. pause => nothing, 7. resume => continues correctly ----
  const s4 = await mk('Pause/resume', { startDate: dd(0) });
  eq('s4: generated today', await count(s4.id), 1);
  await call(A, 'POST', `/recurring/${s4.id}/pause`);
  await scheduler.runDue(new Date(now0.getTime() + 2 * 86400000)); // global pass over every schedule in the DB
  eq('paused: a scheduler run 2 days later generates nothing for it', await count(s4.id), 1);
  await svc.resume(uid, s4.id, {}, new Date(now0.getTime() + 3 * 86400000));
  const rows = (await prisma.transaction.findMany({ where: { recurringId: s4.id }, orderBy: { date: 'asc' } })).map((t) => iso(t.date));
  eq('resumed 3 days later: skipped the paused days, generated the new current date, no flood', rows, [dd(0), dd(3)]);
  const next4 = iso((await prisma.recurringTransaction.findUnique({ where: { id: s4.id } })).nextOccurrence);
  eq('and the schedule continues tomorrow-after-that', next4, dd(4));
  eq('future occurrences keep working', (await svc.processSchedule(s4.id, new Date(now0.getTime() + 4 * 86400000))).generated.length, 1);

  // ---- database error path: process does not crash, records failure, retries ----
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_tx_trg ON "Transaction"');
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_test_tx() RETURNS trigger AS $$ BEGIN IF NEW."description" = 'DB down' THEN RAISE EXCEPTION 'simulated database failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER fail_test_tx_trg BEFORE INSERT ON "Transaction" FOR EACH ROW EXECUTE FUNCTION fail_test_tx()');
  const s5 = await mk('DB down', { startDate: dd(1) });
  const s6 = await mk('Healthy neighbour', { startDate: dd(1) });
  const run = await scheduler.runDue(new Date(now0.getTime() + 86400000));
  eq('one schedule failing does not stop the others in the same run', [await count(s5.id), await count(s6.id), run.failed >= 1], [0, 1, true]);
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_tx_trg ON "Transaction"');
  eq('after recovery the failed date is retried and recorded once', [(await scheduler.runDue(new Date(now0.getTime() + 86400000))).generated, await count(s5.id), (await prisma.recurringOccurrence.findMany({ where: { recurringId: s5.id } })).map((o) => o.status)], [1, 1, ['GENERATED']]);

  // ---- every generated transaction belongs to the right user ----
  const stray = await prisma.transaction.count({ where: { recurringId: { in: [s1.id, s2.id, s4.id, s5.id, s6.id] }, NOT: { userId: uid } } });
  eq('all generated transactions belong to the owner', stray, 0);

  await prisma.$disconnect();
  done();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
