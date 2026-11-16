const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { protect } = require('../middleware/authMiddleware');
const { processDueForUser } = require('../services/recurringScheduler');

const router = express.Router();
router.use(protect);

router.get('/', processDueForUser, getDashboard);

module.exports = router;
