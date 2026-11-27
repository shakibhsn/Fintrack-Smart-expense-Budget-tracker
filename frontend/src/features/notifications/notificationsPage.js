import { html, render, $, timeAgo } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { navigate } from '../../core/router.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, chipGroup, badge, card, button, icon } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonRows } from '../../components/skeleton.js';
import { pagination, bindPagination } from '../../components/pagination.js';
import { toast, toastError } from '../../components/toast.js';
import {
  getNotifications, markRead, markUnread, markAllRead, deleteNotification, getPreferences, savePreferences, sendTestEmail, CATEGORIES,
} from '../../services/notificationService.js';

const LIMIT = 15;
const CAT = Object.fromEntries(CATEGORIES.map(([v, label, ic, key]) => [v, { label, ic, key }]));
const TONE = { BUDGET_EXCEEDED: 'danger', BUDGET_CRITICAL: 'warning', BUDGET_WARNING: 'warning', GOAL_PROGRESS: 'brand', RECURRING: 'brand', INFO: 'accent' };

const item = (n) => html`<article class="nc-item" role="listitem" data-unread="${String(!n.isRead)}" data-id="${n.id}">
  <span class="badge badge-${TONE[n.type] || 'accent'}" style="width:32px;height:32px;justify-content:center;padding:0;flex-shrink:0">${icon((CAT[n.category] || CAT.SYSTEM).ic)}</span>
  <div class="nc-main">
    <div class="nc-title">${n.title}${n.isRead ? '' : html` <span class="sr-only">(unread)</span>`}</div>
    <div class="nc-msg">${n.message}</div>
    <div class="nc-meta">${badge((CAT[n.category] || CAT.SYSTEM).label)}<time datetime="${n.createdAt}" title="${new Date(n.createdAt).toLocaleString()}">${timeAgo(n.createdAt)}</time>${n.link ? html`<a class="link" href="#${n.link}" data-open="${n.id}">View related</a>` : ''}${n.emailStatus === 'SENT' ? badge('E-mail sent', 'brand') : n.emailStatus === 'FAILED' ? badge('E-mail failed', 'danger') : ''}</div>
  </div>
  <div class="nc-actions">
    ${n.isRead
    ? button({ label: 'Mark unread', icon: 'envelope', variant: 'ghost', size: 'sm', action: 'unread', attrs: { 'data-id': n.id } })
    : button({ label: 'Mark read', icon: 'check', variant: 'ghost', size: 'sm', action: 'read', attrs: { 'data-id': n.id } })}
    ${button({ label: 'Delete', icon: 'trash', variant: 'ghost', size: 'sm', action: 'delete', ariaLabel: `Delete notification: ${n.title}`, attrs: { 'data-id': n.id } })}
  </div></article>`;

