import { STORAGE_KEYS, LOGIN_PAGE } from './config.js';
import { storage } from './storage.js';

// Session = the JWT issued by the backend + a cached copy of the user's name/email for instant display.
// Same storage keys as before the refactor, so people stay signed in after the upgrade.

export const getToken = () => storage.get(STORAGE_KEYS.token);
export const getStoredUser = () => storage.getJson(STORAGE_KEYS.user);
export const isAuthenticated = () => !!getToken();

export function setSession(token, user) {
  storage.set(STORAGE_KEYS.token, token);
  if (user) storage.setJson(STORAGE_KEYS.user, user);
}
export function setStoredUser(user) { storage.setJson(STORAGE_KEYS.user, user); }

export function clearSession() {
  storage.remove(STORAGE_KEYS.token);
  storage.remove(STORAGE_KEYS.user);
}

let redirecting = false;
// Used for logout and for an expired/invalid token (HTTP 401). Redirects once, however many requests fail together.
export function redirectToLogin({ expired = false } = {}) {
  if (redirecting) return;
  redirecting = true;
  window.location.replace(expired ? `${LOGIN_PAGE}?expired=1` : LOGIN_PAGE);
}
