import { html, render, $, fmt, fmt2 } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, chipGroup, badge, card, button, icon } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonRows } from '../../components/skeleton.js';
import { toast, toastError } from '../../components/toast.js';
import { getUnusualSpending, setDetectionStatus, getRelatedTransactions } from './anomalyService.js';

// Statistical comparisons with the user's OWN history. Never accusations: nothing is blocked, edited or deleted, and
// dismissing/reviewing only changes the finding itself.
const GROUPS = [
  ['LARGE_TRANSACTION', 'Unusual transactions', 'receipt'],
  ['CATEGORY_INCREASE', 'Unusual category spending', 'layer-group'],
  ['UNUSUAL_MONTH', 'Spending increases', 'calendar-days'],
  ['REPEATED_INCREASE', 'Spending pattern changes', 'arrow-trend-up'],
];

const details = (d) => {
  const x = d.details || {};
  const lines = [x.rule];
  if (x.median !== undefined) lines.push(`Median of your other ${d.category} transactions: ৳${fmt(x.median)} · usual upper limit: ৳${fmt(x.upperFence)} (${x.comparedWith}).`);
  if (x.baselinePeriods) lines.push(`Previous 30-day periods: ${x.baselinePeriods.map((v) => `৳${fmt(v)}`).join(', ')}.`);
  if (x.periods) lines.push(`30-day periods, oldest to newest: ${x.periods.map((v) => `৳${fmt(v)}`).join(' → ')}.`);
  if (x.priorMonths) lines.push(`Earlier months: ${x.priorMonths.map((p) => `${p.month} ৳${fmt(p.total)}`).join(', ')} (standard deviation ৳${fmt(x.standardDeviation)}).`);
  lines.push(`Compared period: ${d.windowStart}${d.windowEnd !== d.windowStart ? ` to ${d.windowEnd}` : ''}.`);
  return lines.filter(Boolean);
};

const detectionCard = (d) => {
  const pct = d.percentChange === null ? '' : ` (${d.percentChange > 0 ? '+' : ''}${d.percentChange}%)`;
  return html`<article class="card card-pad ud-card" data-detection="${d.id}">
    <div class="ud-head"><div class="text-sm font-bold">${d.category || 'All spending'} <span class="card-sub" style="font-weight:500;margin-left:6px">Detected ${String(d.detectedAt).slice(0, 10)}</span></div>${badge('UNUSUAL · NOT FRAUD', 'accent')}</div>
    <p class="text-sm">${d.explanation}</p>
    <div class="ud-nums">
      <div class="tile"><div class="eyebrow">Actual</div><div class="stat-value" style="font-size:var(--text-lg)">৳${fmt(d.actualAmount)}</div></div>
      <div class="tile"><div class="eyebrow">Usual</div><div class="stat-value" style="font-size:var(--text-lg)">৳${fmt(d.baselineAmount)}</div></div>
      <div class="tile"><div class="eyebrow">Difference</div><div class="stat-value text-warn" style="font-size:var(--text-lg)">+৳${fmt(d.difference)}${pct}</div></div>
    </div>
    <details class="ud-details"><summary>Details: how was this detected?</summary><div>${details(d).map((l) => html`<p>${l}</p>`)}</div></details>
    <div class="ud-actions">
      ${button({ label: 'Related transactions', icon: 'list', variant: 'secondary', size: 'sm', action: 'related', attrs: { 'data-id': d.id, 'aria-expanded': 'false', 'aria-controls': `rel-${d.id}` } })}
      ${d.status === 'NEW'
        ? html`${button({ label: 'Mark reviewed', icon: 'check', variant: 'secondary', size: 'sm', action: 'status', attrs: { 'data-id': d.id, 'data-status': 'REVIEWED' } })}${button({ label: 'Dismiss', icon: 'xmark', variant: 'secondary', size: 'sm', action: 'status', attrs: { 'data-id': d.id, 'data-status': 'DISMISSED' } })}`
        : html`<span class="card-sub" style="align-self:center;font-weight:700">${d.status === 'REVIEWED' ? 'Reviewed' : 'Dismissed'}</span>${button({ label: 'Restore', icon: 'rotate-left', variant: 'secondary', size: 'sm', action: 'status', attrs: { 'data-id': d.id, 'data-status': 'NEW' } })}`}
    </div>
    <div id="rel-${d.id}" hidden></div>
  </article>`;
};

