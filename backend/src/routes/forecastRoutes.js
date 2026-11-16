const express = require('express');
const { getUserForecast } = require('../controllers/forecastController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.get('/', getUserForecast);

module.exports = router;
