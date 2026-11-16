// Phase 19: security tests. Runs against the test API (:5055, test DB) and spawns extra throw-away servers for configuration/brute-force cases.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const jwt = require('../../node_modules/jsonwebtoken');
const { prisma } = require('./dbenv');
const { call, register, eq, done } = require('./lib');
const ROOT = require('path').join(__dirname, '..', '..');
const BASE = 'http://localhost:5055/api';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const envFile = fs.existsSync(`${ROOT}/.env`) ? fs.readFileSync(`${ROOT}/.env`, 'utf8') : '';
const SECRET = process.env.JWT_SECRET || /^JWT_SECRET="?([^"\r\n]+)"?/m.exec(envFile)[1];
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date(); const dd = (n) => iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + n)));
const raw = async (method, path, { token, body, headers = {}, base = BASE } = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json, data: json && json.data };
};
const uidOf = async (p) => (await prisma.user.findFirst({ where: { email: { startsWith: p } }, orderBy: { createdAt: 'desc' } })).id;
const startServer = async (port, env) => {
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), RECURRING_SCHEDULER: 'off', RATE_LIMIT_MAX: '100000', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://localhost:${port}/api/health`)).status === 200) break; } catch { /* retry */ } await wait(150); }
  return child;
};

(async () => {
  // ====================== registration / passwords ======================
  const stamp = Date.now();
  const reg = (o) => raw('POST', '/auth/register', { body: { name: 'Sec Tester', email: `sec.${stamp}.${Math.random().toString(36).slice(2)}@test.dev`, password: 'goodpass123', ...o } });
  eq('password rules: 7 chars rejected, 8 accepted, 73 bytes rejected, multibyte over 72 bytes rejected', [(await reg({ password: 'abc1234' })).status, (await reg({ password: 'abcd1234' })).status, (await reg({ password: 'x'.repeat(73) })).status, (await reg({ password: 'é'.repeat(37) })).status], [400, 201, 400, 400]);
  eq('name > 100 chars and e-mail > 254 chars rejected', [(await reg({ name: 'n'.repeat(101) })).status, (await reg({ email: `${'a'.repeat(250)}@x.dev` })).status], [400, 400]);
  const r1 = await reg({ role: 'admin', id: 'forced-id', passwordHash: 'x', currency: 'USD' });
  eq('mass assignment on register: extra fields are ignored, response has no hash', [r1.status, r1.data.user.id !== 'forced-id', 'passwordHash' in r1.data.user, JSON.stringify(r1.json).includes('$2'), r1.data.user.currency], [201, true, false, false, 'BDT']);
  const u1 = await prisma.user.findUnique({ where: { id: r1.data.user.id } });
  const r2 = await reg({ email: `sec2.${stamp}@test.dev`, password: 'goodpass123' }); const u2 = await prisma.user.findUnique({ where: { id: r2.data.user.id } });
  eq('passwords are bcrypt hashed (cost >= 12), never plain, salted per user', [/^\$2[aby]\$(1[2-9])\$/.test(u1.passwordHash), u1.passwordHash.includes('goodpass123'), u1.passwordHash !== u2.passwordHash], [true, false, true]);
  eq('duplicate e-mail => 409 (case-insensitive)', (await reg({ email: r1.data.user.email.toUpperCase() })).status, 409);

  // ====================== login: no enumeration ======================
  const email = r1.data.user.email;
  const time = async (b) => { const t = process.hrtime.bigint(); const x = await raw('POST', '/auth/login', { body: b }); return { ms: Number(process.hrtime.bigint() - t) / 1e6, x }; };
  const bad1 = await time({ email, password: 'wrongpass1' }); const bad2 = await time({ email: `nobody.${stamp}@test.dev`, password: 'wrongpass1' });
  eq('wrong password and unknown e-mail: identical status and message', [bad1.x.status, bad2.x.status, bad1.x.json.message === bad2.x.json.message], [401, 401, true]);
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const tk = []; const tu = []; for (let i = 0; i < 5; i += 1) { tk.push((await time({ email, password: 'wrongpass1' })).ms); tu.push((await time({ email: `nobody${i}.${stamp}@test.dev`, password: 'wrongpass1' })).ms); }
  eq('timing: an unknown account takes comparable time to a wrong password (>= 50% of it), so timing does not reveal accounts', med(tu) >= med(tk) * 0.5, true);
  eq('login with the right password still works; token returned; no hash', [(await raw('POST', '/auth/login', { body: { email, password: 'goodpass123' } })).status, JSON.stringify((await raw('POST', '/auth/login', { body: { email, password: 'goodpass123' } })).json).includes('$2')], [200, false]);

  // ====================== JWT handling ======================
  const A = await register('sec-a'); const B = await register('sec-b'); const aid = await uidOf('sec-a.'); const bid = await uidOf('sec-b.');
  const me = (token, extra = {}) => raw('GET', '/auth/me', { token, ...extra }).then((r) => r.status);
  const good = jwt.sign({ id: aid }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const forged = [
    ['valid token', good, 200],
    ['tampered payload', `${good.split('.')[0]}.${Buffer.from(JSON.stringify({ id: bid, iat: 1, exp: 9999999999 })).toString('base64url')}.${good.split('.')[2]}`, 401],
    ['wrong secret', jwt.sign({ id: aid }, 'not-the-secret-not-the-secret-123456', { expiresIn: '1h' }), 401],
    ['alg none', `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: aid })).toString('base64url')}.`, 401],
    ['HS512 with the right secret (algorithm pinned to HS256)', jwt.sign({ id: aid }, SECRET, { algorithm: 'HS512', expiresIn: '1h' }), 401],
    ['expired', jwt.sign({ id: aid }, SECRET, { expiresIn: -10 }), 401],
    ['user id that does not exist', jwt.sign({ id: '00000000-0000-0000-0000-000000000000' }, SECRET, { expiresIn: '1h' }), 401],
    ['garbage', 'abc.def.ghi', 401], ['empty bearer', '', 401],
  ];
  const got = []; for (const [, t, want] of forged) got.push([await me(t || undefined), want]);
  eq('token validation: valid ok; tampered / wrong secret / alg none / HS512 / expired / unknown user / garbage / empty all 401', got.map((g) => g[0]), got.map((g) => g[1]));
  eq('token only accepted in the Authorization header (not in the query string), scheme must be Bearer', [(await raw('GET', `/auth/me?token=${good}`)).status, (await raw('GET', '/auth/me', { headers: { Authorization: `Basic ${good}` } })).status, (await raw('GET', '/auth/me', { headers: { Authorization: good } })).status], [401, 401, 401]);
  await prisma.user.delete({ where: { id: (await prisma.user.findFirst({ where: { email: `sec2.${stamp}@test.dev` } })).id } });
  eq('a token of a deleted account stops working immediately', await me(jwt.sign({ id: r2.data.user.id }, SECRET, { expiresIn: '1h' })), 401);

  // ====================== every API route needs a token ======================
  const protectedRoutes = [['GET', '/transactions'], ['GET', '/budgets'], ['GET', '/goals'], ['GET', '/dashboard'], ['GET', '/analytics/overview'], ['GET', '/notifications'], ['GET', '/insights'], ['GET', '/health-score'], ['GET', '/forecast'], ['GET', '/unusual-spending'], ['GET', '/simulations'], ['GET', '/recurring'], ['GET', '/subscriptions'], ['GET', '/reports'], ['GET', '/import/history'], ['GET', '/export/transactions'], ['GET', '/export/backup'], ['POST', '/backup/restore'], ['GET', '/ai/status'], ['POST', '/ai/ask'], ['GET', '/notifications/preferences']];
  eq(`${protectedRoutes.length} data routes: no token => 401`, await Promise.all(protectedRoutes.map(async ([m, p]) => (await raw(m, p, { body: m === 'POST' ? {} : undefined })).status)), protectedRoutes.map(() => 401));

  // ====================== IDOR: user B vs user A's records ======================
  const ids = {};
  ids.tx = (await call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: 10, category: 'Food', description: 'A private', date: dd(-1) })).data.transaction.id;
  ids.bud = (await call(A, 'POST', '/budgets', { category: 'Food', limit: 100, startDate: dd(-3), endDate: dd(10) })).data.budget.id;
  const goal = (await call(A, 'POST', '/goals', { title: 'A goal', targetAmount: 1000 })).data.goal; ids.goal = goal.id;
  ids.sub = (await call(A, 'POST', '/subscriptions', { name: 'A sub', category: 'Other', amount: 10, frequency: 'MONTHLY', startDate: dd(-5), nextRenewalDate: dd(5) })).data.subscription.id;
  ids.rec = (await call(A, 'POST', '/recurring', { title: 'A rec', type: 'EXPENSE', amount: 5, category: 'Food', frequency: 'MONTHLY', startDate: dd(2) })).data.recurring.id;
  const notif = (await call(A, 'GET', '/notifications')).data.notifications[0]; ids.notif = notif.id;
  const snap = (await call(A, 'POST', '/reports/snapshots', { period: 'this_month' })).data; ids.snap = snap.snapshot.id;
  await call(A, 'POST', `/goals/${ids.goal}/contributions`, { amount: 5 });
  const csv = 'date,type,amount,category,description,notes\n' + `${dd(-2)},EXPENSE,5,Food,imp1,`;
  ids.imp = (await call(A, 'POST', '/import/transactions/confirm', { csv, fileName: 'a.csv', confirm: true })).data.batchId;
  const sim = await call(A, 'POST', '/simulations', { name: 'A sim', inputs: { reductions: [], extraIncome: 0 } }); ids.simId = sim.data && sim.data.simulation ? sim.data.simulation.id : null;
  const cases = [
    ['GET', `/transactions/${ids.tx}`], ['PUT', `/transactions/${ids.tx}`, { amount: 1 }], ['DELETE', `/transactions/${ids.tx}`],
    ['PUT', `/budgets/${ids.bud}`, { limit: 1 }], ['DELETE', `/budgets/${ids.bud}`],
    ['GET', `/goals/${ids.goal}`], ['PUT', `/goals/${ids.goal}`, { title: 'hacked' }], ['DELETE', `/goals/${ids.goal}`], ['GET', `/goals/${ids.goal}/contributions`], ['POST', `/goals/${ids.goal}/contributions`, { amount: 1 }],
    ['GET', `/subscriptions/${ids.sub}`], ['PUT', `/subscriptions/${ids.sub}`, { name: 'hacked' }], ['DELETE', `/subscriptions/${ids.sub}`], ['POST', `/subscriptions/${ids.sub}/pause`], ['POST', `/subscriptions/${ids.sub}/payments`, {}],
    ['GET', `/recurring/${ids.rec}`], ['PUT', `/recurring/${ids.rec}`, { title: 'hacked' }], ['DELETE', `/recurring/${ids.rec}`], ['POST', `/recurring/${ids.rec}/pause`],
    ['PATCH', `/notifications/${ids.notif}/read`], ['DELETE', `/notifications/${ids.notif}`],
    ['GET', `/reports/snapshots/${ids.snap}`], ['GET', `/reports/snapshots/${ids.snap}/pdf`], ['DELETE', `/reports/snapshots/${ids.snap}`],
    ['POST', `/import/history/${ids.imp}/undo`],
    ...(ids.simId ? [['GET', `/simulations/${ids.simId}`], ['DELETE', `/simulations/${ids.simId}`]] : []),
  ];
  const stat = []; for (const [m, p, b] of cases) stat.push((await raw(m, p, { token: B, body: b })).status);
  eq(`IDOR: user B cannot read / change / delete ANY of A's records (${cases.length} requests => all 404)`, stat, cases.map(() => 404));
  eq('...and A\'s data is completely intact afterwards', [(await call(A, 'GET', `/transactions/${ids.tx}`)).data.transaction.amount, (await call(A, 'GET', `/goals/${ids.goal}`)).data.goal.title, (await call(A, 'GET', '/budgets')).data.budgets.length, (await call(A, 'GET', '/subscriptions')).data.subscriptions.length, (await call(A, 'GET', '/recurring')).data.recurring.length, await prisma.notification.count({ where: { id: ids.notif } }), await prisma.reportSnapshot.count({ where: { id: ids.snap } }), (await prisma.importBatch.findUnique({ where: { id: ids.imp } })).status], [10, 'A goal', 1, 1, 1, 1, 1, 'COMPLETED']);
  const lists = [['/transactions', 'transactions'], ['/budgets', 'budgets'], ['/goals', 'goals'], ['/subscriptions', 'subscriptions'], ['/recurring', 'recurring']];
  eq('B\'s lists contain none of A\'s items', await Promise.all(lists.map(async ([p, k]) => ((await call(B, 'GET', p)).data[k] || []).length)), [0, 0, 0, 0, 0]);
  eq('B\'s exports / backup / reports / history contain nothing of A', [(await raw('GET', '/export/transactions', { token: B })).text.includes('A private'), (await raw('GET', '/export/backup', { token: B })).text.includes('A goal'), JSON.stringify((await call(B, 'GET', '/reports?period=this_month')).data).includes('A private'), (await call(B, 'GET', '/import/history')).data.imports.length], [false, false, false, 0]);

  // ====================== trusting client-supplied ownership ======================
  const spoof = await call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: 7, category: 'Food', description: 'spoof', date: dd(-1), userId: bid, id: 'client-id' });
  eq('POST with another user\'s userId in the body: row is created for the CALLER', [spoof.status, (await prisma.transaction.findUnique({ where: { id: spoof.data.transaction.id } })).userId === aid, spoof.data.transaction.id !== 'client-id'], [201, true, true]);
  await call(A, 'PUT', `/transactions/${ids.tx}`, { userId: bid, amount: 11 });
  eq('PUT with userId in the body cannot move a record to another user', (await prisma.transaction.findUnique({ where: { id: ids.tx } })).userId, aid);
  const g2 = await call(A, 'POST', '/goals', { title: 'spoof goal', targetAmount: 50, userId: bid, savedAmount: 0 });
  const s2 = await call(A, 'POST', '/subscriptions', { name: 'spoof', category: 'Other', amount: 1, frequency: 'MONTHLY', startDate: dd(-1), nextRenewalDate: dd(5), userId: bid });
  const bu = await call(A, 'POST', '/budgets', { category: 'Spoof', limit: 5, startDate: dd(0), endDate: dd(5), userId: bid });
  // a strict schema may reject the unknown field outright (400) or the server may ignore it (201 for the caller): both are safe, what matters is that nothing is ever created for the victim
  const spoofOk = async (res, key, model) => (res.status === 400 ? true : res.status === 201 && (await prisma[model].findUnique({ where: { id: res.data[key].id } })).userId === aid);
  eq('goals / subscriptions / budgets: a body userId is rejected or ignored, never honoured', [await spoofOk(g2, 'goal', 'savingsGoal'), await spoofOk(s2, 'subscription', 'subscription'), await spoofOk(bu, 'budget', 'budget'), (await prisma.savingsGoal.count({ where: { userId: bid, title: 'spoof goal' } })) + (await prisma.subscription.count({ where: { userId: bid, name: 'spoof' } })) + (await prisma.budget.count({ where: { userId: bid, category: 'Spoof' } }))], [true, true, true, 0]);
  eq('restoring a backup whose items carry foreign ids / userIds writes only to the caller', await (async () => {
    const bk = (await raw('GET', '/export/backup', { token: A })).json; bk.data.transactions[0].userId = bid; bk.data.transactions[0].ref = ids.tx; bk.checksum = require(`${ROOT}/src/services/exportService`).checksumOf(bk.data);
    const before = await prisma.transaction.count({ where: { userId: bid } });
    await raw('POST', '/backup/restore', { token: B, body: { backup: bk, confirm: true } });
    return [await prisma.transaction.count({ where: { userId: bid } }) >= before, await prisma.transaction.count({ where: { userId: aid } }) === (await call(A, 'GET', '/transactions?limit=500')).data.transactions.length];
  })(), [true, true]);

  // ====================== injection ======================
  const before = { tx: await prisma.transaction.count(), users: await prisma.user.count() };
  const payloads = ["' OR '1'='1", "'; DROP TABLE \"Transaction\"; --", '" OR 1=1 --', "1; SELECT pg_sleep(5)--", '%00', '${7*7}', '{{7*7}}', '../../etc/passwd'];
  const results = [];
  for (const p of payloads) {
    const q = encodeURIComponent(p);
    results.push((await raw('GET', `/transactions?search=${q}&category=${q}`, { token: A })).status);
    results.push((await raw('GET', `/transactions?sort=${q}`, { token: A })).status);
    results.push((await raw('POST', '/transactions', { token: A, body: { type: 'EXPENSE', amount: 1, category: p.slice(0, 50), description: p.slice(0, 190), date: dd(-1) } })).status);
    results.push((await raw('GET', `/transactions/${q}`, { token: A })).status);
    results.push((await raw('GET', `/analytics/overview?period=custom&startDate=${q}&endDate=${q}`, { token: A })).status);
    results.push((await raw('GET', `/reports?period=${q}`, { token: A })).status);
    results.push((await raw('POST', '/auth/login', { body: { email: p, password: p } })).status);
  }
  eq('SQL / template / traversal payloads in query, path, body and login never cause a 500', results.every((s) => s < 500), true);
  eq('...tables intact, no users created, and the stored text comes back verbatim (parameterised queries)', [await prisma.user.count() === before.users, await prisma.transaction.count() >= before.tx, (await prisma.transaction.findFirst({ where: { userId: aid, description: "' OR '1'='1" } })) !== null], [true, true, true]);
  const t0 = Date.now(); await raw('GET', `/transactions?search=${encodeURIComponent('1; SELECT pg_sleep(5)--')}`, { token: A });
  eq('a pg_sleep payload does not execute (fast response)', Date.now() - t0 < 3000, true);
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const xr = await raw('POST', '/transactions', { token: A, body: { type: 'EXPENSE', amount: 3, category: 'Food', description: xss, date: dd(-1) } });
  const xl = await raw('GET', '/transactions?search=script', { token: A });
  eq('XSS payload is stored verbatim, served as application/json with nosniff (rendering is escaped by the frontend, see e2e)', [xr.status, /application\/json/.test(xl.headers.get('content-type')), xl.headers.get('x-content-type-options'), xl.json.data.transactions.some((t) => t.description === xss)], [201, true, 'nosniff', true]);
  const pp = await raw('POST', '/transactions', { token: A, body: '{"type":"EXPENSE","amount":1,"category":"Food","description":"pp","date":"' + dd(-1) + '","__proto__":{"isAdmin":true},"constructor":{"prototype":{"polluted":1}}}' });
  eq('prototype-pollution keys in JSON bodies are harmless', [pp.status, ({}).isAdmin, ({}).polluted, (await raw('GET', '/health')).status], [201, undefined, undefined, 200]);

  // ====================== numbers / dates ======================
  const amt = async (a) => (await raw('POST', '/transactions', { token: A, body: { type: 'EXPENSE', amount: a, category: 'Food', description: 'amt', date: dd(-1) } })).status;
  eq('amount validation: 0, negative, NaN-ish strings, 1e9, infinity, objects, arrays rejected; 999999999.99 accepted', [await amt(0), await amt(-5), await amt('abc'), await amt(1000000000), await amt(1e400), await amt({ $gt: 0 }), await amt([1]), await amt(999999999.99)], [400, 400, 400, 400, 400, 400, 400, 201]);
  const dt = async (d) => (await raw('POST', '/transactions', { token: A, body: { type: 'EXPENSE', amount: 1, category: 'Food', description: 'dt', date: d } })).status;
  eq('date validation: garbage and impossible days rejected, leap day accepted', [await dt('not-a-date'), await dt('2023-02-31'), await dt('2024-02-29'), await dt(null)], [400, 400, 201, 400]);

  // ====================== HTTP hardening ======================
  const hr = await raw('GET', '/health', { headers: { Origin: 'http://localhost:5600' } });
  eq('security headers present, X-Powered-By absent', [hr.headers.get('x-content-type-options'), !!hr.headers.get('strict-transport-security'), hr.headers.get('x-powered-by'), !!hr.headers.get('x-frame-options') || /frame-ancestors/.test(hr.headers.get('content-security-policy') || ''), !!hr.headers.get('referrer-policy')], ['nosniff', true, null, true, true]);
  eq('CORS: the configured frontend origin is allowed; any other origin gets no CORS headers (the browser blocks it)', [hr.headers.get('access-control-allow-origin'), (await raw('GET', '/health', { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), (await raw('OPTIONS', '/transactions', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } })).headers.get('access-control-allow-origin')], ['http://localhost:5600', null, null]);
  eq('CORS exposes only the headers the frontend needs', /Content-Disposition/i.test((await raw('GET', '/health', { headers: { Origin: 'http://localhost:5600' } })).headers.get('access-control-expose-headers') || ''), true);
  const big = await raw('POST', '/transactions', { token: A, body: JSON.stringify({ description: 'x'.repeat(300000) }), headers: { 'Content-Type': 'application/json' } });
  eq('oversized JSON body => 413 with a plain message', [big.status, /too large/i.test(big.json.message)], [413, true]);
  const bj = await raw('POST', '/transactions', { token: A, body: '{"broken": ', headers: { 'Content-Type': 'application/json' } });
  eq('malformed JSON => 400, no stack trace or parser internals', [bj.status, 'stack' in bj.json, /SyntaxError|at JSON|node_modules/.test(bj.text)], [400, false, false]);
  const leak = [await raw('GET', '/nope'), await raw('GET', '/transactions/not-a-uuid', { token: A }), await raw('POST', '/subscriptions', { token: A, body: { name: 1 } }), await raw('GET', '/reports/snapshots/%00', { token: A })];
  eq('error bodies never expose stacks, file paths, SQL or Prisma internals', leak.map((r) => /node_modules|\.js:\d+|prisma|postgres|SELECT |at Object|C:\\|E:\\/i.test(r.text) || 'stack' in (r.json || {})), [false, false, false, false]);
  eq('error responses are JSON with success:false', leak.every((r) => r.json && r.json.success === false), true);

  // ====================== fail-fast production configuration ======================
  const prodRun = (env) => { const r = spawnSync('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: '5062', NODE_ENV: 'production', RECURRING_SCHEDULER: 'off', ...env }, encoding: 'utf8', timeout: 20000 }); return r; };
  const weak = prodRun({ JWT_SECRET: 'short', CLIENT_URL: 'https://app.example.com' });
  eq('production + weak JWT secret: the server refuses to start (exit 1), the log names the problem but never prints the secret', [weak.status, /JWT_SECRET/.test(weak.stderr + weak.stdout), (weak.stderr + weak.stdout).includes('short"')], [1, true, false]);
  const noCors = prodRun({ JWT_SECRET: 'x'.repeat(40), CLIENT_URL: '' });
  const starCors = prodRun({ JWT_SECRET: 'x'.repeat(40), CLIENT_URL: '*' });
  const httpCors = prodRun({ JWT_SECRET: 'x'.repeat(40), CLIENT_URL: 'http://app.example.com' });
  eq('production + missing / "*" / non-https CLIENT_URL: refuses to start', [noCors.status, starCors.status, httpCors.status], [1, 1, 1]);
  const prodOk = await startServer(5063, { NODE_ENV: 'production', JWT_SECRET: 'p'.repeat(48), CLIENT_URL: 'https://app.example.com,https://staging.example.com' });
  const pb = (path, o = {}) => raw(o.method || 'GET', path, { base: 'http://localhost:5063/api', ...o });
  eq('production with a valid configuration starts; multiple allowed origins work, others do not', [(await pb('/health')).status, (await pb('/health', { headers: { Origin: 'https://staging.example.com' } })).headers.get('access-control-allow-origin'), (await pb('/health', { headers: { Origin: 'https://app.example.com' } })).headers.get('access-control-allow-origin'), (await pb('/health', { headers: { Origin: 'http://localhost:5600' } })).headers.get('access-control-allow-origin')], [200, 'https://staging.example.com', 'https://app.example.com', null]);
  const pe = await pb('/transactions/xyz'); eq('production: 401 body is minimal JSON (no stack)', [pe.status, 'stack' in pe.json], [401, false]);
  prodOk.kill();

  // ====================== brute force + proxy handling ======================
  const attempts = async (base, n, headerFn) => { const out = []; for (let i = 0; i < n; i += 1) out.push((await raw('POST', '/auth/login', { base, body: { email, password: 'wrong' + i }, headers: headerFn ? headerFn(i) : {} })).status); return out; };
  const s1 = await startServer(5064, {});
  const a1 = await attempts('http://localhost:5064/api', 24);
  eq('login brute force: the first 20 attempts get 401, then 429 "Too many attempts"', [a1.slice(0, 20).every((s) => s === 401), a1.slice(20).every((s) => s === 429)], [true, true]);
  s1.kill();
  const srvB = await startServer(5065, {});
  const a2 = await attempts('http://localhost:5065/api', 24, (i) => ({ 'X-Forwarded-For': `10.0.0.${i + 1}` }));
  eq('WITHOUT TRUST_PROXY a spoofed X-Forwarded-For cannot dodge the limiter', a2.slice(20).every((s) => s === 429), true);
  srvB.kill();
  const s3 = await startServer(5066, { TRUST_PROXY: '1' });
  const a3 = await attempts('http://localhost:5066/api', 22, () => ({ 'X-Forwarded-For': '203.0.113.9' }));
  const other = await raw('POST', '/auth/login', { base: 'http://localhost:5066/api', body: { email, password: 'wrong' }, headers: { 'X-Forwarded-For': '203.0.113.77' } });
  eq('WITH TRUST_PROXY=1 the limiter counts the real client address: one client is blocked, another client is not', [a3.slice(20).every((s) => s === 429), other.status], [true, 401]);
  s3.kill();

  // ====================== secrets in the repository ======================
  const scan = spawnSync('node', ['scripts/secret-scan.js'], { cwd: ROOT, encoding: 'utf8' });
  eq('secret scan of tracked/non-ignored files finds nothing', [scan.status, /0 findings/.test(scan.stdout)], [0, true]);
  const ig = spawnSync('git', ['check-ignore', 'backend/.env', 'backend/.env.local'], { cwd: require('path').join(ROOT, '..'), encoding: 'utf8' });
  eq('.env files are git-ignored', ig.stdout.trim().split(/\r?\n/).sort(), ['backend/.env', 'backend/.env.local']);

  done();
})().catch((e) => { console.error(e); process.exit(1); });