export default {
  styles: [new URL('./notifications.css', import.meta.url).href],

  mount(ctx) {
    let status = 'all';
    let category = '';
    let page = 1;
    let requestId = 0;

    render(ctx.outlet, html`
      ${pageHeader({ title: 'Notifications', subtitle: 'Alerts about your budgets, goals, subscriptions, recurring transactions and spending. Stored in your account and shown here and in the bell. An e-mail copy is optional and only available when the server has e-mail set up. No SMS.', actions: button({ label: 'Mark all read', icon: 'check-double', variant: 'secondary', action: 'read-all' }) })}
      <div class="grid gap-6">
        <div class="nc-toolbar"><div id="nc-status"></div><div id="nc-cats"></div></div>
        <div id="nc-body" aria-live="polite"></div>
        <div id="nc-prefs"></div>
      </div>`);
    const body = $('#nc-body', ctx.outlet);

    const drawFilters = (data) => {
      const by = data ? data.unreadByCategory : {};
      render($('#nc-status', ctx.outlet), chipGroup({ name: 'status', label: 'Read status', value: status, items: [
        { value: 'all', label: 'All' }, { value: 'unread', label: `Unread${data ? ` (${data.unreadCount})` : ''}` }, { value: 'read', label: 'Read' }] }));
      render($('#nc-cats', ctx.outlet), chipGroup({ name: 'category', label: 'Category', value: category, items: [
        { value: '', label: 'All categories' }, ...CATEGORIES.map(([v, label]) => ({ value: v, label: by[v] ? `${label} (${by[v]})` : label }))] }));
    };

    function draw(data) {
      drawFilters(data);
      $('[data-action="read-all"]', ctx.outlet).disabled = !data.unreadCount;
      if (!data.notifications.length) {
        const filtered = status !== 'all' || category;
        render(body, card({ body: emptyState({ icon: 'bell', title: filtered ? 'Nothing matches these filters' : 'No notifications yet', text: filtered ? 'Try another status or category.' : 'Budget limits, goal milestones, subscription renewals and unusual spending will show up here.' }) }));
        return;
      }
      render(body, html`<div class="nc-list" role="list">${data.notifications.map(item)}</div>${pagination({ page: data.pagination.page, totalPages: data.pagination.totalPages, total: data.pagination.total, limit: LIMIT, noun: 'notifications' })}`);
    }

    async function load() {
      const mine = ++requestId;
      body.setAttribute('aria-busy', 'true');
      if (!body.children.length) render(body, skeletonRows(4, 72));
      try {
        const data = await ctx.alive(getNotifications({ status, category, page, limit: LIMIT }));
        if (mine !== requestId) return;
        if (!data.notifications.length && page > 1 && data.pagination.totalPages >= 1) { page = data.pagination.totalPages; load(); return; }
        draw(data);
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('notifications', err);
        render(body, card({ body: errorState({ error: err, title: 'Could not load notifications' }) }));
      } finally { if (mine === requestId) body.removeAttribute('aria-busy'); }
    }
    const changed = () => { emit('notifications:changed'); load(); };
    const act = (fn, okMsg) => async (e, el) => {
      try { await fn(el.dataset.id); if (okMsg) toast(okMsg, 'success'); changed(); } catch (err) { toastError(err); }
    };

    ctx.on(ctx.outlet, 'click', '[data-chip="status"]', (e, el) => { status = el.dataset.value; page = 1; load(); });
    ctx.on(ctx.outlet, 'click', '[data-chip="category"]', (e, el) => { category = el.dataset.value; page = 1; load(); });
    ctx.on(body, 'click', '[data-action="retry"]', () => load());
    ctx.on(body, 'click', '[data-action="read"]', act(markRead));
    ctx.on(body, 'click', '[data-action="unread"]', act(markUnread));
    ctx.on(body, 'click', '[data-action="delete"]', act(deleteNotification, 'Notification deleted.'));
    ctx.on(body, 'click', '[data-open]', (e, el) => {
      e.preventDefault();
      const target = el.getAttribute('href').slice(1);
      markRead(el.dataset.open).catch(() => {}).finally(() => { emit('notifications:changed'); navigate(target); });
    });
    ctx.on(ctx.outlet, 'click', '[data-action="read-all"]', async () => {
      try {
        const r = await markAllRead(category);
        toast(r && r.data && r.data.updated ? `Marked ${r.data.updated} as read.` : 'Nothing to mark.', 'success');
        changed();
      } catch (err) { toastError(err); }
    });
    bindPagination(body, (p) => { page = p; load(); }, { signal: ctx.signal });

    // ----- preferences -----
    const prefsBox = $('#nc-prefs', ctx.outlet);
    async function loadPrefs() {
      try {
        const p = await ctx.alive(getPreferences());
        render(prefsBox, card({
          title: 'Notification preferences',
          subtitle: 'Choose which kinds of notifications are created. A category that is switched off stores nothing.',
          body: html`<div class="nc-prefs">${CATEGORIES.map(([v, label, ic, key]) => html`<label class="nc-pref"><input type="checkbox" class="switch" role="switch" data-pref="${key}" ${p[key] ? 'checked' : ''}>${icon(ic)}<span>${label}</span></label>`)}</div>
            <div class="flex flex-wrap items-center gap-3" style="margin-top:16px"><label class="text-sm font-semibold" for="nc-days">Remind me about subscription renewals</label>
              <input class="input" id="nc-days" type="number" min="0" max="60" step="1" value="${p.renewalReminderDays}" style="width:90px"><span class="card-sub">days before (0 = only on the day). A subscription can set its own.</span></div>
            <div style="margin-top:18px;padding-top:14px;border-top:1px solid rgb(var(--line))"><h3 class="text-sm font-bold" style="margin:0 0 6px">E-mail</h3>${p.email.available
    ? html`<label class="nc-pref" style="max-width:520px"><input type="checkbox" class="switch" role="switch" data-pref="emailEnabled" ${p.emailEnabled ? 'checked' : ''}>${icon('envelope')}<span>Also e-mail me a copy of notifications (to ${p.email.address})</span></label>
        <div class="flex flex-wrap items-center gap-3" style="margin-top:10px">${button({ label: 'Send a test e-mail', icon: 'paper-plane', variant: 'secondary', size: 'sm', action: 'test-email' })}<span class="card-sub">Only categories switched on above are e-mailed, at most ${p.email.hourlyCap} per hour. “E-mail sent” means the mail server accepted the message; it cannot guarantee inbox delivery.</span></div>`
    : html`<p class="card-sub">E-mail delivery is not set up on this server, so notifications are shown in the app only. (An administrator can enable it with SMTP settings.)</p>`}</div>`,
        }));
      } catch (err) {
        if (err instanceof StaleError) return;
        logError('notification-prefs', err);
        render(prefsBox, card({ body: errorState({ error: err, title: 'Could not load preferences' }) }));
      }
    }
    ctx.on(prefsBox, 'change', '[data-pref]', async (e, el) => {
      try { await savePreferences({ [el.dataset.pref]: el.checked }); toast('Preferences saved.', 'success'); } catch (err) { el.checked = !el.checked; toastError(err); }
    });
    ctx.on(prefsBox, 'change', '#nc-days', async (e, el) => {
      const v = Number(el.value);
      if (el.value === '' || !Number.isInteger(v) || v < 0 || v > 60) { toast('Enter a whole number of days between 0 and 60.', 'error'); loadPrefs(); return; }
      try { await savePreferences({ renewalReminderDays: v }); toast('Reminder timing saved.', 'success'); } catch (err) { toastError(err); loadPrefs(); }
    });
    ctx.on(prefsBox, 'click', '[data-action="test-email"]', async (e, el) => {
      el.disabled = true;
      try { const r = await sendTestEmail(); toast(`Test e-mail handed to the mail server for ${r.to}.`, 'success'); } catch (err) { toastError(err); } finally { el.disabled = false; }
    });
    ctx.on(prefsBox, 'click', '[data-action="retry"]', () => loadPrefs());

    drawFilters(null);
    load();
    loadPrefs();
  },
};
