const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');

// GET /api/notifications
const getNotifications = asyncHandler(async (req, res) => {
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.notification.count({ where: { userId: req.user.id, isRead: false } }),
  ]);
  res.json({ success: true, data: { notifications, unreadCount } });
});

// PATCH /api/notifications/:id/read
const markAsRead = asyncHandler(async (req, res) => {
  const notification = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!notification) throw httpError(404, 'Notification not found');

  const updated = await prisma.notification.update({ where: { id: notification.id }, data: { isRead: true } });
  res.json({ success: true, data: { notification: updated } });
});

// PATCH /api/notifications/read-all
const markAllAsRead = asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
  res.json({ success: true, message: 'All notifications marked as read' });
});

module.exports = { getNotifications, markAsRead, markAllAsRead };
