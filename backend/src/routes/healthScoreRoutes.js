const express = require('express');
const { getScore } = require('../controllers/healthScoreController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.get('/', getScore);

module.exports = router;
