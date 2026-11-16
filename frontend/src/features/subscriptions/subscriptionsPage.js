import { html, render, $, fmt } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, button, badge, card, chipGroup, statCard, icon } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonBlock, skeletonCards } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { createChart, chartBox, palette, CHART_COLORS, moneyAxis } from '../../components/chartContainer.js';
import { listSubscriptions, getSubscriptionSummary, pauseSubscription, resumeSubscription, cancelSubscription, deleteSubscription, frequencyLabel, moneyIn } from './subscriptionService.js';
import { openSubscriptionForm, openPaymentDialog, openDetailsDialog, statusBadge } from './subscriptionDialogs.js';

const FILTERS = [['upcoming', 'Upcoming'], ['active', 'Active'], ['paused', 'Paused'], ['cancelled', 'Cancelled'], ['expired', 'Expired'], ['all', 'All']];
const EST = html`<span class="sb-est">ESTIMATE</span>`;
const when = (d) => (d === null || d === undefined ? '–' : d < 0 ? `${-d} ${d === -1 ? 'day' : 'days'} ago` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`);

const subCard = (s) => html`<article class="card card-pad sb-card" data-sub="${s.id}" aria-label="${s.name}">
  <div class="sb-head"><div style="min-width:0"><h3 class="card-title truncate-1">${s.name}</h3><p class="card-sub truncate-1">${s.provider ? `${s.provider} · ` : ''}${s.category}</p></div>
    <div class="sb-price"><b>${moneyIn(s.amount, s.currency)}</b><div class="card-sub">${frequencyLabel(s)}</div></div></div>
  <div class="flex flex-wrap items-center gap-2">${statusBadge(s)}${s.isDue ? badge('Renewal date reached: confirm payment', 'warning') : ''}${s.autoRecord ? badge('Auto-records', 'brand') : ''}</div>
  <div class="sb-facts"><div class="tile"><div class="eyebrow">Next renewal</div><div class="v">${s.nextRenewalDate || '–'}</div></div><div class="tile"><div class="eyebrow">In</div><div class="v">${s.status === 'active' ? when(s.daysUntilRenewal) : '–'}</div></div><div class="tile"><div class="eyebrow">Est. / month</div><div class="v">${moneyIn(s.estimate.monthly, s.currency)}</div></div></div>
  <div class="sb-actions">
    ${button({ label: 'Details', icon: 'circle-info', variant: 'secondary', size: 'sm', action: 'details', attrs: { 'data-id': s.id } })}
    ${button({ label: 'Edit', icon: 'pen', variant: 'secondary', size: 'sm', action: 'edit', attrs: { 'data-id': s.id } })}
    ${s.status === 'active' && s.nextRenewalDate ? button({ label: 'Mark renewal paid', icon: 'check', variant: s.isDue ? 'primary' : 'secondary', size: 'sm', action: 'pay', attrs: { 'data-id': s.id } }) : ''}
    ${s.status === 'active' ? button({ label: 'Pause', icon: 'pause', variant: 'secondary', size: 'sm', action: 'pause', attrs: { 'data-id': s.id } }) : ''}
    ${s.status === 'paused' || s.status === 'cancelled' ? button({ label: 'Resume', icon: 'play', variant: 'secondary', size: 'sm', action: 'resume', attrs: { 'data-id': s.id } }) : ''}
    ${s.status === 'active' || s.status === 'paused' ? button({ label: 'Cancel', icon: 'ban', variant: 'secondary', size: 'sm', action: 'cancel', attrs: { 'data-id': s.id } }) : ''}
    ${button({ label: 'Delete', icon: 'trash-can', variant: 'danger', size: 'sm', action: 'delete', attrs: { 'data-id': s.id } })}
  </div></article>`;

export default {
  styles: [new URL('./subscriptions.css', import.meta.url).href],

  mount(ctx) {
    let items = [];
    let filter = 'active';
    let listReq = 0;
    let catChart = null; let payChart = null;

    render(ctx.outlet, html`
      ${pageHeader({ title: 'Subscriptions', subtitle: 'Services you pay for, with their renewal dates. Costs marked ESTIMATE are normalised from each billing cycle; ACTUAL payments are renewals you confirmed. A renewal date arriving never marks anything as paid.', actions: button({ label: 'Add subscription', icon: 'plus', action: 'add' }) })}
      <div class="grid gap-6">
        <div id="sb-summary"></div>
        <div class="sb-row"><div class="sb-widget" id="sb-upcoming"></div><div class="sb-widget" id="sb-cats"></div></div>
        <div class="sb-row-3"><div class="sb-widget" id="sb-top"></div><div class="sb-widget" id="sb-cancelled"></div><div class="sb-widget" id="sb-actual"></div></div>
        <section aria-labelledby="sb-list-title"><div class="card-head"><h2 class="card-title" id="sb-list-title">Your subscriptions</h2></div><div id="sb-filters" style="margin-bottom:16px"></div><div id="sb-list" aria-live="polite"></div></section>
      </div>`);
    const slot = (id) => $(`#${id}`, ctx.outlet);

    // ----- dashboard numbers: ONE request shared by all the summary widgets (apiClient de-duplicates it) -----
    const summary = () => getSubscriptionSummary(30);
    const reloaders = [
      mountWidget(ctx, slot('sb-summary'), { title: 'Subscription summary', skeleton: html`<div class="sb-stats">${[0, 1, 2, 3].map(() => skeletonBlock(96))}</div>`, load: summary,
        render: (d, el) => render(el, html`<div class="sb-stats">
          ${statCard({ label: 'Active subscriptions', value: d.counts.active, sub: `${d.counts.paused} paused · ${d.counts.cancelled} cancelled · ${d.counts.expired} expired` })}
          ${statCard({ label: html`Monthly cost ${EST}`, value: moneyIn(d.estimated.monthly, d.estimated.currency), sub: 'Active subscriptions, per month' })}
          ${statCard({ label: html`Yearly cost ${EST}`, value: moneyIn(d.estimated.yearly, d.estimated.currency), sub: 'Active subscriptions, per year' })}
          ${statCard({ label: 'Renewals in 30 days', value: Object.entries(d.upcoming.totals).map(([c, v]) => moneyIn(v, c)).join(' + ') || moneyIn(0, d.baseCurrency), sub: d.upcoming.dueNow ? `${d.upcoming.dueNow} due now: confirm payment` : `${d.upcoming.items.length} renewal${d.upcoming.items.length === 1 ? '' : 's'}`, tone: d.upcoming.dueNow ? 'text-warn' : '' })}
        </div>${d.estimated.otherCurrencies.length ? html`<p class="sb-note" style="margin-top:8px">Not included above (different currency, not converted): ${d.estimated.otherCurrencies.map((c) => `${moneyIn(c.monthly, c.currency)}/month`).join(', ')}.</p>` : ''}`) }),
      mountWidget(ctx, slot('sb-upcoming'), { title: 'Upcoming renewals', skeleton: skeletonBlock(260), load: summary,
        render: (d, el) => render(el, card({ title: 'Upcoming renewals', subtitle: 'Next 30 days. Not assumed paid until you confirm.', body: d.upcoming.items.length
          ? html`<ul class="sb-list">${d.upcoming.items.map((u) => html`<li class="sb-item"><div style="min-width:0"><p class="text-sm font-bold truncate-1">${u.name}</p><p class="card-sub">${u.renewalDate} · ${when(u.daysUntilRenewal)} · ${frequencyLabel(u)}</p></div>
              <div class="flex items-center gap-2" style="flex-shrink:0"><b class="tabular text-sm">${moneyIn(u.amount, u.currency)}</b>${u.isDue ? button({ label: 'Confirm', size: 'sm', action: 'pay', attrs: { 'data-id': u.id } }) : ''}</div></li>`)}</ul>`
          : emptyState({ icon: 'calendar-check', title: 'No renewals coming up', text: 'Active subscriptions renewing in the next 30 days appear here.' }) })) }),
      mountWidget(ctx, slot('sb-cats'), { title: 'Category breakdown', skeleton: skeletonBlock(260), load: summary,
        render: (d, el) => {
          const cats = d.categoryBreakdown;
          render(el, card({ title: html`Cost by category ${EST}`, subtitle: 'Monthly estimate', body: cats.length ? html`${chartBox({ id: 'sb-cat-chart', height: 170, label: 'Doughnut chart of estimated monthly subscription cost by category' })}<div class="sb-list" style="margin-top:10px">${cats.map((c, i) => html`<div class="flex justify-between items-center gap-2 text-xs"><span class="flex items-center gap-2" style="min-width:0"><span style="width:10px;height:10px;border-radius:50%;flex-shrink:0;background:${CHART_COLORS[i % CHART_COLORS.length]}"></span><span class="truncate-1">${c.category}</span></span><b class="tabular">${moneyIn(c.monthly, d.baseCurrency)} (${c.share}%)</b></div>`)}</div>` : emptyState({ icon: 'chart-pie', title: 'No active subscriptions', text: 'The category breakdown appears once you add one.' }) }));
          catChart?.destroy(); catChart = null;
          if (cats.length) catChart = createChart(ctx, $('#sb-cat-chart', el), { type: 'doughnut', data: { labels: cats.map((c) => c.category), datasets: [{ data: cats.map((c) => c.monthly), backgroundColor: cats.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderWidth: 2, borderColor: palette().surface }] }, options: { cutout: '65%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${moneyIn(c.parsed, d.baseCurrency)}/month (estimate)` } } } } });
        } }),
      mountWidget(ctx, slot('sb-top'), { title: 'Most expensive', skeleton: skeletonBlock(220), load: summary,
        render: (d, el) => render(el, card({ title: 'Most expensive', subtitle: 'By estimated monthly cost', body: d.topExpensive.length ? html`<ul class="sb-list">${d.topExpensive.map((t, i) => html`<li class="sb-item"><span class="text-sm font-bold truncate-1">${i + 1}. ${t.name}</span><span class="card-sub tabular" style="flex-shrink:0">${moneyIn(t.monthlyEstimate, d.baseCurrency)}/mo</span></li>`)}</ul>` : html`<p class="card-sub">Nothing to rank yet.</p>` })) }),
      mountWidget(ctx, slot('sb-cancelled'), { title: 'Recently cancelled', skeleton: skeletonBlock(220), load: summary,
        render: (d, el) => render(el, card({ title: 'Recently cancelled', subtitle: 'Last 90 days', body: d.recentlyCancelled.length ? html`<ul class="sb-list">${d.recentlyCancelled.map((c) => html`<li class="sb-item"><div style="min-width:0"><p class="text-sm font-bold truncate-1">${c.name}</p><p class="card-sub">Cancelled ${String(c.cancelledAt).slice(0, 10)}</p></div><span class="card-sub tabular" style="flex-shrink:0">${moneyIn(c.monthlyEstimate, c.currency)}/mo saved</span></li>`)}</ul>` : html`<p class="card-sub">No cancellations in the last 90 days.</p>` })) }),
      mountWidget(ctx, slot('sb-actual'), { title: 'Actual payments', skeleton: skeletonBlock(220), load: summary,
        render: (d, el) => {
          render(el, card({ title: html`Actual payments <span class="sb-est sb-act">ACTUAL</span>`, subtitle: 'Confirmed renewals, last 12 months', body: html`<p class="stat-value" style="font-size:var(--text-xl)">${moneyIn(d.actualPayments.last12Months, d.actualPayments.currency)}</p><p class="card-sub">${moneyIn(d.actualPayments.thisMonth, d.actualPayments.currency)} this month</p>${chartBox({ id: 'sb-pay-chart', height: 110, label: 'Bar chart of confirmed subscription payments per month' })}` }));
          payChart?.destroy();
          const p = palette(); const m = d.actualPayments.byMonth;
          payChart = createChart(ctx, $('#sb-pay-chart', el), { type: 'bar', data: { labels: m.map((x) => x.month.slice(5)), datasets: [{ label: 'Confirmed payments', data: m.map((x) => x.total), backgroundColor: p.income, borderRadius: 3 }] }, options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${moneyIn(c.parsed.y, d.actualPayments.currency)} (actual)` } } }, scales: { y: { display: false, beginAtZero: true }, x: { grid: { display: false }, ticks: { font: { size: 9 } } } } } });
        } }),
    ];

    // ----- the list with filters -----
    const drawFilters = () => render(slot('sb-filters'), chipGroup({ name: 'status', label: 'Filter subscriptions', value: filter, items: FILTERS.map(([value, label]) => ({ value, label })) }));
    async function loadList() {
      const mine = ++listReq; const box = slot('sb-list');
      drawFilters(); render(box, skeletonCards(2, 200, 'grid gap-4 sm:grid-cols-2'));
      try {
        const data = await ctx.alive(listSubscriptions(filter, 30));
        if (mine !== listReq) return;
        items = data;
        // an empty FILTER is different from having no subscriptions at all: a first-time user should see the "add your first" prompt
        const none = !items.length && (filter === 'all' || !(await ctx.alive(listSubscriptions('all', 30))).length);
        if (mine !== listReq) return;
        render(box, items.length ? html`<div class="sb-grid">${items.map(subCard)}</div>`
          : card({ body: emptyState({ icon: 'rotate', title: none ? 'No subscriptions yet' : `No ${filter} subscriptions`, text: none ? 'Add the services you pay for (streaming, software, cloud storage…) to see what they cost and when they renew.' : 'Try another filter.', actions: none ? button({ label: 'Add subscription', icon: 'plus', action: 'add' }) : '' }) }));
      } catch (err) {
        if (err instanceof StaleError || mine !== listReq) return;
        logError('subscriptions:list', err);
        render(box, card({ body: errorState({ error: err, title: 'Could not load subscriptions' }) }));
      }
    }
    const refreshAll = () => { emit('data:changed', { scope: 'subscriptions' }); emit('notifications:changed'); reloaders.forEach((r) => r()); loadList(); };
    ctx.on(ctx.outlet, 'click', '[data-chip="status"]', (e, el) => { filter = el.dataset.value; loadList(); });
    ctx.on(slot('sb-list'), 'click', '[data-action="retry"]', () => loadList());

    ctx.on(ctx.outlet, 'click', '[data-action]', async (e, el) => {
      const id = el.dataset.id; const a = el.dataset.action;
      if (a === 'retry') return;
      const find = async () => items.find((x) => x.id === id) || (await listSubscriptions('all', 30)).find((x) => x.id === id);
      try {
        if (a === 'add') openSubscriptionForm({ onSaved: refreshAll });
        else if (a === 'edit') openSubscriptionForm({ subscription: await find(), onSaved: refreshAll });
        else if (a === 'details') openDetailsDialog({ subscription: await find() });
        else if (a === 'pay') openPaymentDialog({ subscription: await find(), onDone: refreshAll });
        else if (a === 'pause') { await pauseSubscription(id); toast('Paused. No reminders or renewals until you resume it.', 'success'); refreshAll(); }
        else if (a === 'resume') { await resumeSubscription(id); toast('Resumed. Renewals missed meanwhile are not charged.', 'success'); refreshAll(); }
        else if (a === 'cancel') {
          const s = await find();
          if (!(await confirmDialog({ title: 'Mark as cancelled?', message: `“${s.name}” will stop counting towards your subscription costs and stop sending reminders. This only updates FinTrack; cancel the plan with the provider too. You can resume it later.`, confirmLabel: 'Mark as cancelled', danger: true }))) return;
          await cancelSubscription(id); toast('Marked as cancelled.', 'info'); refreshAll();
        } else if (a === 'delete') {
          const s = await find();
          if (!(await confirmDialog({ title: 'Delete subscription?', message: `“${s.name}” and its payment history will be deleted. Expenses it already recorded stay in your transactions. This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
          await deleteSubscription(id); toast('Subscription deleted.', 'info'); refreshAll();
        }
      } catch (err) { toastError(err); }
    });
    loadList();
  },
};
