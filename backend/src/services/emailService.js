const nodemailer = require('nodemailer');

// ---------------------------------------------------------------------------
// Optional e-mail delivery for notifications.
//
// HONESTY RULES
//  * E-mail is available only when the SERVER is configured with an SMTP host and a sender address (environment variables below).
//    Without them nothing is ever sent and the app says so: users cannot switch e-mail on, and no screen claims delivery.
//  * A notification is marked SENT only after the mail server ACCEPTED the message (this is "handed to the mail server", not proof that
//    it reached the inbox). A failure is recorded as FAILED; there is no automatic retry, so one event can never produce two e-mails.
//  * Credentials live ONLY in environment variables. They are never stored in the database, returned by the API or written to logs
//    (log lines carry the error code, never the message text, which could echo a server banner).
//  * Opt-in per user (NotificationPreference.emailEnabled, default OFF), sent to the account's own address, and capped per user per
//    hour so a burst of events cannot flood an inbox.
//
// Environment: SMTP_HOST, EMAIL_FROM (required) | SMTP_PORT (587) | SMTP_SECURE ("true" = TLS from the start, usually port 465)
//              SMTP_USER + SMTP_PASS (optional pair) | SMTP_IGNORE_TLS ("true" only for local test servers) | APP_URL (link in the mail)
// ---------------------------------------------------------------------------

const HOURLY_CAP = Number(process.env.EMAIL_HOURLY_CAP) || 30;
const sentLog = new Map(); // userId -> timestamps (ms) in the last hour

const isConfigured = () => !!(process.env.SMTP_HOST && process.env.EMAIL_FROM);

let cached = null; let cachedKey = '';
const transport = () => {
  const key = [process.env.SMTP_HOST, process.env.SMTP_PORT, process.env.SMTP_SECURE, process.env.SMTP_USER, process.env.SMTP_IGNORE_TLS].join('|');
  if (cached && key === cachedKey) return cached;
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    ignoreTLS: process.env.SMTP_IGNORE_TLS === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
  });
  cachedKey = key;
  return cached;
};

// per-user hourly cap (in memory: it resets on restart, which is fine for a flood guard)
const allow = (userId, now = Date.now()) => {
  const hour = 60 * 60 * 1000;
  const list = (sentLog.get(userId) || []).filter((t) => now - t < hour);
  if (list.length >= HOURLY_CAP) { sentLog.set(userId, list); return false; }
  list.push(now); sentLog.set(userId, list);
  if (sentLog.size > 5000) sentLog.delete(sentLog.keys().next().value);
  return true;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mask = (email) => { const [u, d] = String(email || '').split('@'); return u && d ? `${u[0]}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}` : ''; };
const appUrl = () => (process.env.APP_URL || process.env.CLIENT_URL || '').replace(/\/$/, '');

function buildMessage({ title, message, link }, user) {
  const base = appUrl();
  const url = base && link ? `${base}/fintrack_application.html#${link}` : (base ? `${base}/fintrack_application.html#/notifications` : '');
  const text = `${message}\n\n${url ? `Open FinTrack: ${url}\n\n` : ''}You receive this because e-mail notifications are switched on in your FinTrack notification preferences. Turn them off there at any time.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2 style="margin:0 0 8px;color:#1f7a5a">${esc(title)}</h2><p style="margin:0 0 16px;color:#1c2b26">${esc(message)}</p>${url ? `<p><a href="${esc(url)}">Open FinTrack</a></p>` : ''}<p style="color:#5c6b66;font-size:12px">You receive this because e-mail notifications are switched on in your FinTrack notification preferences. Turn them off there at any time.</p></div>`;
  return { from: process.env.EMAIL_FROM, to: user.email, subject: String(title).slice(0, 200), text, html };
}

// Returns { ok: true } or { ok: false, reason }. Never throws, never logs message text or credentials.
async function send(userId, user, content, { bypassCap = false } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!bypassCap && !allow(userId)) return { ok: false, reason: 'RATE_LIMITED' };
  try {
    await transport().sendMail(buildMessage(content, user));
    return { ok: true };
  } catch (err) {
    console.error('[email] send failed:', err && err.code ? err.code : 'ERROR');
    return { ok: false, reason: 'SEND_FAILED' };
  }
}

module.exports = { isConfigured, send, allow, mask, esc, buildMessage, HOURLY_CAP };
