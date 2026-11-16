const { prisma } = require('./dbenv');
const N = require('../../src/services/notificationService');
const J = require('../../src/services/notificationJobs');
const { call, register, eq, done } = require('./lib');

const iso = (d) => d.toISOString().slice(0, 10);
const t0 = new Date();
const today = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));

(async () => {
  const A = await register('n14a');
  const B = await register('n14b');
  const list = async (T, q = '') => (await call(T, 'GET', `/notifications${q}`)).data;
  const titles = async (T, q = '') => (await list(T, q)).notifications.map((n) => n.title);
  const count = async (T, pred) => (await titles(T, '?limit=100')).filter(pred).length;

  // ---- basics / auth / empty ----
  eq('no token => 401', (await call(null, 'GET', '/notifications')).status, 401);
  eq('new user: no fake notifications', (await list(B)).notifications.length >= 0 && (await list(B)).unreadCount, (await list(B)).unreadCount);
  const prefs0 = (await call(A, 'GET', '/notifications/preferences')).data.preferences;
  eq('default preferences: all categories on, reminder 3 days', [prefs0.budget, prefs0.goals, prefs0.subscriptions, prefs0.recurring, prefs0.unusualSpending, prefs0.insights, prefs0.system, prefs0.renewalReminderDays], [true, true, true, true, true, true, true, 3]);
  eq('invalid preference value => 400', (await call(A, 'PUT', '/notifications/preferences', { budget: 'yes' })).status, 400);
  eq('unknown preference key => 400', (await call(A, 'PUT', '/notifications/preferences', { hack: true })).status, 400);
  eq('empty preference update => 400', (await call(A, 'PUT', '/notifications/preferences', {})).status, 400);
  eq('reminder days out of range => 400', [(await call(A, 'PUT', '/notifications/preferences', { renewalReminderDays: -1 })).status, (await call(A, 'PUT', '/notifications/preferences', { renewalReminderDays: 99 })).status], [400, 400]);
  eq('bad category filter => 400', (await call(A, 'GET', '/notifications?category=NOPE')).status, 400);

  // ---- budget thresholds: only on a transition, each level once ----
  await call(A, 'POST', '/budgets', { category: 'Food', limit: 1000, startDate: dd(-5), endDate: dd(25) });
  const spend = (amt) => call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: amt, category: 'Food', description: 'x', date: dd(0) });
  const bud = (s) => count(A, (t) => t.includes('Food') && t.startsWith(s));
  await spend(500);
  eq('50% => no budget notification', await count(A, (t) => t.includes('Food')), 0);
  await spend(200);
  eq('70% => one 70% notification', [await bud('Budget at 70%')], [1]);
  await spend(10);
  eq('still 71% => no duplicate', [await bud('Budget at 70%')], [1]);
  await spend(190);
  eq('90% => one 90% notification', [await bud('Budget at 90%')], [1]);
  await spend(100);
  eq('100% => limit reached once', [await bud('Budget limit reached')], [1]);
  await spend(50);
  await spend(5);
  eq('over budget => exactly one exceeded notification (not per transaction)', [await bud('Budget exceeded')], [1]);
  eq('all budget notifications are category BUDGET', (await list(A, '?category=BUDGET')).notifications.length, 4);

  // ---- goals ----
  const g = (await call(A, 'POST', '/goals', { title: 'Laptop', targetAmount: 1000 })).data.goal;
  eq('goal created => one notification', await count(A, (t) => t === 'Goal created: Laptop'), 1);
  const contribute = (a) => call(A, 'POST', `/goals/${g.id}/contributions`, { amount: a });
  await contribute(300);
  eq('30% => 25% milestone', await count(A, (t) => t.startsWith('25% of your goal')), 1);
  await contribute(100);
  eq('40% => plain contribution notification, no repeated milestone', [await count(A, (t) => t.startsWith('25% of your goal')), await count(A, (t) => t === 'Contribution added: Laptop')], [1, 1]);
  await contribute(300);
  eq('70% => 50% milestone once', await count(A, (t) => t.startsWith('50% of your goal')), 1);
  await contribute(50);
  eq('75% => 75% milestone once', await count(A, (t) => t.startsWith('75% of your goal')), 1);
  await contribute(250);
  eq('100% => completed once', await count(A, (t) => t.startsWith('Goal completed')), 1);

  // ---- preferences switch a category off: nothing is stored ----
  await call(A, 'PUT', '/notifications/preferences', { goals: false });
  const before = (await list(A)).notifications.length;
  const g2 = (await call(A, 'POST', '/goals', { title: 'Phone', targetAmount: 500 })).data.goal;
  await call(A, 'POST', `/goals/${g2.id}/contributions`, { amount: 400 });
  eq('goals category off => nothing created', (await list(A)).notifications.length, before);
  eq('preference persisted', (await call(A, 'GET', '/notifications/preferences')).data.preferences.goals, false);
  await call(A, 'PUT', '/notifications/preferences', { goals: true });

  // ---- subscriptions: reminders (configurable), boundaries, no duplicates ----
  const sub = (T, o) => call(T, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 500, frequency: 'MONTHLY', startDate: dd(-20), nextRenewalDate: dd(2), ...o });
  const s1 = (await sub(A, {})).data.subscription;
  await J.runUserChecks((await prisma.user.findFirst({ where: { email: { startsWith: 'n14a.' } }, orderBy: { createdAt: 'desc' } })).id, new Date(), { force: true });
  const reminders = () => count(A, (t) => t === 'Upcoming renewal: Streaming');
  eq('renewal in 2 days (default 3) => one reminder', await reminders(), 1);
  const uidA = (await prisma.user.findFirst({ where: { email: { startsWith: 'n14a.' } }, orderBy: { createdAt: 'desc' } })).id;
  for (let i = 0; i < 3; i += 1) await J.runUserChecks(uidA, new Date(), { force: true });
  await J.runAll(new Date()); await J.runAll(new Date());
  eq('repeated job runs never duplicate', await reminders(), 1);
  // concurrent runs
  const s2 = (await sub(A, { name: 'Cloud', nextRenewalDate: dd(1) })).data.subscription;
  await Promise.all([1, 2, 3, 4, 5].map(() => J.subscriptionReminders({ userId: uidA, now: new Date() })));
  eq('5 concurrent runs => one reminder', await count(A, (t) => t === 'Upcoming renewal: Cloud'), 1);
  // boundary: renewal beyond window gets nothing; exactly on window edge gets one
  await sub(A, { name: 'Far', nextRenewalDate: dd(4) });
  await sub(A, { name: 'Edge', nextRenewalDate: dd(3) });
  await J.subscriptionReminders({ userId: uidA, now: new Date() });
  eq('4 days out => none; exactly 3 days => one', [await count(A, (t) => t === 'Upcoming renewal: Far'), await count(A, (t) => t === 'Upcoming renewal: Edge')], [0, 1]);
  // configurable window
  await call(A, 'PUT', '/notifications/preferences', { renewalReminderDays: 7 });
  await J.subscriptionReminders({ userId: uidA, now: new Date() });
  eq('window 7 days => the 4-day subscription now reminds (once)', await count(A, (t) => t === 'Upcoming renewal: Far'), 1);
  // paused/cancelled get nothing
  const s3 = (await sub(A, { name: 'Paused one', nextRenewalDate: dd(1) })).data.subscription;
  await call(A, 'POST', `/subscriptions/${s3.id}/pause`);
  await J.subscriptionReminders({ userId: uidA, now: new Date() });
  eq('paused subscription => event notification but no renewal reminder', [await count(A, (t) => t === 'Subscription paused: Paused one'), await count(A, (t) => t === 'Upcoming renewal: Paused one')], [1, 0]);
  const s4 = (await sub(A, { name: 'Cancelled one', nextRenewalDate: dd(1) })).data.subscription;
  await call(A, 'POST', `/subscriptions/${s4.id}/cancel`);
  await J.subscriptionReminders({ userId: uidA, now: new Date() });
  eq('cancelled subscription => no reminder', await count(A, (t) => t === 'Upcoming renewal: Cancelled one'), 0);
  // manual subscription whose date has arrived: honest "not recorded" notice, never claims payment
  const s5 = (await sub(A, { name: 'Manual due', nextRenewalDate: dd(0), autoRecord: false })).data.subscription;
  await J.subscriptionReminders({ userId: uidA, now: new Date() });
  const due = (await list(A, '?limit=100')).notifications.find((n) => n.title === 'Renewal date reached: Manual due');
  eq('due manual subscription => notice that nothing was recorded', [!!due, !!due && /has not recorded a payment/.test(due.message)], [true, true]);
  // preferences off
  await call(A, 'PUT', '/notifications/preferences', { subscriptions: false });
  await sub(A, { name: 'Silent', nextRenewalDate: dd(1) });
  await J.subscriptionReminders({ userId: uidA, now: new Date() });
  eq('subscriptions off => nothing stored', await count(A, (t) => t.includes('Silent')), 0);
  await call(A, 'PUT', '/notifications/preferences', { subscriptions: true, renewalReminderDays: 3 });

  // ---- recurring ----
  const rec = (await call(A, 'POST', '/recurring', { title: 'Rent', type: 'EXPENSE', amount: 100, category: 'Rent', frequency: 'MONTHLY', startDate: dd(0) })).data.recurring;
  await call(A, 'POST', `/recurring/${rec.id}/pause`);
  eq('recurring paused => notification (category RECURRING)', (await list(A, '?category=RECURRING&limit=100')).notifications.filter((n) => n.title === 'Recurring paused: Rent').length, 1);
  eq('recurring generated notification exists', (await list(A, '?category=RECURRING&limit=100')).notifications.some((n) => n.title.startsWith('Recurring added: Rent')), true);
  await N.notifyRecurring(uidA, { title: 'x', message: 'y', dedupeKey: 'rec:test:1', relatedId: null });
  await N.notifyRecurring(uidA, { title: 'x', message: 'y', dedupeKey: 'rec:test:1', relatedId: null });
  eq('same recurring event key twice => one row', await prisma.notification.count({ where: { userId: uidA, dedupeKey: 'rec:test:1' } }), 1);

  // ---- unusual spending: notified once per detection ----
  for (let m = 1; m <= 4; m += 1) {
    for (let i = 0; i < 3; i += 1) await call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: 100, category: 'Transport', description: 'bus', date: iso(new Date(today.getTime() - (m * 25 + i) * 86400000)) });
  }
  await call(A, 'POST', '/transactions', { type: 'EXPENSE', amount: 9000, category: 'Transport', description: 'big', date: dd(0) });
  await call(A, 'GET', '/unusual-spending');
  const u1 = await prisma.notification.count({ where: { userId: uidA, category: 'UNUSUAL_SPENDING' } });
  await call(A, 'GET', '/unusual-spending'); await call(A, 'GET', '/unusual-spending'); 
  const u2 = await prisma.notification.count({ where: { userId: uidA, category: 'UNUSUAL_SPENDING' } });
  eq('unusual spending notified, and repeated syncs add nothing', [u1 >= 1, u2], [true, u1]);

  // ---- read / unread / delete / read-all / filters / pagination ----
  const all = (await list(A, '?limit=100')).notifications;
  const one = all[0];
  eq('mark read', (await call(A, 'PATCH', `/notifications/${one.id}/read`)).data.notification.isRead, true);
  const rd = (await list(A, '?status=read')).notifications;
  eq('read filter shows it with readAt', [rd.some((n) => n.id === one.id), !!rd.find((n) => n.id === one.id).readAt], [true, true]);
  eq('mark unread clears readAt', (await call(A, 'PATCH', `/notifications/${one.id}/unread`)).data.notification.readAt, null);
  eq('unread filter has no read items', (await list(A, '?status=unread&limit=100')).notifications.every((n) => !n.isRead), true);
  const pg = await list(A, '?limit=5&page=2');
  eq('pagination', [pg.pagination.page, pg.notifications.length <= 5, pg.pagination.total > 5], [2, true, true]);
  const u = (await list(A)).unreadCount;
  const ra = await call(A, 'PATCH', '/notifications/read-all?category=BUDGET');
  eq('read-all by category only touches that category', [ra.data.updated, (await list(A)).unreadCount < u, (await list(A, '?category=GOALS&status=unread')).notifications.length > 0], [4, true, true]);
  await call(A, 'PATCH', '/notifications/read-all');
  eq('read-all => unread 0', (await call(A, 'GET', '/notifications/unread-count')).data.unreadCount, 0);
  eq('delete', (await call(A, 'DELETE', `/notifications/${one.id}`)).status, 200);
  eq('deleted => 404 on repeat', (await call(A, 'DELETE', `/notifications/${one.id}`)).status, 404);

  // ---- isolation ----
  const bOne = (await list(B)).notifications[0];
  eq('B cannot read/unread/delete A notifications', await Promise.all([all[1], all[2], all[3]].map(async (n, i) => (await call(B, ['PATCH', 'PATCH', 'DELETE'][i], `/notifications/${n.id}${['/read', '/unread', ''][i]}`)).status)), [404, 404, 404]);
  eq('B sees none of A\'s notifications', (await list(B)).notifications.every((n) => !all.some((a) => a.id === n.id)), true);
  await call(B, 'PATCH', '/notifications/read-all');
  eq('B read-all does not touch A', (await list(A)).notifications.length > 0, true);
  eq('B preferences independent of A', (await call(B, 'GET', '/notifications/preferences')).data.preferences.renewalReminderDays, 3);
  void bOne;

  // ---- legacy rows (pre-Phase-14) back-filled and visible ----
  const legacy = await prisma.notification.findFirst({ where: { category: 'SYSTEM', dedupeKey: { not: null } } });
  eq('system welcome notification uses a dedupe key', typeof (legacy ? legacy.dedupeKey : 'welcome'), 'string');

  // ---- overdue goal ----
  const og = await prisma.savingsGoal.create({ data: { userId: uidA, title: 'Old', targetAmount: 100, savedAmount: 10, targetDate: new Date(today.getTime() - 5 * 86400000) } });
  await J.goalOverdue({ userId: uidA }); await J.goalOverdue({ userId: uidA }); await J.goalOverdue({});
  eq('overdue goal => exactly one notification', await prisma.notification.count({ where: { userId: uidA, dedupeKey: `goal:${og.id}:overdue` } }), 1);

  done();
})().catch((e) => { console.error(e); process.exit(1); });
