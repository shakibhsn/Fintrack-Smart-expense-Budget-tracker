const express = require('express');
const c = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

router.get('/', c.getNotifications);
router.patch('/read-all', c.markAllAsRead); // must come before '/:id/read'
router.patch('/:id/read', c.markAsRead);

module.exports = router;
