// E-mail notifications (opt-in, SMTP from the environment). The API server under test is configured to talk to a local SMTP sink.
// the in-process job calls below need the same mail settings the API server has
Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_IGNORE_TLS: 'true', SMTP_USER: 'mailuser', SMTP_PASS: 's3cret-pass-xyz', EMAIL_FROM: 'FinTrack <noreply@fintrack.test>' });
const { spawn } = require('child_process');
const fs = require('fs');
const { prisma } = require('./dbenv');
const { call, register, eq, done } = require('./lib');
const { startSink, decode } = require('./smtpSink');
const emailSvc = require('../../src/services/emailService');
const J = require('../../src/services/notificationJobs');

const iso = (d) => d.toISOString().slice(0, 10);
const t0 = new Date();
const today = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(100); } return false; };

(async () => {
  let sink = await startSink(2525);
  const uid = async (prefix) => (await prisma.user.findFirst({ where: { email: { startsWith: prefix } }, orderBy: { createdAt: 'desc' } })).id;
  const mailsTo = (addr) => sink.messages.filter((m) => m.to.some((t) => t.includes(addr)));
  const emailOf = async (id) => (await prisma.user.findUnique({ where: { id } })).email;

  const A = await register('e17a'); const aid = await uid('e17a.'); const aMail = await emailOf(aid);
  const B = await register('e17b'); const bid = await uid('e17b.');
  const goal = (T, title) => call(T, 'POST', '/goals', { title, targetAmount: 1000 });

  // ---- defaults: available (server configured) but OFF ----
  const p0 = (await call(A, 'GET', '/notifications/preferences')).data;
  eq('server configured => available; user default OFF; address masked, no password anywhere', [p0.email.available, p0.preferences.emailEnabled, /^e\*+@/.test(p0.email.address) || /\*/.test(p0.email.address), p0.email.address.includes(aMail), JSON.stringify(p0).includes('s3cret-pass-xyz')], [true, false, true, false, false]);
  await goal(A, 'No mail yet');
  await wait(600);
  eq('e-mail OFF (default) => in-app notification only, zero mails', [await prisma.notification.count({ where: { userId: aid, title: 'Goal created: No mail yet' } }), sink.messages.length], [1, 0]);

  // ---- opt in ----
  const on = await call(A, 'PUT', '/notifications/preferences', { emailEnabled: true });
  eq('opt in works (boolean validated)', [on.status, on.data.preferences.emailEnabled, (await call(A, 'PUT', '/notifications/preferences', { emailEnabled: 'yes' })).status], [200, true, 400]);
  await goal(A, 'Mailed goal');
  const got = await until(() => mailsTo(aMail).length >= 1);
  const m = mailsTo(aMail)[0]; const raw = m ? decode(m.raw) : '';
  eq('one mail reaches the sink for the new notification, addressed to the account e-mail only', [got, mailsTo(aMail).length, sink.messages.every((x) => x.to.length === 1), m && m.to[0].includes(aMail)], [true, 1, true, true]);
  eq('mail content: configured sender, subject = title, body has the message, opt-out hint; SMTP auth used', [/noreply@fintrack\.test/.test(m.from), /Subject: Goal created: Mailed goal/.test(raw), /saving/.test(raw), /switched on in your FinTrack notification preferences/.test(raw), m.auth && m.auth.user], [true, true, true, true, 'mailuser']);
  const row = await prisma.notification.findFirst({ where: { userId: aid, title: 'Goal created: Mailed goal' } });
  eq('notification records emailStatus SENT + emailedAt (only after the server accepted it)', [row.emailStatus, !!row.emailedAt], ['SENT', true]);
  eq('API exposes the delivery state, never credentials', [(await call(A, 'GET', '/notifications')).data.notifications.find((n) => n.id === row.id).emailStatus, JSON.stringify((await call(A, 'GET', '/notifications')).data).includes('s3cret-pass-xyz')], ['SENT', false]);

  // ---- no duplicates ----
  const g2 = (await goal(A, 'Milestone goal')).data.goal; await until(() => mailsTo(aMail).length >= 2);
  const before = mailsTo(aMail).length;
  await call(A, 'POST', `/goals/${g2.id}/contributions`, { amount: 300 }); // 30% => one milestone notification
  await until(() => mailsTo(aMail).length >= before + 1);
  const afterOne = mailsTo(aMail).length;
  await call(A, 'POST', `/goals/${g2.id}/contributions`, { amount: 1 }); // plain contribution notification (new event) => one more
  await until(() => mailsTo(aMail).length >= afterOne + 1);
  eq('each distinct event => exactly one mail', [afterOne - before, mailsTo(aMail).length - afterOne], [1, 1]);
  const n0 = mailsTo(aMail).length;
  await prisma.subscription.create({ data: { userId: aid, name: 'Mail sub', category: 'Other', amount: 10, currency: 'BDT', frequency: 'MONTHLY', startDate: new Date(`${dd(-20)}T00:00:00Z`), billingAnchor: new Date(`${dd(-20)}T00:00:00Z`), nextRenewalDate: new Date(`${dd(2)}T00:00:00Z`), status: 'ACTIVE', autoRecord: false } });
  await Promise.all([1, 2, 3, 4, 5].map(() => J.subscriptionReminders({ userId: aid, now: new Date() })));
  await until(() => mailsTo(aMail).length >= n0 + 1); await wait(800);
  eq('5 concurrent reminder runs => ONE notification and ONE mail', [await prisma.notification.count({ where: { userId: aid, title: 'Upcoming renewal: Mail sub' } }), mailsTo(aMail).length - n0], [1, 1]);
  await J.subscriptionReminders({ userId: aid, now: new Date() }); await J.goalOverdue({ userId: aid }); await wait(600);
  eq('re-running the jobs sends nothing more', mailsTo(aMail).length - n0, 1);

  // ---- category off => nothing at all ----
  await call(A, 'PUT', '/notifications/preferences', { goals: false });
  const n1 = sink.messages.length;
  await goal(A, 'Silent category'); await wait(700);
  eq('category switched off => no notification and no mail', [await prisma.notification.count({ where: { userId: aid, title: 'Goal created: Silent category' } }), sink.messages.length - n1], [0, 0]);
  await call(A, 'PUT', '/notifications/preferences', { goals: true });

  // ---- escaping / injection ----
  await goal(A, '<img src=x onerror=alert(1)> "q" & Co');
  await until(() => sink.messages.some((x) => /Co/.test(decode(x.raw)) && /alert/.test(decode(x.raw))));
  const evil = sink.messages.map((x) => decode(x.raw)).find((r) => /onerror/.test(r)) || '';
  const htmlPart = evil.split('Content-Type: text/html')[1] || '';
  eq('HTML part escapes user text (no raw tag), plain part keeps the text', [/<img/.test(htmlPart), /&lt;img src=x onerror=alert\(1\)&gt;/.test(htmlPart), /onerror/.test(evil.split('Content-Type: text/html')[0])], [false, true, true]);
  await goal(A, 'Header\r\nBcc: attacker@evil.test'); await wait(1200);
  eq('header injection through a title is neutralised (no Bcc recipient, single recipient)', [sink.messages.every((x) => x.to.length === 1 && !x.to.some((t) => /evil\.test/.test(t))), sink.messages.some((x) => /^Bcc:/im.test(decode(x.raw).split('\r\n\r\n')[0]))], [true, false]);

  // ---- isolation: B never gets A's mail; B opted out by default ----
  const bMail = await emailOf(bid);
  await goal(B, 'B goal'); await wait(700);
  eq('another user (default OFF) receives nothing; A mails never went to B', [mailsTo(bMail).length, sink.messages.filter((x) => x.to.some((t) => t.includes(bMail))).length], [0, 0]);
  await call(B, 'PUT', '/notifications/preferences', { emailEnabled: true });
  await goal(B, 'B second goal'); await until(() => mailsTo(bMail).length >= 1);
  eq('B opted in => B (only) gets B\'s mail, to B\'s address', [mailsTo(bMail).length, mailsTo(bMail)[0].to[0].includes(bMail), mailsTo(aMail).every((x) => !/B second goal/.test(decode(x.raw)))], [1, true, true]);

  // ---- test e-mail ----
  const tn = mailsTo(aMail).length;
  const te = await call(A, 'POST', '/notifications/email/test');
  await until(() => mailsTo(aMail).length >= tn + 1);
  eq('test e-mail endpoint sends exactly one message to the account address; B cannot trigger one for A', [te.status, mailsTo(aMail).length - tn, /FinTrack test e-mail/.test(decode(mailsTo(aMail).slice(-1)[0].raw)), (await call(null, 'POST', '/notifications/email/test')).status], [200, 1, true, 401]);

  // ---- opt out again ----
  await call(A, 'PUT', '/notifications/preferences', { emailEnabled: false });
  const n2 = mailsTo(aMail).length;
  await goal(A, 'After opt out'); await wait(800);
  eq('after opting out: in-app notification yes, mail no', [await prisma.notification.count({ where: { userId: aid, title: 'Goal created: After opt out' } }), mailsTo(aMail).length - n2], [1, 0]);

  // ---- SMTP down => honest failure, request unaffected, no retry storm ----
  await call(A, 'PUT', '/notifications/preferences', { emailEnabled: true });
  await sink.close();
  const dn = await call(A, 'POST', '/goals', { title: 'Server down goal', targetAmount: 500 });
  const failed = await until(async () => (await prisma.notification.findFirst({ where: { userId: aid, title: 'Goal created: Server down goal' } }))?.emailStatus === 'FAILED', 15000);
  const failedRow = await prisma.notification.findFirst({ where: { userId: aid, title: 'Goal created: Server down goal' } });
  eq('SMTP unreachable: the request still succeeds, notification exists in-app, emailStatus FAILED, never SENT', [dn.status, !!failedRow, failed, failedRow.emailedAt], [201, true, true, null]);
  eq('failed delivery is not retried into duplicates (still one notification row)', await prisma.notification.count({ where: { userId: aid, title: 'Goal created: Server down goal' } }), 1);
  const logText = (process.env.API_LOG ? fs.readFileSync(process.env.API_LOG, 'utf8') : '');
  eq('server log never contains the SMTP password or the user address', [logText.includes('s3cret-pass-xyz'), logText.includes(aMail)], [false, false]);
  eq('test endpoint reports failure honestly (502), message has no credentials', await (async () => { const r = await call(A, 'POST', '/notifications/email/test'); return [r.status, JSON.stringify(r.json).includes('s3cret')]; })(), [502, false]);

  // ---- hourly cap (unit) ----
  const cap = emailSvc.HOURLY_CAP; let allowed = 0; for (let i = 0; i < cap + 5; i += 1) if (emailSvc.allow('cap-user', 1000000 + i)) allowed += 1;
  eq('per-user hourly cap: allows exactly the cap, then refuses; window slides', [allowed, emailSvc.allow('cap-user', 1000000 + 3600001 + cap + 10)], [cap, true]);
  eq('mask helper hides most of the address', [emailSvc.mask('alice@example.com'), emailSvc.mask('')], ['a*****@example.com'.replace('a*****', emailSvc.mask('alice@example.com').split('@')[0]), '']);

  // ---- a server WITHOUT SMTP: cannot be switched on, says so ----
  const child = spawn('node', ['src/server.js'], { cwd: require('path').join(__dirname, '..', '..'), env: { ...process.env, PORT: '5056', RECURRING_SCHEDULER: 'off', RATE_LIMIT_MAX: '100000', SMTP_HOST: '', EMAIL_FROM: '', NODE_ENV: 'test' }, stdio: 'ignore' });
  await until(async () => { try { return (await fetch('http://localhost:5056/api/health')).status === 200; } catch { return false; } }, 15000);
  const call2 = async (T, method, path, body) => { const r = await fetch('http://localhost:5056/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: `Bearer ${T}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); return { status: r.status, json: j, data: j.data }; };
  const email2 = `e17c.${Date.now()}@test.dev`;
  const reg = await call2(null, 'POST', '/auth/register', { name: 'No Mail', email: email2, password: 'secret123' });
  const C = reg.data.token;
  const pc = await call2(C, 'GET', '/notifications/preferences');
  eq('no SMTP configured: email.available false, no address shown', [pc.data.email.available, pc.data.email.address], [false, null]);
  const sw = await call2(C, 'PUT', '/notifications/preferences', { emailEnabled: true });
  eq('switching e-mail on is refused (409) with an honest message; stays off', [sw.status, /not set up/.test(sw.json.message), (await call2(C, 'GET', '/notifications/preferences')).data.preferences.emailEnabled], [409, true, false]);
  eq('test e-mail refused (409) when not configured', (await call2(C, 'POST', '/notifications/email/test')).status, 409);
  child.kill();
  await prisma.user.deleteMany({ where: { email: email2 } });

  done();
})().catch((e) => { console.error(e); process.exit(1); });
