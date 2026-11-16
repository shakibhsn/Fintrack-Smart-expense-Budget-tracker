import { html, render } from '../../core/dom.js';
import { pageHeader, card, button, segmented } from '../../components/ui.js';
import { skeletonRows } from '../../components/skeleton.js';
import { errorState } from '../../components/states.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast } from '../../components/toast.js';
import { fetchCurrentUser, logout } from '../../services/authService.js';
import { getThemePreference, setThemePreference } from '../../core/theme.js';
import { STORAGE_KEYS } from '../../core/config.js';
import { storage } from '../../core/storage.js';
import { logError, StaleError } from '../../core/logger.js';

// Settings shows only REAL, working things: the signed-in account (read-only, from the server), appearance
// preferences (stored in this browser) and sign-out. Nothing here pretends to save data that has no backend.

const view = (user, themePref, collapsed) => html`
  ${pageHeader({ title: 'Settings', subtitle: 'Your account and how FinTrack looks on this device.' })}
  <div class="settings-layout">
    ${card({ title: 'Account', subtitle: 'Signed-in profile', body: html`
      <div class="profile-grid">
        <div><div class="label">Full name</div><div class="readonly-value" data-field="name">${user.name}</div></div>
        <div><div class="label">Email address</div><div class="readonly-value" data-field="email">${user.email}</div></div>
        <div><div class="label">Currency</div><div class="readonly-value">${user.currency || 'BDT'} (৳)</div></div>
      </div>
      <p class="field-hint" style="margin-top:12px">Editing your profile or currency is not available yet: the server does not have an endpoint for it, so these fields are read-only rather than pretending to save.</p>` })}

    ${card({ title: 'Appearance', subtitle: 'Saved in this browser', body: html`
      <div class="settings-row"><div><div class="label-text">Theme</div><div class="hint-text">“System” follows your device setting.</div></div>
        <div class="settings-seg">${segmented({ name: 'theme', value: themePref, items: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] })}</div></div>
      <div class="settings-row"><div><div class="label-text">Compact sidebar</div><div class="hint-text">Show only icons in the sidebar on desktop.</div></div>
        <label class="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" id="pref-collapse" ${collapsed ? 'checked' : ''}> <span>Collapsed</span></label></div>` })}

    ${card({ title: 'Session', body: html`
      <div class="settings-row"><div><div class="label-text">Sign out</div><div class="hint-text">You will need to sign in again to see your data.</div></div>
        ${button({ label: 'Log out', icon: 'right-from-bracket', variant: 'danger', action: 'logout' })}</div>` })}
  </div>`;

export default {
  styles: [new URL('./settings.css', import.meta.url).href],
  async mount(ctx) {
    render(ctx.outlet, html`${pageHeader({ title: 'Settings' })}${skeletonRows(3, 72)}`);
    let user;
    try {
      user = await ctx.alive(fetchCurrentUser());
    } catch (err) {
      if (err instanceof StaleError) return;
      logError('settings', err);
      render(ctx.outlet, html`${pageHeader({ title: 'Settings' })}${errorState({ error: err, title: 'Could not load your account' })}`);
      ctx.outlet.querySelector('[data-action="retry"]')?.addEventListener('click', () => ctx.refresh(), { once: true });
      return;
    }
    const draw = () => render(ctx.outlet, view(user, getThemePreference(), storage.get(STORAGE_KEYS.sidebar) === 'collapsed'));
    draw();

    ctx.on(ctx.outlet, 'click', '[data-seg="theme"]', (e, el) => {
      setThemePreference(el.dataset.value);
      ctx.outlet.querySelectorAll('[data-seg="theme"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      toast(`Theme set to ${el.dataset.value}.`, 'info');
    });
    ctx.on(ctx.outlet, 'change', '#pref-collapse', (e, el) => {
      storage.set(STORAGE_KEYS.sidebar, el.checked ? 'collapsed' : 'expanded');
      document.documentElement.dataset.sidebar = el.checked ? 'collapsed' : 'expanded';
    });
    ctx.on(ctx.outlet, 'click', '[data-action="logout"]', async () => {
      if (await confirmDialog({ title: 'Log out?', message: 'You will need to sign in again to see your data.', confirmLabel: 'Log out' })) logout();
    });
  },
};
