const express = require('express');
const c = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');
const { exportLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(protect);

router.get('/', c.getReport);
router.get('/export/csv', exportLimiter, c.exportReport('csv'));
router.get('/export/pdf', exportLimiter, c.exportReport('pdf'));
router.get('/snapshots', c.listSnapshots);
router.post('/snapshots', c.createSnapshot);
router.get('/snapshots/:id', c.getSnapshot);
router.get('/snapshots/:id/csv', exportLimiter, c.exportSnapshot('csv'));
router.get('/snapshots/:id/pdf', exportLimiter, c.exportSnapshot('pdf'));
router.delete('/snapshots/:id', c.deleteSnapshot);

module.exports = router;
