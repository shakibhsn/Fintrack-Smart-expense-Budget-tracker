const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const { getPreferences, updatePreferences } = require('../services/notificationService');
const { runUserChecks } = require('../services/notificationJobs');
const email = require('../services/emailService');
const { listQuerySchema, readAllQuerySchema, preferencesSchema } = require('../validators/notificationValidators');

const serialize = (n) => ({
  id: n.id, title: n.title, message: n.message, type: n.type, category: n.category, isRead: n.isRead,
  createdAt: n.createdAt, readAt: n.readAt, relatedType: n.relatedType, relatedId: n.relatedId, link: n.link,
  emailStatus: n.emailStatus ?? null, emailedAt: n.emailedAt ?? null,
});

// Every query includes userId: another user's notification id is simply "not found".
const findOwned = async (id, userId) => {
  const n = await prisma.notification.findFirst({ where: { id, userId } });
  if (!n) throw httpError(404, 'Notification not found');
  return n;
};

// GET /api/notifications?category=&status=all|unread|read&page=&limit=
const getNotifications = asyncHandler(async (req, res) => {
  const q = listQuerySchema.parse(req.query);
  const userId = req.user.id;
  await runUserChecks(userId); // time-based reminders catch up when the user looks (throttled to once a minute)
  const where = { userId, ...(q.category ? { category: q.category } : {}), ...(q.status === 'unread' ? { isRead: false } : q.status === 'read' ? { isRead: true } : {}) };
  const [rows, total, unreadCount, byCategory] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
    prisma.notification.groupBy({ by: ['category'], where: { userId, isRead: false }, _count: { _all: true } }),
  ]);
  res.json({
    success: true,
    data: {
      notifications: rows.map(serialize), unreadCount,
      unreadByCategory: Object.fromEntries(byCategory.map((g) => [g.category, g._count._all])),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    },
  });
});

// GET /api/notifications/unread-count
const getUnreadCount = asyncHandler(async (req, res) => {
  await runUserChecks(req.user.id);
  res.json({ success: true, data: { unreadCount: await prisma.notification.count({ where: { userId: req.user.id, isRead: false } }) } });
});

const setRead = (isRead) => asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  const n = await prisma.notification.update({ where: { id: req.params.id }, data: { isRead, readAt: isRead ? new Date() : null } });
  res.json({ success: true, data: { notification: serialize(n) } });
});

// PATCH /api/notifications/read-all?category=
const markAllAsRead = asyncHandler(async (req, res) => {
  const { category } = readAllQuerySchema.parse(req.query);
  const { count } = await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false, ...(category ? { category } : {}) }, data: { isRead: true, readAt: new Date() } });
  res.json({ success: true, message: 'All notifications marked as read', data: { updated: count } });
});

// DELETE /api/notifications/:id - removes the notification only. Its dedupeKey goes with it, so a deleted notification may
// be created again if the same event happens again later; nothing else is touched.
const deleteNotification = asyncHandler(async (req, res) => {
  await findOwned(req.params.id, req.user.id);
  await prisma.notification.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Notification deleted' });
});

// GET/PUT /api/notifications/preferences
// e-mail block: whether the SERVER can send e-mail at all (so the UI never offers what is impossible) and where it would go (masked)
const emailInfo = (user) => ({ available: email.isConfigured(), address: email.isConfigured() ? email.mask(user.email) : null, hourlyCap: email.HOURLY_CAP });
const getPrefs = asyncHandler(async (req, res) => res.json({ success: true, data: { preferences: await getPreferences(req.user.id), email: emailInfo(req.user) } }));
const putPrefs = asyncHandler(async (req, res) => {
  const patch = preferencesSchema.parse(req.body);
  res.json({ success: true, data: { preferences: await updatePreferences(req.user.id, patch), email: emailInfo(req.user) } });
});

// POST /api/notifications/email/test - sends ONE test message to the account's own address so the user can verify the setup
const sendTestEmail = asyncHandler(async (req, res) => {
  if (!email.isConfigured()) throw httpError(409, 'E-mail delivery is not set up on this server.');
  const r = await email.send(req.user.id, req.user, { title: 'FinTrack test e-mail', message: 'This is a test message. If you can read it, e-mail notifications are working for your account.', link: '/notifications' }, { bypassCap: true });
  if (!r.ok) throw httpError(502, 'The test e-mail could not be sent. Check the server mail settings.');
  res.json({ success: true, message: 'Test e-mail handed to the mail server', data: { to: email.mask(req.user.email) } });
});

module.exports = { getNotifications, getUnreadCount, markAsRead: setRead(true), markAsUnread: setRead(false), markAllAsRead, deleteNotification, getPrefs, putPrefs, sendTestEmail };
