const express = require('express');
const { getUserInsights } = require('../controllers/insightController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.get('/', getUserInsights);

module.exports = router;
