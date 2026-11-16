const express = require('express');
const c = require('../controllers/recurringController');
const { protect } = require('../middleware/authMiddleware');
const { processDueForUser } = require('../services/recurringScheduler');

const router = express.Router();
router.use(protect);
router.get('/', processDueForUser, c.list);
router.post('/', c.create);
router.post('/process', c.processNow);
router.get('/:id', c.getOne);
router.put('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/pause', c.pause);
router.post('/:id/resume', c.resume);
router.get('/:id/occurrences', c.occurrences);

module.exports = router;
