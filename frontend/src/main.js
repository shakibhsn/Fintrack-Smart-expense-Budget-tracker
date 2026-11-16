import { initTheme } from './core/theme.js';
import { isAuthenticated, redirectToLogin } from './core/session.js';
import { logError, StaleError } from './core/logger.js';

// Application entry point: theme -> auth guard -> shell -> router.
initTheme();

let lastToast = 0;
function installGlobalErrorHandlers() {
  // Last line of defence. Page/widget/chart errors are already contained where they happen; anything that still escapes
  // is logged with full technical detail and the user gets a short, friendly notice (throttled) instead of a dead page.
  const report = async (error, source) => {
    if (error instanceof StaleError || (error && error.name === 'AbortError')) return;
    logError(`global:${source}`, error);
    if (Date.now() - lastToast < 5000) return;
    lastToast = Date.now();
    try {
      const { toast } = await import('./components/toast.js');
      toast('Something went wrong. Your data is safe. If it keeps happening, reload the page.', 'error');
    } catch { /* nothing more we can do */ }
  };
  window.addEventListener('error', (e) => {
    if (/ResizeObserver/.test(e.message || '')) return; // benign browser notice
    report(e.error || new Error(e.message), 'error');
  });
  window.addEventListener('unhandledrejection', (e) => report(e.reason, 'promise'));
}

function showFatal(error) {
  logError('boot', error);
  const app = document.getElementById('app');
  app.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;font-family:var(--font-sans)">
    <div><h1 style="font-size:1.25rem;font-weight:800;margin-bottom:8px">FinTrack could not start</h1>
    <p style="color:rgb(var(--mute));margin-bottom:16px">Check your connection, then reload the page.</p>
    <button class="btn btn-primary" onclick="location.reload()">Reload</button></div></div>`;
}

async function boot() {
  installGlobalErrorHandlers();
  try {
    const [{ mountShell }, router] = await Promise.all([import('./layout/shell.js'), import('./core/router.js')]);
    const { outlet } = mountShell(document.getElementById('app'));
    router.start(outlet);
  } catch (err) {
    showFatal(err);
  }
}

if (!isAuthenticated()) redirectToLogin(); else boot();
