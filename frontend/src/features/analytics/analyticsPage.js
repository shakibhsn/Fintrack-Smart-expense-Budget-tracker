import { html, render, $, fmt, money, isoToday, toIsoDate } from '../../core/dom.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, select, input, button, card, icon } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonBlock } from '../../components/skeleton.js';
import { createChart, chartBox, palette, CHART_COLORS, moneyAxis } from '../../components/chartContainer.js';
import { getAnalyticsOverview } from './analyticsService.js';

const PERIODS = [['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months'], ['last_6_months', 'Last 6 months'], ['this_year', 'This year'], ['custom', 'Custom range']];

// Delta line under a summary card: change vs the previous equivalent period (or an honest "no previous data").
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
  const tone = c.favourable === null ? '' : c.favourable ? 'text-income' : 'text-expense';
  return html`<li><span class="${tone}">${icon(ic)}</span><span>${c.message}</span></li>`;
};

const legend = (rows) => html`<div class="an-legend">${rows.map((c, i) => html`<div class="an-legend-row">
  <span class="flex items-center gap-2" style="min-width:0"><span class="an-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span><span class="truncate-1">${c.category}</span></span>
  <span class="card-sub tabular" style="font-weight:700;flex-shrink:0">৳${fmt(c.amount)} (${c.percentage}%)</span></div>`)}</div>`;

