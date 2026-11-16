// Catches requests that didn't match any route
const logger = require('../utils/logger');

const notFound = (req, res, next) => {
  const error = new Error(`Route not found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

// Centralized error handler. Every thrown/forwarded error ends up here.
const errorHandler = (err, req, res, next) => {
  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  let message = err.message || 'Internal Server Error';

  // Errors created with httpError(status, message)
  if (err.statusCode) statusCode = err.statusCode;

  // Zod validation errors thrown while parsing query strings
  if (err.name === 'ZodError') {
    statusCode = 400;
    message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }

  // Never leak internal/database details on unexpected errors
  if (statusCode === 500 && process.env.NODE_ENV !== 'development') {
    message = 'Internal Server Error';
  }

  // Body larger than the route allows / not JSON (body-parser)
  if (err.type === 'entity.too.large') { statusCode = 413; message = 'The file is too large to upload.'; }
  if (err.type === 'entity.parse.failed') { statusCode = 400; message = 'The request body is not valid JSON.'; }

  // Prisma: unique constraint violation (e.g. duplicate email)
  if (err.code === 'P2002') {
    statusCode = 409;
    const field = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'field';
    message = `A record with this ${field} already exists`;
  }

  // Prisma: record not found
  if (err.code === 'P2025') {
    statusCode = 404;
    message = 'Record not found';
  }

  // server errors are logged (name, code, first line of the message, stack; never request bodies or headers) with the request id for correlation
  if (statusCode >= 500) logger.error('request failed', { reqId: req.id, method: req.method, path: String(req.originalUrl || '').split('?')[0], status: statusCode, ...logger.describeError(err) });
  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
};

module.exports = { notFound, errorHandler };
