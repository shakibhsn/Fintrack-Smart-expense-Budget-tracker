const express = require('express');
const c = require('../controllers/importExportController');
const { protect } = require('../middleware/authMiddleware');
const { importLimiter, exportLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(protect);
router.get('/template', exportLimiter, c.template);
router.post('/transactions/preview', importLimiter, c.previewImport);
router.post('/transactions/confirm', importLimiter, c.confirmImport);
router.post('/transactions/error-report', importLimiter, c.errorReport);
router.get('/history', c.history);
router.post('/history/:id/undo', importLimiter, c.undo);

module.exports = router;
