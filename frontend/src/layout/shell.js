import { html, render, $, on, timeAgo, debounce } from '../core/dom.js';
import { routes, onRouteChange, navigate, refresh } from '../core/router.js';
import { on as onEvent, emit } from '../core/events.js';
import { toggleTheme } from '../core/theme.js';
import { STORAGE_KEYS } from '../core/config.js';
import { storage } from '../core/storage.js';
import { getStoredUser } from '../core/session.js';
import { logError } from '../core/logger.js';
import { fetchCurrentUser, logout } from '../services/authService.js';
import { getNotifications, markRead, markAllRead } from '../services/notificationService.js';
import { bindDropdown } from '../components/dropdown.js';
import { toastError } from '../components/toast.js';
import { confirmDialog } from '../components/confirmDialog.js';

// The application shell: sidebar, top bar, profile menu, notifications, theme toggle and the content outlet.
// It is built ONCE and reused by every page; pages render only into <main>. A crash inside a page can never remove it.

const NOTIF = {
  BUDGET_EXCEEDED: ['triangle-exclamation', 'badge-danger'],
  BUDGET_CRITICAL: ['triangle-exclamation', 'badge-warning'],
  BUDGET_WARNING: ['triangle-exclamation', 'badge-warning'],
  GOAL_PROGRESS: ['bullseye', 'badge-brand'],
  RECURRING: ['repeat', 'badge-brand'],
  INFO: ['circle-info', 'badge-accent'],
};
const initials = (name = '') => (name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('') || '?').toUpperCase();
const root = document.documentElement;
const mobileQuery = window.matchMedia('(max-width: 1023px)');

function navMarkup() {
  const sections = [...new Set(routes.map((r) => r.section))];
  return sections.map((s) => html`<div class="nav-section">${s}</div>${routes.filter((r) => r.section === s).map((r) => html`
    <a class="nav-link" href="#${r.path}" data-route="${r.path}" data-tooltip="${r.title}" data-tooltip-pos="right">
      <i class="fa-solid fa-${r.icon}" aria-hidden="true"></i><span class="nav-label">${r.title}</span>
      ${r.badge ? html`<span class="nav-badge" data-badge="${r.badge}" hidden></span>` : ''}
    </a>`)}`);
}

