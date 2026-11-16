const express = require('express');
const c = require('../controllers/importExportController');
const { protect } = require('../middleware/authMiddleware');
const { exportLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(protect, exportLimiter);
router.get('/transactions', c.exportTransactions);
router.get('/budgets', c.exportBudgets);
router.get('/goals', c.exportGoals);
router.get('/subscriptions', c.exportSubscriptions);
router.get('/recurring', c.exportRecurring);
router.get('/backup', c.exportBackup);

module.exports = router;
