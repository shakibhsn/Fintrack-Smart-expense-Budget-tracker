import { API_BASE_URL, REQUEST_TIMEOUT_MS } from '../core/config.js';
import { getToken, clearSession, redirectToLogin } from '../core/session.js';
import { logError } from '../core/logger.js';

// The ONE place that talks HTTP to the backend. Feature services (transactionService, budgetService, ...) build on it.
//
//  - base URL + Authorization header come from config/session, never from feature code
//  - every request has a timeout; network failures and timeouts become friendly ApiErrors
//  - identical GETs that are already in flight share one request (no duplicate calls when two widgets ask for the same data)
//  - HTTP 401 on an authenticated call = expired/invalid session: clear it and go to the login page (once)
//  - the backend's { success, message } error format is turned into ApiError(message)

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'HTTP', cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code; // HTTP | NETWORK | TIMEOUT | AUTH
    if (cause) this.cause = cause;
  }
}

const inflight = new Map();

function buildUrl(path, query) {
  const url = new URL(`${API_BASE_URL}${path}`, window.location.href);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
  }
  return url.toString();
}

async function send(url, { method, body, timeout, token }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError('The server took too long to respond. Please try again.', { code: 'TIMEOUT', cause: err });
    throw new ApiError('Cannot reach the server. Check your connection and try again.', { code: 'NETWORK', cause: err });
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

export async function request(path, { method = 'GET', body, query, timeout = REQUEST_TIMEOUT_MS, auth = true, dedupe = true } = {}) {
  const token = auth ? getToken() : null;
  if (auth && !token) {
    redirectToLogin({ expired: true });
    throw new ApiError('You are not signed in.', { status: 401, code: 'AUTH' });
  }
  const url = buildUrl(path, query);
  const key = method === 'GET' && dedupe ? `${token}|${url}` : null;

  const run = async () => {
    const { res, json } = await send(url, { method, body, timeout, token });
    if (res.status === 401 && auth) {
      clearSession();
      redirectToLogin({ expired: true });
      throw new ApiError('Your session has expired. Please sign in again.', { status: 401, code: 'AUTH' });
    }
    if (!res.ok) {
      const message = res.status === 429 ? 'Too many requests. Please wait a moment and try again.' : (json.message || `Request failed (${res.status})`);
      const err = new ApiError(message, { status: res.status });
      if (res.status >= 500) logError('api', err, { method, path });
      throw err;
    }
    return json;
  };

  let promise;
  if (key && inflight.has(key)) {
    promise = inflight.get(key);
  } else {
    promise = run();
    if (key) {
      inflight.set(key, promise);
      const clear = () => inflight.delete(key);
      promise.then(clear, clear);
    }
  }
  const json = await promise;
  // callers get their own copy so one widget mutating its data can never affect another's
  return typeof structuredClone === 'function' ? structuredClone(json) : JSON.parse(JSON.stringify(json));
}

export const api = {
  get: (path, query, opts) => request(path, { ...opts, method: 'GET', query }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body: body ?? {} }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body: body ?? {} }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body: body ?? {} }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

// Authenticated FILE download (PDF / CSV / JSON). Plain <a href> links cannot send the Bearer token, so the file is fetched with it,
// turned into a Blob and saved through a temporary link. Errors use the same friendly ApiError messages as everything else.
export async function download(path, query, { fallbackName = 'download', timeout = 60000, method = 'GET', body } = {}) {
  const token = getToken();
  if (!token) { redirectToLogin({ expired: true }); throw new ApiError('You are not signed in.', { status: 401, code: 'AUTH' }); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(buildUrl(path, query), { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError('The export took too long. Please try again.', { code: 'TIMEOUT', cause: err });
    throw new ApiError('Cannot reach the server. Check your connection and try again.', { code: 'NETWORK', cause: err });
  } finally { clearTimeout(timer); }
  if (res.status === 401) { clearSession(); redirectToLogin({ expired: true }); throw new ApiError('Your session has expired. Please sign in again.', { status: 401, code: 'AUTH' }); }
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(res.status === 429 ? 'Too many exports. Please wait a minute and try again.' : (json.message || `Export failed (${res.status})`), { status: res.status });
  }
  const blob = await res.blob();
  const match = /filename="?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') || '');
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { name, size: blob.size };
}