export default {
  styles: [new URL('./analytics.css', import.meta.url).href],

  mount(ctx) {
    const state = { period: 'this_month', startDate: '', endDate: '' };
    let requestId = 0;
    const t = new Date();

    render(ctx.outlet, html`
      ${pageHeader({
        title: 'Analytics',
        subtitle: 'Understand your income, spending and savings for any period, compared with the one before it.',
        actions: html`<div class="an-controls">
          ${select({ id: 'an-period', label: 'Period', options: PERIODS, value: state.period })}
          <div class="an-controls" id="an-custom" hidden>
            ${input({ id: 'an-start', label: 'From', type: 'date', value: toIsoDate(new Date(t.getFullYear(), t.getMonth(), 1)) })}
            ${input({ id: 'an-end', label: 'To', type: 'date', value: isoToday() })}
            ${button({ label: 'Apply', action: 'apply' })}
          </div></div>`,
      })}
      <p class="field-error" id="an-custom-error" role="alert" hidden></p>
      <div id="an-body" aria-live="polite"></div>`);

    const body = $('#an-body', ctx.outlet);
    // charts of the previous render are destroyed here so a period change never leaks them
    let charts = [];
    const destroyCharts = () => { charts.forEach((c) => c && c.destroy()); charts = []; };
    ctx.onCleanup(destroyCharts);

    function draw(d) {
      destroyCharts();
      if (!d.hasAnyTransactions) {
        render(body, card({ body: emptyState({ icon: 'chart-simple', title: 'No analytics yet', text: 'Analytics are built from your transactions. Add your first income or expense to see charts, trends and comparisons.', actions: html`<a class="btn btn-primary" href="#/transactions">Go to transactions</a>` }) }));
        return;
      }
      if (!d.hasData) {
        render(body, card({ body: emptyState({ icon: 'calendar-xmark', title: 'No transactions in this period', text: `You have no transactions between ${d.range.start} and ${d.range.end}. Try another period.` }) }));
        return;
      }
      const s = d.summary; const prev = d.previousSummary;
      const savingsNeg = s.savings < 0;
      render(body, html`<div class="grid gap-6">
        <p class="card-sub">${d.label}: ${d.range.start} to ${d.range.end} · ${d.transactionCount} ${d.transactionCount === 1 ? 'transaction' : 'transactions'}</p>
        <div class="an-stats">
          ${stat('Income', money(s.income), delta(d.comparison.income), 'text-income')}
          ${stat('Expenses', money(s.expense), delta(d.comparison.expense), 'text-expense')}
          ${stat('Savings', money(s.savings), delta(d.comparison.savings), savingsNeg ? 'text-expense' : '')}
          ${stat('Savings rate', s.savingsRate === null ? 'N/A' : `${s.savingsRate}%`, s.savingsRate === null ? html`<span class="card-sub">No income in this period</span>` : (prev && prev.savingsRate !== null ? html`<span class="card-sub">Previous: ${prev.savingsRate}%</span>` : html`<span class="card-sub">No previous data</span>`))}
        </div>
        <div class="an-split">
          ${card({ title: 'Compared with the previous period', subtitle: `Previous: ${d.previousRange.start} to ${d.previousRange.end}`, body: html`<ul class="an-compare">${[d.comparison.income, d.comparison.expense, d.comparison.savings].map(compareLine)}${d.comparison.categories.map((c) => html`<li class="card-sub">${icon('tag')}<span style="color:rgb(var(--ink))">${c.message}</span></li>`)}</ul>` })}
          ${card({ title: 'Top spending categories', body: d.topCategories.length ? html`<div class="an-top">${d.topCategories.map((c, i) => html`<div><div class="flex justify-between text-xs"><span style="font-weight:700">${i + 1}. ${c.category}</span><span class="card-sub tabular">৳${fmt(c.amount)} · ${c.percentage}%</span></div>
            <div class="progress" style="margin-top:6px"><span style="width:${c.percentage}%;background:${CHART_COLORS[i % CHART_COLORS.length]}"></span></div></div>`)}</div>` : html`<p class="card-sub">No expenses in this period.</p>` })}
        </div>
        <div class="an-charts">
          <div class="span-2">${card({ title: 'Income vs expenses', body: chartBox({ id: 'ch-incexp', height: 280, label: 'Bar chart comparing income and expenses over the selected period' }) })}</div>
          ${card({ title: d.granularity === 'month' ? 'Monthly spending trend' : 'Daily spending trend', body: chartBox({ id: 'ch-trend', height: 240, label: 'Line chart of expenses over time' }) })}
          ${card({ title: 'Savings trend', subtitle: 'Income minus expenses', body: chartBox({ id: 'ch-savings', height: 240, label: 'Bar chart of savings over time' }) })}
          ${card({ title: 'Expense breakdown', body: d.expenseCategories.length ? html`${chartBox({ id: 'ch-cat', height: 220, label: 'Doughnut chart of expenses by category' })}${legend(d.expenseCategories)}` : html`<p class="card-sub">No expenses in this period.</p>` })}
          ${card({ title: 'Income distribution', body: d.incomeCategories.length ? html`${chartBox({ id: 'ch-inc', height: 220, label: 'Doughnut chart of income by category' })}${legend(d.incomeCategories)}` : html`<p class="card-sub">No income in this period.</p>` })}
        </div></div>`);

      const p = palette();
      const labels = d.series.map((x) => x.label);
      const axes = { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { grid: { color: p.grid }, ticks: { callback: moneyAxis } } };
      const tip = { callbacks: { label: (c) => ` ${c.dataset.label || c.label}: ৳${fmt(c.parsed.y ?? c.parsed)}` } };
      const mk = (id, config) => charts.push(createChart(ctx, $(`#${id}`, body), config));
      mk('ch-incexp', { type: 'bar', data: { labels, datasets: [{ label: 'Income', data: d.series.map((x) => x.income), backgroundColor: p.income, borderRadius: 4 }, { label: 'Expenses', data: d.series.map((x) => x.expense), backgroundColor: p.expense, borderRadius: 4 }] }, options: { plugins: { legend: { position: 'top' }, tooltip: tip }, scales: axes } });
      mk('ch-trend', { type: 'line', data: { labels, datasets: [{ label: 'Expenses', data: d.series.map((x) => x.expense), borderColor: p.expense, backgroundColor: `${p.expense}22`, fill: true, tension: 0.3, borderWidth: 2, pointRadius: d.series.length > 40 ? 0 : 3 }] }, options: { plugins: { legend: { display: false }, tooltip: tip }, scales: axes } });
      mk('ch-savings', { type: 'bar', data: { labels, datasets: [{ label: 'Savings', data: d.series.map((x) => x.savings), backgroundColor: d.series.map((x) => (x.savings >= 0 ? p.savings : p.expense)), borderRadius: 4 }] }, options: { plugins: { legend: { display: false }, tooltip: tip }, scales: axes } });
      const donut = (id, rows) => rows.length && mk(id, { type: 'doughnut', data: { labels: rows.map((c) => c.category), datasets: [{ data: rows.map((c) => c.amount), backgroundColor: rows.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderWidth: 2, borderColor: palette().surface }] }, options: { cutout: '65%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ৳${fmt(c.parsed)}` } } } } });
      donut('ch-cat', d.expenseCategories); donut('ch-inc', d.incomeCategories);
    }

    async function load() {
      const customError = $('#an-custom-error', ctx.outlet);
      customError.hidden = true;
      if (state.period === 'custom') {
        if (!state.startDate || !state.endDate) { customError.hidden = false; customError.textContent = 'Pick a start and an end date, then press Apply.'; return; }
        if (state.endDate < state.startDate) { customError.hidden = false; customError.textContent = 'The end date must be on or after the start date.'; return; }
      }
      const mine = ++requestId;
      body.setAttribute('aria-busy', 'true');
      if (!body.querySelector('canvas')) render(body, html`<div class="grid gap-4">${skeletonBlock(96)}${skeletonBlock(300)}</div>`); else body.style.opacity = '0.6';
      try {
        const data = await ctx.alive(getAnalyticsOverview(state));
        if (mine !== requestId) return;
        body.style.opacity = '';
        draw(data);
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('analytics', err);
        body.style.opacity = '';
        destroyCharts();
        render(body, card({ body: errorState({ error: err, title: 'Could not load analytics' }) }));
      } finally {
        if (mine === requestId) body.removeAttribute('aria-busy');
      }
    }

    ctx.on(body, 'click', '[data-action="retry"]', () => load());
    ctx.on(ctx.outlet, 'change', '#an-period', (e, el) => {
      state.period = el.value;
      $('#an-custom', ctx.outlet).hidden = state.period !== 'custom';
      if (state.period === 'custom') { state.startDate = $('#an-start', ctx.outlet).value; state.endDate = $('#an-end', ctx.outlet).value; }
      load();
    });
    ctx.on(ctx.outlet, 'click', '[data-action="apply"]', () => { state.startDate = $('#an-start', ctx.outlet).value; state.endDate = $('#an-end', ctx.outlet).value; load(); });
    load();
  },
};
