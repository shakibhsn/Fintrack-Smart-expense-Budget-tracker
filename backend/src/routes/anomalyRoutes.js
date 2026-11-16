const express = require('express');
const { list, updateStatus, relatedTransactions } = require('../controllers/anomalyController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.get('/', list);
router.patch('/:id', updateStatus);
router.get('/:id/transactions', relatedTransactions);

module.exports = router;
