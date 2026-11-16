require('dotenv').config();
const { enforceEnv, corsOrigin } = require('./config/env');
const envCheck = enforceEnv(); // production: refuses to start with a missing/weak JWT_SECRET or an open CORS setting
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const budgetRoutes = require('./routes/budgetRoutes');
const goalRoutes = require('./routes/goalRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const insightRoutes = require('./routes/insightRoutes');
const healthScoreRoutes = require('./routes/healthScoreRoutes');
const forecastRoutes = require('./routes/forecastRoutes');
const anomalyRoutes = require('./routes/anomalyRoutes');
const simulationRoutes = require('./routes/simulationRoutes');
const recurringRoutes = require('./routes/recurringRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const reportRoutes = require('./routes/reportRoutes');
const importRoutes = require('./routes/importRoutes');
const exportRoutes = require('./routes/exportRoutes');
const backupRoutes = require('./routes/backupRoutes');
const aiRoutes = require('./routes/aiRoutes');
const recurringScheduler = require('./services/recurringScheduler');
const { invalidateOnWrite } = require('./services/derivedCache');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const requestLogger = require('./middleware/requestLogger');
const logger = require('./utils/logger');
const health = require('./services/health');
const prismaClient = require('./config/prisma');

const app = express();
// Behind a load balancer / reverse proxy (App Runner, ALB, CloudFront, nginx) the client address comes from X-Forwarded-For. TRUST_PROXY=1 (number of proxy hops)
// makes the rate limiters see the real client instead of the proxy; leave it unset when the API is reached directly.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true');

app.use(requestLogger); // request id + one JSON log line per request (no query strings, bodies or tokens)

// ---- Security & parsing middleware ----
app.use(helmet());
app.use(cors({
  origin: envCheck.origins.length ? corsOrigin(envCheck.origins) : '*', // exact allow-list (comma separated CLIENT_URL); '*' only in development
  credentials: true,
  // lets the browser read the server's suggested file name (fintrack-transactions-2025-01-31.csv) on downloads
  exposedHeaders: ['Content-Disposition', 'X-Row-Count'],
}));
// Import/restore carry a file as JSON text, so those routes get a bigger body limit than the 100 kB default (set BEFORE the global parser,
// which skips a body that is already parsed). The services enforce their own, stricter limits on top (file size, rows, items).
app.use('/api/import', express.json({ limit: '3.5mb' }));
app.use('/api/backup', express.json({ limit: '6mb' }));
app.use(express.json());

// ---- Rate limiting ----
// General limiter for all /api routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  skip: (req) => req.path === '/health' || req.path === '/health/ready', // platform health checks must never be rate limited (a 429 would mark the service unhealthy)
  max: Number(process.env.RATE_LIMIT_MAX) || 300, // override for load/e2e testing; default stays 300 per window
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Stricter limiter specifically for login/register to slow down brute force attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20, // login/register attempts per IP per 15 minutes (override only for automated tests)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'FinTrack API is running',
    timestamp: new Date().toISOString(),
  });
});

// Readiness: database, migrations and the background scheduler (503 when not ready). Use it for load-balancer / App Runner health checks and as the post-deploy gate.
app.get('/api/health/ready', async (req, res) => { const r = await health.readiness(); res.status(r.httpStatus).json({ success: r.httpStatus === 200, ...r.body }); });

// ---- Routes ----
app.use('/api/auth', authRoutes);
// Writes to transactions/budgets/goals clear that user's cached insights + health score
app.use('/api/transactions', invalidateOnWrite, transactionRoutes);
app.use('/api/budgets', invalidateOnWrite, budgetRoutes);
app.use('/api/goals', invalidateOnWrite, goalRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/health-score', healthScoreRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api/unusual-spending', anomalyRoutes);
app.use('/api/simulations', simulationRoutes);
app.use('/api/recurring', invalidateOnWrite, recurringRoutes);
app.use('/api/subscriptions', invalidateOnWrite, subscriptionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/import', invalidateOnWrite, importRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/backup', invalidateOnWrite, backupRoutes);
app.use('/api/ai', aiRoutes);

// ---- 404 + centralized error handling (must be registered last) ----
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`FinTrack API server running on http://localhost:${PORT}`);
  // Wakes up on start (catch-up after downtime) and then periodically; the schedules themselves live in the database.
  recurringScheduler.start();
});

// Graceful shutdown (SIGTERM from Docker/App Runner/ECS, Ctrl+C locally): stop taking connections, let in-flight requests finish (max 10 s), stop the
// background scheduler, close the database pool, then exit. Deploys therefore do not cut requests in half.
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return; shuttingDown = true;
  logger.info('shutting down', { signal });
  recurringScheduler.stop();
  const force = setTimeout(() => { logger.warn('forced exit after 10 s'); process.exit(1); }, 10000); force.unref();
  server.close(async () => { try { await prismaClient.$disconnect(); } catch { /* already closed */ } logger.info('shutdown complete'); process.exit(0); });
};
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (reason) => logger.error('unhandled promise rejection', logger.describeError(reason)));

module.exports = app;
