const rateLimit = require('express-rate-limit');

// Per-USER limiter (the user id from `protect`, falling back to the IP) for expensive endpoints: report exports, CSV/JSON exports,
// import previews/confirmations and restore. Configurable so tests can raise it; the defaults are deliberately modest.
const perUser = ({ windowMs = 60 * 1000, max, message }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip,
  message: { success: false, message },
});

const exportLimiter = perUser({ max: Number(process.env.EXPORT_RATE_LIMIT_MAX) || 30, message: 'Too many exports. Please wait a minute and try again.' });
const importLimiter = perUser({ max: Number(process.env.IMPORT_RATE_LIMIT_MAX) || 20, message: 'Too many import requests. Please wait a minute and try again.' });

module.exports = { exportLimiter, importLimiter, perUser };