export function mountShell(host) {
  const user = getStoredUser() || {};
  render(host, html`
    <a class="skip-link" href="#main">Skip to main content</a>
    <div class="app">
      <aside class="sidebar" id="sidebar" aria-label="Sidebar">
        <a class="sidebar-brand" href="#/dashboard" aria-label="FinTrack home">
          <span class="brand-mark"><i class="fa-solid fa-wallet" aria-hidden="true"></i></span>
          <span class="brand-text"><span class="brand-name">FinTrack</span><span class="brand-tag block">Smart finance</span></span>
        </a>
        <nav class="sidebar-nav" aria-label="Main navigation">${navMarkup()}</nav>
        <div class="sidebar-foot desktop-only">
          <button type="button" class="btn btn-ghost w-full" data-action="toggle-collapse" data-tooltip="Expand sidebar" data-tooltip-pos="right" aria-label="Collapse sidebar" style="justify-content:flex-start">
            <i class="fa-solid fa-angles-left" aria-hidden="true" data-collapse-icon></i><span class="nav-label sidebar-foot-text">Collapse</span>
          </button>
        </div>
      </aside>
      <div class="sidebar-overlay mobile-only" data-action="close-drawer" hidden></div>

      <div class="main-col">
        <header class="topbar">
          <div class="topbar-left">
            <button type="button" class="btn btn-ghost btn-icon mobile-only" data-action="open-drawer" aria-label="Open navigation menu" aria-controls="sidebar" aria-expanded="false"><i class="fa-solid fa-bars" aria-hidden="true"></i></button>
            <form class="topbar-search" role="search" data-search-form>
              <div class="input-icon"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                <input class="input" type="search" id="global-search" placeholder="Search transactions…" aria-label="Search transactions" autocomplete="off"></div>
            </form>
          </div>
          <div class="topbar-right">
            <button type="button" class="btn btn-primary" data-action="quick-add"><i class="fa-solid fa-plus" aria-hidden="true"></i><span class="hidden sm:inline">Add transaction</span><span class="sr-only sm:hidden">Add transaction</span></button>
            <button type="button" class="btn btn-ghost btn-icon" data-action="toggle-theme" aria-label="Switch between light and dark theme" data-tooltip="Theme" data-tooltip-pos="bottom"><i class="fa-solid fa-circle-half-stroke" aria-hidden="true"></i></button>
            <div class="relative">
              <button type="button" class="btn btn-ghost btn-icon relative" id="notif-trigger" aria-label="Notifications"><i class="fa-solid fa-bell" aria-hidden="true"></i><span class="badge badge-danger" id="notif-count" style="position:absolute;top:2px;right:0;padding:0 5px;min-width:18px;justify-content:center" hidden></span></button>
              <div class="menu" id="notif-menu" style="right:0;top:calc(100% + 8px);width:min(380px,92vw);padding:0" hidden>
                <div class="flex items-center justify-between" style="padding:12px 16px;border-bottom:1px solid rgb(var(--line))"><h2 class="section-title">Notifications</h2>
                  <button type="button" class="link text-xs" data-action="mark-all-read">Mark all read</button></div>
                <div id="notif-list" style="max-height:340px;overflow-y:auto;padding:8px" aria-live="polite"></div>
                <div style="padding:10px 16px;border-top:1px solid rgb(var(--line));text-align:center"><a class="link text-xs" href="#/notifications" data-notif-all>View all notifications</a></div>
              </div>
            </div>
            <div class="relative">
              <button type="button" class="btn btn-ghost" id="profile-trigger" aria-label="Account menu" style="padding:0 6px 0 4px;gap:8px">
                <span class="avatar" data-user-initials>${initials(user.name)}</span>
                <span class="topbar-user-text desktop-only" style="text-align:left;line-height:1.2"><span class="block text-xs font-bold" data-user-name>${user.name || 'Account'}</span><span class="block" style="font-size:10px;color:rgb(var(--mute))" data-user-email>${user.email || ''}</span></span>
                <i class="fa-solid fa-chevron-down desktop-only" style="font-size:10px" aria-hidden="true"></i>
              </button>
              <div class="menu" id="profile-menu" role="menu" style="right:0;top:calc(100% + 8px)" hidden>
                <div style="padding:8px 12px"><div class="text-sm font-bold" data-user-name>${user.name || 'Account'}</div><div class="card-sub" data-user-email>${user.email || ''}</div></div>
                <div class="menu-sep"></div>
                <a class="menu-item" role="menuitem" href="#/settings"><i class="fa-solid fa-gear" aria-hidden="true"></i>Settings</a>
                <button type="button" class="menu-item is-danger" role="menuitem" data-action="logout"><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>Log out</button>
              </div>
            </div>
          </div>
        </header>
        <main id="main" class="content" tabindex="-1" aria-labelledby="page-title"></main>
      </div>
    </div>
    <div id="route-announcer" class="sr-only" aria-live="polite" role="status"></div>`);

  const sidebar = $('#sidebar', host);
  const overlay = $('.sidebar-overlay', host);
  const opener = $('[data-action="open-drawer"]', host);
  const outlet = $('#main', host);
  const ac = new AbortController();
  const { signal } = ac;

  // ----- sidebar: collapse (desktop) + drawer (mobile) -----
  const setCollapsed = (collapsed) => {
    root.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    storage.set(STORAGE_KEYS.sidebar, collapsed ? 'collapsed' : 'expanded');
    const btn = $('[data-action="toggle-collapse"]', host);
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.dataset.tooltip = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    $('[data-collapse-icon]', host).className = `fa-solid ${collapsed ? 'fa-angles-right' : 'fa-angles-left'}`;
  };
  setCollapsed(storage.get(STORAGE_KEYS.sidebar) === 'collapsed');

  const syncInert = () => { sidebar.inert = mobileQuery.matches && root.dataset.drawer !== 'open'; };
  const setDrawer = (open) => {
    if (open) root.dataset.drawer = 'open'; else delete root.dataset.drawer;
    overlay.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    syncInert();
    if (open) $('.nav-link[aria-current="page"], .nav-link', sidebar)?.focus(); else if (mobileQuery.matches) opener.focus({ preventScroll: true });
  };
  syncInert();
  mobileQuery.addEventListener('change', () => { delete root.dataset.drawer; overlay.hidden = true; syncInert(); }, { signal });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.dataset.drawer === 'open') setDrawer(false); }, { signal });

  // ----- click actions -----
  on(host, 'click', '[data-action]', async (e, el) => {
    switch (el.dataset.action) {
      case 'toggle-collapse': setCollapsed(root.dataset.sidebar !== 'collapsed'); break;
      case 'open-drawer': setDrawer(true); break;
      case 'close-drawer': setDrawer(false); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'logout': {
        const ok = await confirmDialog({ title: 'Log out?', message: 'You will need to sign in again to see your data.', confirmLabel: 'Log out' });
        if (ok) logout();
        break;
      }
      case 'quick-add': {
        try {
          const { openTransactionModal } = await import('../features/transactions/transactionModal.js');
          openTransactionModal({ onSaved: () => { emit('data:changed', { scope: 'transactions' }); refresh(); } });
        } catch (err) { logError('shell:quick-add', err); toastError(err, 'Could not open the form.'); }
        break;
      }
      case 'mark-all-read':
        try { await markAllRead(); await loadNotifications(); } catch (err) { toastError(err); }
        break;
      default: break;
    }
  }, { signal });
  on(sidebar, 'click', '.nav-link', () => { if (mobileQuery.matches) setDrawer(false); }, { signal });

  // The skip link must not use its #main hash (hash routing would treat it as a route); focus the content directly.
  $('.skip-link', host).addEventListener('click', (e) => { e.preventDefault(); outlet.focus(); }, { signal });

  // top-bar search -> transactions page filtered by the text
  host.querySelector('[data-search-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#global-search', host).value.trim();
    navigate(`/transactions${text ? `?search=${encodeURIComponent(text)}` : ''}`);
  }, { signal });

  // ----- active route -----
  onRouteChange(({ path }) => {
    host.querySelectorAll('.nav-link').forEach((a) => {
      if (a.dataset.route === path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (root.dataset.drawer === 'open') setDrawer(false);
    scheduleNotifRefresh();
  });

  // ----- notifications -----
  const notifMenu = $('#notif-menu', host);
  const notifList = $('#notif-list', host);
  const countEl = $('#notif-count', host);
  let notifications = [];
  async function loadNotifications() {
    try {
      const data = await getNotifications({ limit: 12 });
      notifications = data.notifications;
      countEl.hidden = data.unreadCount === 0;
      countEl.textContent = data.unreadCount > 9 ? '9+' : String(data.unreadCount);
      const navBadge = host.querySelector('[data-badge="notifications"]');
      if (navBadge) { navBadge.hidden = data.unreadCount === 0; navBadge.textContent = data.unreadCount > 9 ? '9+' : String(data.unreadCount); }
      $('#notif-trigger', host).setAttribute('aria-label', data.unreadCount ? `Notifications, ${data.unreadCount} unread` : 'Notifications');
      render(notifList, notifications.length ? notifications.map((n) => {
        const [ic, tone] = NOTIF[n.type] || NOTIF.INFO;
        return html`<button type="button" class="menu-item" style="align-items:flex-start;${n.isRead ? 'opacity:.6' : ''}" data-notif="${n.id}">
          <span class="badge ${tone}" style="width:28px;height:28px;justify-content:center;padding:0"><i class="fa-solid fa-${ic}" aria-hidden="true"></i></span>
          <span style="min-width:0"><span class="block text-xs font-bold">${n.title}</span><span class="block card-sub" style="white-space:normal">${n.message}</span><span class="block" style="font-size:10px;color:rgb(var(--subtle))">${timeAgo(n.createdAt)}</span></span></button>`;
      }) : html`<p class="card-sub" style="text-align:center;padding:24px 0">No notifications yet.</p>`);
    } catch (err) { logError('shell:notifications', err); }
  }
  const scheduleNotifRefresh = debounce(loadNotifications, 400);
  bindDropdown({ trigger: $('#notif-trigger', host), menu: notifMenu, onOpen: loadNotifications, signal });
  on(notifMenu, 'click', '[data-notif]', async (e, el) => {
    try {
      const n = notifications.find((x) => x.id === el.dataset.notif);
      await markRead(el.dataset.notif); await loadNotifications();
      if (n && n.link) { notifMenu.hidden = true; navigate(n.link); }
    } catch (err) { toastError(err); }
  }, { signal });
  on(notifMenu, 'click', '[data-notif-all]', () => { notifMenu.hidden = true; }, { signal });
  bindDropdown({ trigger: $('#profile-trigger', host), menu: $('#profile-menu', host), signal });

  // ----- sidebar badge: active unusual-spending findings -----
  async function loadBadges() {
    try {
      const { getUnusualCounts } = await import('../features/anomaly-detection/anomalyService.js');
      const n = await getUnusualCounts();
      const b = host.querySelector('[data-badge="anomaly"]');
      if (b) { b.hidden = n === 0; b.textContent = n > 9 ? '9+' : String(n); }
    } catch (err) { logError('shell:badges', err); }
  }
  const scheduleBadges = debounce(loadBadges, 600);
  onEvent('data:changed', () => { scheduleNotifRefresh(); scheduleBadges(); }, { signal });
  onEvent('notifications:changed', () => scheduleNotifRefresh(), { signal });

  // ----- user identity (cached copy first, then the real one from the server) -----
  const paintUser = (u) => {
    host.querySelectorAll('[data-user-name]').forEach((el) => { el.textContent = u.name || 'Account'; });
    host.querySelectorAll('[data-user-email]').forEach((el) => { el.textContent = u.email || ''; });
    host.querySelectorAll('[data-user-initials]').forEach((el) => { el.textContent = initials(u.name); });
  };
  fetchCurrentUser().then(paintUser).catch((err) => { logError('shell:user', err); });

  loadNotifications();
  loadBadges();
  setInterval(() => { if (!document.hidden) loadNotifications(); }, 90000);

  return { outlet };
}

