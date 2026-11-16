const express = require('express');
const c = require('../controllers/subscriptionController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.get('/', c.list);
router.get('/summary', c.summary);
router.post('/', c.create);
router.post('/process', c.processNow);
router.get('/:id', c.getOne);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/pause', c.pause);
router.post('/:id/resume', c.resume);
router.post('/:id/cancel', c.cancel);
router.post('/:id/payments', c.pay);

module.exports = router;
