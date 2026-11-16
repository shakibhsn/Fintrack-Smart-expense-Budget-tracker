// Startup configuration checks. In PRODUCTION an unsafe configuration stops the server from starting (fail fast) instead of running insecurely;
// in development the same problems are printed as warnings. Nothing here prints a secret value.

const PLACEHOLDERS = ['replace_with_a_long_random_secret_string', 'changeme', 'secret', 'password', 'jwt_secret'];

function checkEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const errors = []; const warnings = [];
  const secret = env.JWT_SECRET || '';

  if (!env.DATABASE_URL) errors.push('DATABASE_URL is not set.');
  if (!secret) errors.push('JWT_SECRET is not set.');
  else if (secret.length < 32 || PLACEHOLDERS.includes(secret.toLowerCase())) (production ? errors : warnings).push('JWT_SECRET is weak or still the example value: use at least 32 random characters (for example `openssl rand -base64 48`).');

  const origins = (env.CLIENT_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length) (production ? errors : warnings).push('CLIENT_URL is not set, so any website could call the API from a browser. Set it to the exact frontend origin(s), comma separated.');
  else if (origins.includes('*')) (production ? errors : warnings).push('CLIENT_URL must not be "*" with credentials. List the exact frontend origin(s).');
  else if (production && origins.some((o) => !/^https:\/\//i.test(o))) errors.push('In production every CLIENT_URL origin must use https://.');

  if (production && env.JWT_EXPIRES_IN && /^(\d+d)$/i.test(env.JWT_EXPIRES_IN) && Number(env.JWT_EXPIRES_IN.replace(/d/i, '')) > 14) warnings.push('JWT_EXPIRES_IN is longer than 14 days; tokens cannot be revoked before they expire.');
  if (!production && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') warnings.push('NODE_ENV is not "production": error details and stack traces may be shown. Set NODE_ENV=production when deployed.');
  return { production, errors, warnings, origins };
}

function enforceEnv(env = process.env, log = console) {
  const r = checkEnv(env);
  r.warnings.forEach((w) => log.warn(`[config] warning: ${w}`));
  if (r.errors.length) {
    r.errors.forEach((e) => log.error(`[config] ERROR: ${e}`));
    if (r.production) { log.error('[config] Refusing to start with an unsafe production configuration.'); process.exit(1); }
  }
  return r;
}

// CORS: an exact allow-list. Requests with no Origin header (curl, server-to-server, health checks) are not browser cross-site requests and pass.
const corsOrigin = (origins) => (origin, cb) => {
  if (!origin) return cb(null, true);
  if (origins.includes(origin)) return cb(null, true);
  return cb(null, false); // no CORS headers => the browser blocks the response
};

module.exports = { checkEnv, enforceEnv, corsOrigin };
