import { api } from './apiClient.js';
import { setSession, setStoredUser, clearSession, redirectToLogin } from '../core/session.js';

// Used by the login page and the app shell.

export async function login(email, password) {
  const res = await api.post('/auth/login', { email, password }, { auth: false });
  setSession(res.data.token, res.data.user);
  return res.data.user;
}

export async function register(name, email, password) {
  const res = await api.post('/auth/register', { name, email, password }, { auth: false });
  setSession(res.data.token, res.data.user);
  return res.data.user;
}

export async function fetchCurrentUser() {
  const res = await api.get('/auth/me');
  setStoredUser(res.data.user);
  return res.data.user;
}

// Stateless JWT: the server has nothing to invalidate, so logging out = forgetting the token. The call is best-effort.
export async function logout() {
  try { await api.post('/auth/logout', {}, { timeout: 3000 }); } catch { /* signing out must always work */ }
  clearSession();
  redirectToLogin();
}
