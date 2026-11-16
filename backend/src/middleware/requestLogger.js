const crypto = require('crypto');
const logger = require('../utils/logger');

// One JSON log line per request + an X-Request-Id header (reuses a sane incoming id from a load balancer, otherwise generates one), so a user's
// error report can be matched to a log line. Health checks are not logged (they fire every few seconds). 5xx responses log at "error", 4xx at "warn".
const SKIP = new Set(['/api/health', '/api/health/ready']);

module.exports = function requestLogger(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  if (SKIP.has(req.path)) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http', { reqId: req.id, method: req.method, path: req.originalUrl.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id'), status: res.statusCode, ms, userId: req.user ? req.user.id : undefined });
  });
  return next();
};
