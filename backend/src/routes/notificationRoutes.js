const express = require('express');
const c = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');
const { perUser } = require('../middleware/rateLimiters');

const testEmailLimiter = perUser({ max: Number(process.env.EMAIL_TEST_RATE_LIMIT_MAX) || 5, message: 'Too many test e-mails. Please wait a minute.' });

const router = express.Router();
router.use(protect);

router.get('/', c.getNotifications);
router.get('/unread-count', c.getUnreadCount);
router.get('/preferences', c.getPrefs);
router.put('/preferences', c.putPrefs);
router.post('/email/test', testEmailLimiter, c.sendTestEmail);
router.patch('/read-all', c.markAllAsRead); // static paths must come before '/:id/...'
router.patch('/:id/read', c.markAsRead);
router.patch('/:id/unread', c.markAsUnread);
router.delete('/:id', c.deleteNotification);

module.exports = router;