export default {
  styles: [new URL('./anomaly.css', import.meta.url).href],

  mount(ctx) {
    let status = 'active';
    let requestId = 0;
    render(ctx.outlet, html`
      ${pageHeader({ title: 'Unusual Spending', subtitle: 'Places where your spending differs from your own usual pattern, found with fixed statistical rules. An unusual amount is not necessarily a problem, and nothing here blocks or changes your transactions.' })}
      <div class="grid gap-6"><div id="ud-tabs"></div><div id="ud-body" aria-live="polite"></div></div>`);
    const body = $('#ud-body', ctx.outlet);

    const drawTabs = (counts) => render($('#ud-tabs', ctx.outlet), chipGroup({ name: 'status', label: 'Detection status', value: status, items: [
      { value: 'active', label: `Active (${counts ? counts.new : 0})` }, { value: 'reviewed', label: `Reviewed (${counts ? counts.reviewed : 0})` }, { value: 'dismissed', label: `Dismissed (${counts ? counts.dismissed : 0})` }] }));

    function draw(d) {
      drawTabs(d.counts);
      let content = html`<p class="card-sub">${d.disclaimer}</p>`;
      if (!d.sufficient && status === 'active') {
        content = card({ body: emptyState({ icon: 'magnifying-glass-chart', title: 'Not enough history yet', text: d.message, actions: html`<p class="card-sub">${d.requirement} You have ${d.dataAvailability.expenseTransactions} expense ${d.dataAvailability.expenseTransactions === 1 ? 'transaction' : 'transactions'} over ${d.dataAvailability.historyDays} ${d.dataAvailability.historyDays === 1 ? 'day' : 'days'}.</p>` }) });
      } else if (!d.detections.length) {
        content = html`${content}${card({ body: emptyState({ icon: 'circle-check', title: status === 'active' ? 'All clear' : 'Nothing here', text: status === 'active' ? 'Nothing unusual found. Your recent spending is in line with your own history.' : `No ${status} detections.` }) })}`;
      } else {
        content = html`${content}<div class="ud-tiles">${GROUPS.map(([type, title, ic]) => html`<div class="card card-pad ud-tile"><span class="icon-chip">${icon(ic)}</span><div><div class="stat-value" style="font-size:var(--text-xl)">${d.detections.filter((x) => x.type === type).length}</div><div class="card-sub" style="font-weight:700">${title}</div></div></div>`)}</div>
          <div class="ud-groups">${GROUPS.map(([type, title, ic]) => { const items = d.detections.filter((x) => x.type === type); return items.length ? html`<section><h2 class="ud-group-title"><span class="text-income">${icon(ic)}</span>${title}</h2><div class="ud-list">${items.map(detectionCard)}</div></section>` : ''; })}</div>`;
      }
      render(body, html`<div class="grid gap-4">${content}</div>`);
    }

    async function load() {
      const mine = ++requestId;
      body.setAttribute('aria-busy', 'true');
      if (!body.children.length) render(body, skeletonRows(3, 120));
      try {
        const d = await ctx.alive(getUnusualSpending(status));
        if (mine === requestId) draw(d);
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('anomaly', err);
        render(body, card({ body: errorState({ error: err, title: 'Could not load unusual spending' }) }));
      } finally { if (mine === requestId) body.removeAttribute('aria-busy'); }
    }

    ctx.on(ctx.outlet, 'click', '[data-chip="status"]', (e, el) => { status = el.dataset.value; load(); });
    ctx.on(body, 'click', '[data-action="retry"]', () => load());
    ctx.on(body, 'click', '[data-action="status"]', async (e, el) => {
      try {
        await setDetectionStatus(el.dataset.id, el.dataset.status);
        toast(el.dataset.status === 'DISMISSED' ? 'Dismissed. Your transactions were not changed.' : el.dataset.status === 'REVIEWED' ? 'Marked as reviewed.' : 'Restored.', 'success');
        emit('data:changed', { scope: 'detections' });
        load();
      } catch (err) { toastError(err); }
    });
    ctx.on(body, 'click', '[data-action="related"]', async (e, el) => {
      const box = $(`#rel-${el.dataset.id}`, body);
      const open = box.hidden;
      box.hidden = !open; el.setAttribute('aria-expanded', String(open));
      if (!open) return;
      render(box, skeletonRows(2, 34));
      try {
        const rows = await ctx.alive(getRelatedTransactions(el.dataset.id));
        render(box, rows.length
          ? html`<div class="table-wrap"><table class="data-table"><tbody>${rows.map((t) => html`<tr><td class="tabular" style="color:rgb(var(--mute));white-space:nowrap">${t.date}</td><td>${t.description}</td><td class="hidden sm:table-cell card-sub">${t.category}</td><td class="num"><b>৳${fmt2(t.amount)}</b></td></tr>`)}</tbody></table></div>`
          : html`<p class="card-sub">The related transaction(s) no longer exist.</p>`);
      } catch (err) { if (!(err instanceof StaleError)) render(box, html`<p class="field-error">${err.message}</p>`); }
    });
    load();
  },
};
