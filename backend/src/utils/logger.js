// Structured (JSON-lines) logging to stdout. Container platforms (CloudWatch, App Runner, Docker) collect stdout, so this needs no agent.
//
//  PRIVACY RULES (enforced here, not left to callers):
//   * request logs carry method, PATH (never the query string: it can hold search text), status, duration and a request id. No bodies, no headers, no tokens, no e-mail addresses.
//   * errors log the error name, code and the FIRST line of the message (Prisma puts the offending values on later lines) plus the stack. Stacks contain file paths only.
//   * `meta` values that look like secrets are dropped by key name.
const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|hash|email/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

const clean = (meta = {}) => Object.fromEntries(Object.entries(meta).filter(([k]) => !SECRET_KEYS.test(k)));

function log(level, msg, meta) {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...clean(meta) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

const describeError = (err) => ({
  errName: err && err.name, errCode: err && (err.code || err.statusCode),
  errMessage: String((err && err.message) || '').split('\n')[0].slice(0, 300),
  stack: err && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined,
});

module.exports = {
  debug: (m, x) => log('debug', m, x), info: (m, x) => log('info', m, x), warn: (m, x) => log('warn', m, x), error: (m, x) => log('error', m, x),
  describeError, clean,
};
