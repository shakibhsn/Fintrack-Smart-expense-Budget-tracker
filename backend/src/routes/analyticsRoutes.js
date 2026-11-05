const express = require('express');
const c = require('../controllers/analyticsController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

router.get('/overview', c.getOverview);
router.get('/monthly', c.getMonthly);
router.get('/categories', c.getCategories);
router.get('/income-expense', c.getIncomeExpense);
router.get('/forecast', c.getForecast);

module.exports = router;
