// Phase 20 production-readiness behaviour: health/readiness, scheduler heartbeat, request ids, structured logs without sensitive data, graceful shutdown.
const { spawn } = require('child_process');
const { eq, done } = require('./lib');
const ROOT = require('path').join(__dirname, '..', '..');
const fs = require('fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const envText = fs.existsSync(`${ROOT}/.env`) ? fs.readFileSync(`${ROOT}/.env`, 'utf8') : '';
const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || (envText.match(/^DATABASE_URL="?([^"\r\n]+)"?/m) || [])[1].replace('/fintrack?', '/fintrack_test?');

const startServer = async (port, env, { capture = false } = {}) => {
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: baseUrl, PORT: String(port), CLIENT_URL: 'http://localhost:5600', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://localhost:${port}/api/health`)).status === 200) break; } catch { /* retry */ } await wait(150); }
  return { child, out, get: (p, o) => fetch(`http://localhost:${port}${p}`, o), logs: () => out.join('') };
};

(async () => {
  // ---------- liveness vs readiness ----------
  const s = await startServer(5070, { RECURRING_SCHEDULER: 'on', RECURRING_TICK_MS: '1500', GIT_SHA: 'abc123def456' });
  const live = await s.get('/api/health'); const lj = await live.json();
  eq('liveness: 200 with a timestamp', [live.status, lj.success, typeof lj.timestamp], [200, true, 'string']);
  await wait(4000);
  const rd = await s.get('/api/health/ready'); const rj = await rd.json();
  eq('readiness: 200 "ready", database ok, ALL migrations applied, version = GIT_SHA', [rd.status, rj.status, rj.checks.database.ok, rj.checks.migrations.ok, rj.checks.migrations.pending, rj.version], [200, 'ready', true, true, 0, 'abc123def456']);
  eq('readiness reports the background scheduler heartbeat (ran at least once, no error)', [rj.checks.scheduler.ok, rj.checks.scheduler.enabled, rj.checks.scheduler.runs >= 1, rj.checks.scheduler.lastError, typeof rj.checks.scheduler.lastFinishedAt], [true, true, true, null, 'string']);
  eq('readiness exposes no secrets or connection strings', [JSON.stringify(rj).includes('postgres'), JSON.stringify(rj).includes('JWT'), JSON.stringify(rj).includes(baseUrl.split('@')[0].split(':').pop())], [false, false, false]);

  // ---------- request ids + structured logs ----------
  const r1 = await s.get('/api/transactions?search=very-private-search-term', { headers: { Authorization: 'Bearer not-a-real-token-xyz' } });
  eq('every response carries X-Request-Id; a sane incoming id is reused, a hostile one is replaced', [!!r1.headers.get('x-request-id'), (await s.get('/api/health', { headers: { 'X-Request-Id': 'trace-12345678' } })).headers.get('x-request-id'), (await s.get('/api/health', { headers: { 'X-Request-Id': 'bad id <script>' } })).headers.get('x-request-id') !== 'bad id <script>'], [true, 'trace-12345678', true]);
  const email = `ops.${Date.now()}@test.dev`; const pw = 'PrivatePassw0rd-ops';
  const reg = await s.get('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ops Test', email, password: pw }) }); const token = (await reg.json()).data.token;
  await s.get('/api/transactions?search=another-private-term', { headers: { Authorization: `Bearer ${token}` } });
  await s.get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'wrong-' + pw }) });
  await wait(500);
  const logs = s.logs(); const lines = logs.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const http = lines.filter((l) => l.msg === 'http');
  eq('logs are JSON lines: one per request with reqId, method, path, status, ms; 4xx at warn', [http.length >= 4, http.every((l) => l.reqId && l.method && l.path && typeof l.status === 'number' && typeof l.ms === 'number'), http.some((l) => l.status === 401 && l.level === 'warn')], [true, true, true]);
  eq('logs never contain query strings, tokens, passwords or e-mail addresses', [logs.includes('very-private-search-term'), logs.includes('another-private-term'), logs.includes(token), logs.includes(pw), logs.includes(email)], [false, false, false, false, false]);
  eq('health checks are not logged (no noise), user ids are logged for authenticated requests', [http.some((l) => l.path === '/api/health'), http.some((l) => l.userId)], [false, true]);
  s.child.kill();

  // ---------- health checks are exempt from the rate limiter ----------
  const s2 = await startServer(5071, { RATE_LIMIT_MAX: '30', RECURRING_SCHEDULER: 'off' });
  let healthOk = 0; for (let i = 0; i < 80; i += 1) { if ((await s2.get('/api/health')).status === 200) healthOk += 1; if (i % 4 === 0) await s2.get('/api/health/ready'); }
  const limited = []; for (let i = 0; i < 40; i += 1) limited.push((await s2.get('/api/transactions')).status);
  eq('80 liveness + 20 readiness checks are never rate limited, while ordinary API calls ARE (429 after the limit)', [healthOk, limited.includes(429), (await s2.get('/api/health/ready')).status], [80, true, 200]);
  const rdOff = await (await s2.get('/api/health/ready')).json();
  eq('scheduler explicitly disabled: readiness says so and stays ready', [rdOff.checks.scheduler.enabled, rdOff.checks.scheduler.ok], [false, true]);
  s2.child.kill();

  // ---------- not ready: database unreachable / migrations missing ----------
  const bad = baseUrl.replace('/fintrack_test?', '/fintrack_does_not_exist?');
  const s3 = await startServer(5072, { DATABASE_URL: bad, RECURRING_SCHEDULER: 'off' });
  const nr = await s3.get('/api/health/ready'); const nj = await nr.json();
  eq('database unreachable: liveness still 200 (do not restart-loop on a DB outage) but readiness 503 "not_ready" with no connection details', [(await s3.get('/api/health')).status, nr.status, nj.status, nj.checks.database.ok, JSON.stringify(nj).includes('localhost')], [200, 503, 'not_ready', false, false]);
  s3.child.kill();

  // ---------- graceful shutdown (POSIX only: Windows cannot deliver SIGTERM to a handler) ----------
  if (process.platform !== 'win32') {
    const s4 = await startServer(5073, { RECURRING_SCHEDULER: 'off' });
    const exit = new Promise((res) => s4.child.on('exit', (code) => res(code)));
    s4.child.kill('SIGTERM');
    const code = await Promise.race([exit, wait(8000).then(() => 'timeout')]);
    eq('SIGTERM: the server stops cleanly (exit 0) and logs the shutdown', [code, /shutdown complete/.test(s4.logs())], [0, true]);
  } else {
    console.log('SKIP  graceful shutdown (SIGTERM is not delivered to Node handlers on Windows; covered by the Linux CI run)');
  }

  done();
})().catch((e) => { console.error(e); process.exit(1); });
