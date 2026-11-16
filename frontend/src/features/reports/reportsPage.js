import { html, render, $, fmt, fmt2, money, isoToday, toIsoDate } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, select, input, button, card, icon, badge } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonBlock } from '../../components/skeleton.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { createChart, chartBox, palette, CHART_COLORS, moneyAxis } from '../../components/chartContainer.js';
import { getReport, exportReport, listSnapshots, saveSnapshot, getSnapshot, exportSnapshot, deleteSnapshot } from './reportService.js';

const PERIODS = [['this_month', 'Current month'], ['last_month', 'Previous month'], ['last_3_months', 'Last 3 months'], ['last_6_months', 'Last 6 months'], ['this_year', 'Current year'], ['custom', 'Custom range']];
const STATUS_TONE = { healthy: 'brand', warning: 'warning', critical: 'warning', over: 'danger' };

const delta = (c) => {
  if (!c.sufficient) return html`<span class="card-sub">No previous data to compare</span>`;
  if (c.direction === 'flat') return html`<span class="card-sub">No change vs previous</span>`;
  const txt = c.changePercent === null ? `${c.change > 0 ? '+' : '−'}৳${fmt(Math.abs(c.change))}` : `${c.change > 0 ? '+' : '−'}${Math.abs(c.changePercent)}%`;
  return html`<span class="${c.favourable ? 'text-income' : 'text-expense'}" style="font-weight:700">${txt}</span> <span class="card-sub">vs previous</span>`;
};
const stat = (label, value, sub, tone = '') => html`<div class="card card-pad stat"><div class="stat-label">${label}</div><div class="stat-value ${tone}">${value}</div><div class="text-xs">${sub}</div></div>`;
const compareLine = (c) => {
  if (!c.sufficient) return html`<li class="card-sub">${icon('circle-info')}<span>${c.message}</span></li>`;
  const ic = c.direction === 'up' ? 'arrow-trend-up' : c.direction === 'down' ? 'arrow-trend-down' : 'minus';
  return html`<li><span class="${c.favourable === null ? '' : c.favourable ? 'text-income' : 'text-expense'}">${icon(ic)}</span><span>${c.message}</span></li>`;
};
const txTable = (rows, empty) => (rows.length
  ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Description</th><th class="hidden sm:table-cell">Category</th><th class="num">Amount</th></tr></thead><tbody>${rows.map((t) => html`<tr><td class="tabular" style="white-space:nowrap">${t.date}</td><td style="overflow-wrap:anywhere">${t.description}</td><td class="hidden sm:table-cell card-sub">${t.category}</td><td class="num"><b>৳${fmt2(t.amount)}</b></td></tr>`)}</tbody></table></div>`
  : html`<p class="card-sub">${empty}</p>`);

export default {
  styles: [new URL('./reports.css', import.meta.url).href],

  mount(ctx) {
    const t = new Date();
    const state = { period: 'this_month', startDate: toIsoDate(new Date(t.getFullYear(), t.getMonth(), 1)), endDate: isoToday() };
    let snapshotId = null; // when set, the page shows that frozen snapshot instead of a live report
    let current = null;
    let requestId = 0;
    let charts = [];
    const destroyCharts = () => { charts.forEach((c) => c && c.destroy()); charts = []; };
    ctx.onCleanup(destroyCharts);

    render(ctx.outlet, html`
      ${pageHeader({
        title: 'Reports',
        subtitle: 'A complete financial report for any period: income, spending, savings, budgets, goals and subscriptions. Export it as PDF or CSV, or save a snapshot.',
        actions: html`<div class="rp-controls">
          ${select({ id: 'rp-period', label: 'Period', options: PERIODS, value: state.period })}
          <div class="rp-controls" id="rp-custom" hidden>
            ${input({ id: 'rp-start', label: 'From', type: 'date', value: state.startDate })}
            ${input({ id: 'rp-end', label: 'To', type: 'date', value: state.endDate })}
            ${button({ label: 'Apply', action: 'apply' })}
          </div></div>`,
      })}
      <p class="field-error" id="rp-error" role="alert" hidden></p>
      <div class="grid gap-6">
        <div id="rp-body" aria-live="polite"></div>
        <div id="rp-history"></div>
      </div>`);
    const body = $('#rp-body', ctx.outlet);

    const bar = (r) => html`<div class="rp-bar">
      <div class="rp-banner" data-kind="${r.type}" style="flex:1 1 360px">${r.type === 'snapshot'
    ? html`<span>${icon('lock')} <b>Saved snapshot.</b> ${r.meta.basis}</span>${button({ label: 'Back to live report', icon: 'rotate-left', variant: 'secondary', size: 'sm', action: 'live' })}`
    : html`<span>${icon('bolt')} <b>Live report.</b> ${r.meta.label}: ${r.meta.range.start} to ${r.meta.range.end}. Recalculated from your data every time you open it.</span>`}</div>
      <div class="rp-bar-actions">
        ${button({ label: 'Download PDF', icon: 'file-pdf', action: 'export', attrs: { 'data-kind': 'pdf' } })}
        ${button({ label: 'Download CSV', icon: 'file-csv', variant: 'secondary', action: 'export', attrs: { 'data-kind': 'csv' } })}
        ${r.type === 'snapshot' ? '' : button({ label: 'Save snapshot', icon: 'floppy-disk', variant: 'secondary', action: 'save' })}
      </div></div>`;

    function draw(r) {
      destroyCharts();
      current = r;
      if (!r.hasAnyTransactions && r.type !== 'snapshot') {
        render(body, card({ body: emptyState({ icon: 'file-lines', title: 'No report yet', text: 'Reports are built from your transactions. Add your first income or expense to generate one.', actions: html`<a class="btn btn-primary" href="#/transactions">Go to transactions</a>` }) }));
        return;
      }
      const s = r.summary; const prev = r.previousSummary; const neg = s.savings < 0;
      const sub = r.subscriptions; const cur = r.meta.currency;
      render(body, html`<div class="grid gap-6">
        ${bar(r)}
        ${r.hasData ? '' : card({ body: emptyState({ icon: 'calendar-xmark', title: 'No transactions in this period', text: `You have no transactions between ${r.meta.range.start} and ${r.meta.range.end}. Try another period.` }) })}
        <div class="rp-stats">
          ${stat('Income', money(s.income), delta(r.comparison.income), 'text-income')}
          ${stat('Expenses', money(s.expense), delta(r.comparison.expense), 'text-expense')}
          ${stat('Savings', money(s.savings), neg ? html`<span class="text-expense" style="font-weight:700">You spent more than you earned</span>` : delta(r.comparison.savings), neg ? 'text-expense' : '')}
          ${stat('Savings rate', s.savingsRate === null ? 'N/A' : `${s.savingsRate}%`, s.savingsRate === null ? html`<span class="card-sub">No income in this period</span>` : (prev && prev.savingsRate !== null ? html`<span class="card-sub">Previous: ${prev.savingsRate}%</span>` : html`<span class="card-sub">No previous data</span>`))}
        </div>
        <p class="card-sub">${s.transactionCount} ${s.transactionCount === 1 ? 'transaction' : 'transactions'} (${s.incomeCount} income, ${s.expenseCount} expense) · average daily expense ৳${fmt2(s.averageDailyExpense)} · currency ${cur}</p>
        ${r.hasData ? html`
        <div class="rp-split">
          ${card({ title: 'Compared with the previous period', subtitle: `Previous: ${r.meta.previousRange.start} to ${r.meta.previousRange.end}`, body: html`<ul class="rp-list">${[r.comparison.income, r.comparison.expense, r.comparison.savings].map(compareLine)}</ul>${r.comparison.available ? '' : html`<p class="card-sub" style="margin-top:8px">${r.comparison.message}</p>`}` })}
          ${card({ title: 'Top spending categories', body: r.expenseCategories.length ? html`<div class="grid gap-3">${r.expenseCategories.slice(0, 5).map((c, i) => html`<div><div class="flex justify-between text-xs"><span style="font-weight:700">${i + 1}. ${c.category}</span><span class="card-sub tabular">৳${fmt(c.amount)} · ${c.percentage}%</span></div><div class="progress" style="margin-top:6px"><span style="width:${c.percentage}%;background:${CHART_COLORS[i % CHART_COLORS.length]}"></span></div></div>`)}</div>` : html`<p class="card-sub">No expenses in this period.</p>` })}
        </div>
        <div class="rp-charts">
          ${card({ title: r.trend.granularity === 'month' ? 'Income vs expenses by month' : 'Income vs expenses by day', body: chartBox({ id: 'rp-ch-trend', height: 260, label: 'Bar chart comparing income and expenses over the report period' }) })}
          ${card({ title: 'Expense breakdown', body: r.expenseCategories.length ? html`${chartBox({ id: 'rp-ch-cat', height: 200, label: 'Doughnut chart of expenses by category' })}<div class="rp-legend">${r.expenseCategories.map((c, i) => html`<div class="rp-legend-row"><span class="flex items-center" style="min-width:0"><span class="rp-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span><span class="truncate-1">${c.category}</span></span><span class="card-sub tabular" style="font-weight:700;flex-shrink:0">৳${fmt(c.amount)} (${c.percentage}%)</span></div>`)}</div>` : html`<p class="card-sub">No expenses in this period.</p>` })}
        </div>
        <div class="rp-two">
          ${card({ title: 'Largest expenses', body: txTable(r.topExpenses, 'No expenses in this period.') })}
          ${card({ title: 'Largest income', body: txTable(r.topIncome, 'No income in this period.') })}
        </div>` : ''}
        ${card({ title: 'Budget performance', subtitle: 'Each budget is judged over its own dates', body: r.budgets.items.length
    ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Category</th><th class="num">Limit</th><th class="num">Spent</th><th class="num">Used</th><th>Status</th><th class="hidden md:table-cell">Dates</th></tr></thead><tbody>${r.budgets.items.map((b) => html`<tr><td><b>${b.category}</b>${b.inTotals ? '' : html` <span class="card-sub" title="Began before this period; not in the totals">*</span>`}</td><td class="num">৳${fmt2(b.limit)}</td><td class="num">৳${fmt2(b.spent)}</td><td class="num">${b.percentage}%</td><td>${badge(b.status === 'over' ? `Over by ৳${fmt2(b.overBy)}` : b.status, STATUS_TONE[b.status])}</td><td class="hidden md:table-cell card-sub tabular">${b.startDate} → ${b.endDate}</td></tr>`)}</tbody></table></div>
      <p class="card-sub" style="margin-top:8px">${r.budgets.summary.includedCount ? `Budgets starting in this period: ৳${fmt2(r.budgets.summary.totalSpent)} spent of ৳${fmt2(r.budgets.summary.totalLimit)} (${r.budgets.summary.percentage}%). ` : ''}${r.budgets.note}</p>`
    : html`<p class="card-sub">No budgets overlap this period.</p>` })}
        ${card({ title: 'Savings goals', subtitle: 'Progress as of today', body: r.goals.items.length
    ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Goal</th><th class="num">Saved</th><th class="num">Target</th><th class="num">Progress</th><th class="num hidden sm:table-cell">This period</th></tr></thead><tbody>${r.goals.items.map((g) => html`<tr><td><b>${g.title}</b> ${g.status === 'completed' ? badge('Completed', 'brand') : g.status === 'overdue' ? badge('Overdue', 'danger') : ''}</td><td class="num">৳${fmt2(g.savedAmount)}</td><td class="num">৳${fmt2(g.targetAmount)}</td><td class="num">${g.percentage}%</td><td class="num hidden sm:table-cell">৳${fmt2(g.contributedInPeriod)}</td></tr>`)}</tbody></table></div><p class="card-sub" style="margin-top:8px">${r.goals.note}</p>`
    : html`<p class="card-sub">No savings goals yet.</p>` })}
        ${card({ title: 'Subscriptions', subtitle: 'Estimated cost vs actual payments', body: html`
          <div class="rp-est">
            <div class="tile"><div class="rp-tag text-warn">Estimate</div><div class="stat-value">৳${fmt2(sub.estimated.monthly)}<span class="card-sub"> / month</span></div><div class="card-sub">≈ ৳${fmt2(sub.estimated.yearly)} per year · ${sub.counts.active} active</div></div>
            <div class="tile"><div class="rp-tag text-income">Actual</div><div class="stat-value">৳${fmt2(sub.actual.inPeriod)}</div><div class="card-sub">${sub.actual.paymentCount} confirmed ${sub.actual.paymentCount === 1 ? 'payment' : 'payments'} in this period</div></div>
          </div>
          <p class="card-sub" style="margin-top:10px">${sub.note}</p>` })}
      </div>`);

      if (!r.hasData) return;
      const p = palette();
      const labels = r.trend.points.map((x) => x.label);
      const tip = { callbacks: { label: (c) => ` ${c.dataset.label || c.label}: ৳${fmt(c.parsed.y ?? c.parsed)}` } };
      charts.push(createChart(ctx, $('#rp-ch-trend', body), { type: 'bar', data: { labels, datasets: [{ label: 'Income', data: r.trend.points.map((x) => x.income), backgroundColor: p.income, borderRadius: 4 }, { label: 'Expenses', data: r.trend.points.map((x) => x.expense), backgroundColor: p.expense, borderRadius: 4 }] }, options: { plugins: { legend: { position: 'top' }, tooltip: tip }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { grid: { color: p.grid }, ticks: { callback: moneyAxis } } } } }));
      if (r.expenseCategories.length) {
        charts.push(createChart(ctx, $('#rp-ch-cat', body), { type: 'doughnut', data: { labels: r.expenseCategories.map((c) => c.category), datasets: [{ data: r.expenseCategories.map((c) => c.amount), backgroundColor: r.expenseCategories.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderWidth: 2, borderColor: palette().surface }] }, options: { cutout: '65%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ৳${fmt(c.parsed)}` } } } } }));
      }
    }

    async function load() {
      const errBox = $('#rp-error', ctx.outlet);
      errBox.hidden = true;
      if (!snapshotId && state.period === 'custom') {
        if (!state.startDate || !state.endDate) { errBox.hidden = false; errBox.textContent = 'Pick a start and an end date, then press Apply.'; return; }
        if (state.endDate < state.startDate) { errBox.hidden = false; errBox.textContent = 'The end date must be on or after the start date.'; return; }
      }
      const mine = ++requestId;
      body.setAttribute('aria-busy', 'true');
      if (!body.querySelector('canvas')) render(body, html`<div class="grid gap-4">${skeletonBlock(60)}${skeletonBlock(96)}${skeletonBlock(300)}</div>`); else body.style.opacity = '0.6';
      try {
        const data = await ctx.alive(snapshotId ? getSnapshot(snapshotId) : getReport(state));
        if (mine !== requestId) return;
        body.style.opacity = '';
        draw(data);
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('reports', err);
        body.style.opacity = '';
        destroyCharts(); current = null;
        render(body, card({ body: errorState({ error: err, title: 'Could not load the report' }) }));
      } finally { if (mine === requestId) body.removeAttribute('aria-busy'); }
    }

    // ----- saved reports (history) -----
    const hist = $('#rp-history', ctx.outlet);
    async function loadHistory() {
      try {
        const rows = await ctx.alive(listSnapshots());
        render(hist, card({
          title: 'Saved reports', subtitle: 'Frozen snapshots: their numbers never change, even if you edit transactions later.',
          body: rows.length ? html`<div class="rp-history">${rows.map((x) => html`<div class="rp-hist-item" data-snap="${x.id}">
            <div class="rp-hist-main"><div class="text-sm font-bold truncate-1">${x.title}</div><div class="card-sub">${x.startDate} to ${x.endDate} · saved ${String(x.generatedAt).slice(0, 10)}${x.summary ? ` · income ৳${fmt(x.summary.income)}, expenses ৳${fmt(x.summary.expense)}` : ''}</div></div>
            <div class="flex flex-wrap gap-2">${button({ label: 'Open', icon: 'eye', variant: 'secondary', size: 'sm', action: 'open-snap', attrs: { 'data-id': x.id } })}${button({ label: 'PDF', icon: 'file-pdf', variant: 'ghost', size: 'sm', action: 'snap-export', attrs: { 'data-id': x.id, 'data-kind': 'pdf' } })}${button({ label: 'CSV', icon: 'file-csv', variant: 'ghost', size: 'sm', action: 'snap-export', attrs: { 'data-id': x.id, 'data-kind': 'csv' } })}${button({ label: 'Delete', icon: 'trash', variant: 'ghost', size: 'sm', action: 'snap-delete', ariaLabel: `Delete saved report ${x.title}`, attrs: { 'data-id': x.id } })}</div></div>`)}</div>`
            : html`<p class="card-sub">Nothing saved yet. Use “Save snapshot” on a report to keep a frozen copy.</p>`,
        }));
      } catch (err) {
        if (err instanceof StaleError) return;
        logError('reports-history', err);
        render(hist, card({ body: errorState({ error: err, title: 'Could not load saved reports' }) }));
      }
    }

    // ----- events -----
    ctx.on(body, 'click', '[data-action="retry"]', () => load());
    ctx.on(hist, 'click', '[data-action="retry"]', () => loadHistory());
    ctx.on(ctx.outlet, 'change', '#rp-period', (e, el) => {
      snapshotId = null; state.period = el.value;
      $('#rp-custom', ctx.outlet).hidden = state.period !== 'custom';
      if (state.period === 'custom') { state.startDate = $('#rp-start', ctx.outlet).value; state.endDate = $('#rp-end', ctx.outlet).value; }
      load();
    });
    ctx.on(ctx.outlet, 'click', '[data-action="apply"]', () => { snapshotId = null; state.startDate = $('#rp-start', ctx.outlet).value; state.endDate = $('#rp-end', ctx.outlet).value; load(); });
    ctx.on(body, 'click', '[data-action="live"]', () => { snapshotId = null; load(); });

    const busy = async (el, fn) => {
      if (el.disabled) return;
      el.disabled = true;
      try { await fn(); } catch (err) { toastError(err); } finally { el.disabled = false; }
    };
    ctx.on(body, 'click', '[data-action="export"]', (e, el) => busy(el, async () => {
      const kind = el.dataset.kind;
      const r = await (snapshotId ? exportSnapshot(snapshotId, kind) : exportReport(state, kind));
      toast(`${kind.toUpperCase()} downloaded (${r.name}).`, 'success');
    }));
    ctx.on(body, 'click', '[data-action="save"]', (e, el) => busy(el, async () => {
      const r = await saveSnapshot(state);
      toast(r.duplicate ? 'An identical saved report already exists, so nothing new was saved.' : 'Report saved. Find it under “Saved reports”.', r.duplicate ? 'info' : 'success');
      emit('reports:changed');
      await loadHistory();
    }));
    ctx.on(hist, 'click', '[data-action="open-snap"]', (e, el) => { snapshotId = el.dataset.id; load(); body.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    ctx.on(hist, 'click', '[data-action="snap-export"]', (e, el) => busy(el, async () => {
      const r = await exportSnapshot(el.dataset.id, el.dataset.kind);
      toast(`${el.dataset.kind.toUpperCase()} downloaded (${r.name}).`, 'success');
    }));
    ctx.on(hist, 'click', '[data-action="snap-delete"]', async (e, el) => {
      const ok = await confirmDialog({ title: 'Delete saved report?', message: 'This removes the saved snapshot only. Your transactions and live reports are not affected.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await deleteSnapshot(el.dataset.id);
        toast('Saved report deleted.', 'success');
        if (snapshotId === el.dataset.id) { snapshotId = null; load(); }
        loadHistory();
      } catch (err) { toastError(err); }
    });

    load();
    loadHistory();
    void current;
  },
};
