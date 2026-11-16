const express = require('express');
const c = require('../controllers/importExportController');
const { protect } = require('../middleware/authMiddleware');
const { importLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(protect, importLimiter);
router.post('/preview', c.previewBackup);
router.post('/restore', c.restoreBackup);

module.exports = router;
