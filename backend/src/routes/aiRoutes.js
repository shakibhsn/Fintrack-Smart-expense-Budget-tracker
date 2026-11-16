const express = require('express');
const c = require('../controllers/aiController');
const { protect } = require('../middleware/authMiddleware');
const { perUser } = require('../middleware/rateLimiters');

// per user, per minute; the daily provider cap is enforced separately in the service
const aiLimiter = perUser({ max: Number(process.env.AI_RATE_LIMIT_MAX) || 20, message: 'You are asking too quickly. Please wait a minute and try again.' });

const router = express.Router();
router.use(protect);
router.get('/status', c.status);
router.put('/settings', c.putSettings);
router.post('/ask', aiLimiter, c.ask);
router.get('/recommendations', aiLimiter, c.recommendations);
router.post('/recommendations/dismiss', c.dismiss);

module.exports = router;
