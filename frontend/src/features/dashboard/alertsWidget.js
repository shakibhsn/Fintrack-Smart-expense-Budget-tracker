import { html } from '../../core/dom.js';
import { icon } from '../../components/ui.js';
import { getNotifications } from '../../services/notificationService.js';

// Dashboard "needs attention" strip: the most important UNREAD notifications (budgets, subscriptions, recurring failures, unusual spending).
// Real notifications only; when there is nothing to show the strip renders nothing at all, so the dashboard stays focused.
const IMPORTANT = new Set(['BUDGET', 'SUBSCRIPTIONS', 'RECURRING', 'UNUSUAL_SPENDING']);
const TONE = { BUDGET_EXCEEDED: 'danger', BUDGET_CRITICAL: 'warning', BUDGET_WARNING: 'warning' };

export const loadAlerts = () => getNotifications({ status: 'unread', limit: 20 }).then((d) => ({ total: d.unreadCount, items: d.notifications.filter((n) => IMPORTANT.has(n.category)).slice(0, 3) }));

export const renderAlerts = (d, el) => {
  if (!d.items.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = String(html`<section class="card card-pad" aria-label="Alerts that need attention" style="border-left:4px solid rgb(var(--warn, var(--brand)))">
    <div class="flex items-center justify-between gap-3" style="margin-bottom:6px"><h2 class="section-title">${icon('bell')} Needs your attention</h2><a class="card-link" href="#/notifications">All notifications${d.total > d.items.length ? ` (${d.total})` : ''}</a></div>
    <ul style="list-style:none;margin:0;padding:0;display:grid;gap:6px">${d.items.map((n) => html`<li class="text-sm" style="display:flex;gap:8px;align-items:flex-start"><span class="${TONE[n.type] === 'danger' ? 'text-expense' : 'text-warn'}" style="margin-top:2px">${icon('triangle-exclamation')}</span><span style="min-width:0;overflow-wrap:anywhere"><b>${n.title}</b><span class="card-sub"> ${n.link ? html`<a class="link db-alert-link" href="#${n.link}">View</a>` : ''}</span></span></li>`)}</ul>
  </section>`);
};
