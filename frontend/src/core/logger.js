// Errors are never swallowed silently: technical details go to the console (and a small in-memory ring buffer that can be
// inspected with window.__fintrackErrors), while users only ever see a friendly message.

const buffer = [];
if (typeof window !== 'undefined') window.__fintrackErrors = buffer;

export function logError(scope, error, meta = {}) {
  const entry = { scope, message: error && error.message ? error.message : String(error), stack: error && error.stack, meta, at: new Date().toISOString() };
  buffer.push(entry);
  if (buffer.length > 50) buffer.shift();
  // eslint-disable-next-line no-console
  console.error(`[FinTrack:${scope}]`, error, meta);
  return entry;
}

// Friendly text for anything thrown by the API client or by our own code.
export function friendlyMessage(error) {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.code === 'NETWORK') return 'Cannot reach the server. Check your connection and try again.';
  if (error.code === 'TIMEOUT') return 'The server took too long to respond. Please try again.';
  if (error.status && error.status >= 500) return 'The server had a problem. Please try again in a moment.';
  return error.message || 'Something went wrong. Please try again.';
}

// Thrown by ctx.alive() when a page was navigated away from while a request was still running. It is expected, not an error:
// the page code just stops, and nothing is shown or logged.
export class StaleError extends Error {
  constructor() { super('Page changed while loading'); this.name = 'StaleError'; }
}
