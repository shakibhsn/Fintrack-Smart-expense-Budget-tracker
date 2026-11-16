import { STORAGE_KEYS } from './config.js';
import { storage } from './storage.js';
import { emit } from './events.js';

// Theme preference: 'light' | 'dark' | 'system' (default). The inline snippet in the HTML head applies it before
// first paint so there is no flash; this module owns changes after that.

const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export const getThemePreference = () => storage.get(STORAGE_KEYS.theme, 'system');
export const resolveTheme = (pref = getThemePreference()) => (pref === 'system' ? (media && media.matches ? 'dark' : 'light') : pref);
export const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'light';

function apply(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', theme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0A140E' : '#228B22');
}

export function setThemePreference(pref) {
  storage.set(STORAGE_KEYS.theme, pref);
  const theme = resolveTheme(pref);
  apply(theme);
  emit('theme:changed', { theme, preference: pref });
}

export function toggleTheme() {
  setThemePreference(currentTheme() === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  apply(resolveTheme());
  // follow the OS only while the user has not chosen explicitly
  if (media) media.addEventListener('change', () => { if (getThemePreference() === 'system') { apply(resolveTheme()); emit('theme:changed', { theme: resolveTheme(), preference: 'system' }); } });
}
