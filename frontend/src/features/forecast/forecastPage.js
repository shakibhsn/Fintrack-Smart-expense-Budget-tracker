import { html, render, $, fmt, money } from '../../core/dom.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, chipGroup, badge, card, icon } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonBlock } from '../../components/skeleton.js';
import { createChart, chartBox, palette, CHART_COLORS, moneyAxis } from '../../components/chartContainer.js';
import { getForecast, PERIODS } from './forecastService.js';

// All forecasting maths lives in the backend. This page only displays it, always labelled as an ESTIMATE, with actual values
// as solid lines and estimates as dashed lines.
const RELIABILITY_TONE = { 'Sufficient Data': 'success', 'Moderate Data': 'warning', 'Limited Data': 'danger' };

const trendBadge = (t, goodWhenDown) => {
  if (!t || t.direction === 'unknown') return '';
  const ic = t.direction === 'up' ? 'arrow-trend-up' : t.direction === 'down' ? 'arrow-trend-down' : 'minus';
  const word = t.direction === 'stable' ? 'Stable' : t.direction === 'up' ? 'Rising' : 'Falling';
  const good = t.direction === 'stable' ? null : (goodWhenDown ? t.direction === 'down' : t.direction === 'up');
  return badge(html`${icon(ic)} ${word}${t.percent === null ? '' : ` ${t.percent > 0 ? '+' : ''}${t.percent}%`}`, good === null ? 'neutral' : good ? 'success' : 'danger');
};

// Actual months = solid line; estimate = dashed line starting from the last actual point (hidden from tooltips there).
function lineConfig(hist, proj, key, color, label) {
  const labels = [...hist.map((h) => h.label), ...proj.map((p) => p.label)];
  const last = hist.length - 1;
  const p = palette();
  return {
    type: 'line',
    data: { labels, datasets: [
      { label: `${label} (actual)`, data: [...hist.map((h) => h[key]), ...proj.map(() => null)], borderColor: color, backgroundColor: color, borderWidth: 2.5, tension: 0.25, pointRadius: 4, spanGaps: false },
      { label: `${label} (estimate)`, data: [...hist.map((h, i) => (i === last ? h[key] : null)), ...proj.map((x) => x[key])], borderColor: color, backgroundColor: 'transparent', borderDash: [7, 6], borderWidth: 2.5, tension: 0, pointRadius: 4, pointStyle: 'rectRot', spanGaps: false },
    ] },
    options: { plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { filter: (it) => !(it.datasetIndex === 1 && it.dataIndex === last), callbacks: { label: (c) => ` ${c.dataset.label}: ৳${fmt(c.parsed.y)}` } } },
      scales: { y: { ticks: { callback: moneyAxis }, grid: { color: p.grid }, border: { display: false } }, x: { grid: { display: false } } } },
  };
}

const forecastCard = (title, value, sub, tone = '', extra = '') => html`<div class="card card-pad stat"><div class="fc-card-top"><span class="stat-label">${title}</span><span class="fc-estimate-tag">ESTIMATE</span></div>
  <div class="stat-value ${tone}">${value}</div><div class="card-sub">${sub}</div>${extra ? html`<div>${extra}</div>` : ''}</div>`;
const range = (r) => `Typical range ${money(Math.round(r.low))} – ${money(Math.round(r.high))}`;

export default {
  styles: [new URL('./forecast.css', import.meta.url).href],

  mount(ctx) {
    let period = 'next_30_days';
    let data = null;
    let requestId = 0;
    let charts = [];
    const destroyCharts = () => { charts.forEach((c) => c && c.destroy()); charts = []; };
    ctx.onCleanup(destroyCharts);

    render(ctx.outlet, html`
      ${pageHeader({ title: 'Forecast', subtitle: 'Estimates of your future expenses, income and savings from your own past months (a weighted moving average, not machine learning). They are estimates, not guarantees.' })}
      <div class="grid gap-6"><div id="fc-tabs"></div><div id="fc-body" aria-live="polite"></div></div>`);
    const body = $('#fc-body', ctx.outlet);

    const drawTabs = () => {
      const avail = data ? data.availablePeriods : PERIODS.map(([id, label]) => ({ id, label, available: true }));
      render($('#fc-tabs', ctx.outlet), chipGroup({ name: 'period', label: 'Forecast period', value: period, items: avail.map((p) => ({ value: p.id, label: p.label, disabled: !p.available && p.id !== period, title: p.reason || '' })) }));
    };

    function draw(d) {
      destroyCharts(); drawTabs();
      if (!d.available) {
        const a = d.dataAvailability;
        render(body, card({ body: emptyState({ icon: 'chart-area', title: 'No forecast yet', text: d.message, actions: html`<p class="card-sub">${a.requirement} You currently have ${a.monthsOfHistory} complete ${a.monthsOfHistory === 1 ? 'month' : 'months'} and ${a.expenseTransactions} expense ${a.expenseTransactions === 1 ? 'transaction' : 'transactions'} in that window.</p>` }) }));
        return;
      }
      const m = d.monthly; const f = d.forecast; const rel = d.reliability; const cur = d.currentMonth;
      const cats = d.categories; const ok = cats.filter((c) => c.sufficient);
      render(body, html`<div class="grid gap-6">
        <div class="fc-summary"><div class="flex flex-wrap items-center justify-between gap-2"><span class="eyebrow" style="color:rgb(var(--brand-text))">Forecast summary · ${d.periodLabel} (estimated)</span>
            ${badge(html`${icon('database')} ${rel.label} · ${rel.monthsOfHistory} ${rel.monthsOfHistory === 1 ? 'month' : 'months'} of history`, RELIABILITY_TONE[rel.label] || 'neutral')}</div>
          <p class="text-sm">Estimated expenses: <b>${money(Math.round(f.expense))}</b> · estimated income: <b>${money(Math.round(f.income))}</b> · estimated savings: <b class="${f.isDeficit ? 'text-expense' : ''}">${f.isDeficit ? `deficit of ${money(Math.round(f.deficit))}` : money(Math.round(f.savings))}</b></p>
          <p class="card-sub">Expenses are most likely between ${money(Math.round(f.expenseRange.low))} and ${money(Math.round(f.expenseRange.high))}. ${d.method.description}</p></div>
        <div class="fc-cards">
          ${forecastCard('Predicted monthly expenses', money(Math.round(m.expense)), range(m.expenseRange), '', trendBadge(d.trend.expense, true))}
          ${forecastCard('Predicted monthly income', money(Math.round(m.income)), range(m.incomeRange), '', trendBadge(d.trend.income, false))}
          ${forecastCard('Predicted monthly savings', money(Math.round(m.savings)), m.isDeficit ? `Estimated deficit: expenses are predicted to exceed income by ${money(Math.round(m.deficit))}` : (m.savingsRatePercent === null ? 'No income in your history' : `About ${m.savingsRatePercent}% of predicted income`), m.isDeficit ? 'text-expense' : 'text-income')}
        </div>
        <div class="fc-charts">
          ${card({ title: 'Historical vs predicted spending', subtitle: 'Solid line = actual months. Dashed line = estimate.', body: chartBox({ id: 'fc-spend', height: 250, label: 'Line chart: actual monthly expenses as a solid line and estimated expenses as a dashed line' }) })}
          ${card({ title: 'Estimated savings trend', subtitle: 'Solid line = actual savings. Dashed line = estimate.', body: chartBox({ id: 'fc-savings', height: 250, label: 'Line chart: actual monthly savings as a solid line and estimated savings as a dashed line' }) })}
          ${card({ title: 'Expected spending by category', subtitle: 'Estimated per month. Categories without enough history are listed but not predicted.', body: ok.length ? chartBox({ id: 'fc-cat', height: 250, label: 'Bar chart of estimated monthly spending per category' }) : html`<p class="card-sub">No category has enough history to predict yet.</p>` })}
          ${card({ title: 'Category forecast', body: html`<div class="table-wrap"><table class="data-table fc-table"><thead><tr><th scope="col">Category</th><th scope="col" class="num">Per month</th><th scope="col" class="num hidden sm:table-cell">Share</th><th scope="col" class="num">Trend</th></tr></thead><tbody>
            ${cats.map((c, i) => c.sufficient
              ? html`<tr><td><span class="inline-block" style="width:10px;height:10px;border-radius:50%;margin-right:8px;background:${CHART_COLORS[i % CHART_COLORS.length]}"></span><b>${c.category}</b></td><td class="num"><b>${money(c.predictedMonthly)}</b></td><td class="num hidden sm:table-cell card-sub">${c.sharePercent === null ? '–' : `${c.sharePercent}%`}</td><td class="num">${trendBadge(c.trend, true)}</td></tr>`
              : html`<tr><td style="color:rgb(var(--mute))"><b>${c.category}</b></td><td colspan="3" class="card-sub">${c.message}</td></tr>`)}</tbody></table></div>` })}
        </div>
        <p class="card-sub">${cur ? `${cur.label} so far (actual, not part of the model): expenses ${money(cur.expense)}, income ${money(cur.income)}. ` : ''}Forecasts use only your own transactions and are recalculated whenever they change. They are estimates, not financial advice or guarantees.</p>
      </div>`);

      const p = palette();
      charts.push(createChart(ctx, $('#fc-spend', body), lineConfig(d.history, d.projection, 'expense', p.expense, 'Expenses')));
      charts.push(createChart(ctx, $('#fc-savings', body), lineConfig(d.history, d.projection, 'savings', p.savings, 'Savings')));
      if (ok.length) charts.push(createChart(ctx, $('#fc-cat', body), { type: 'bar', data: { labels: ok.map((c) => c.category), datasets: [{ label: 'Estimated per month', data: ok.map((c) => c.predictedMonthly), backgroundColor: ok.map((c) => CHART_COLORS[cats.indexOf(c) % CHART_COLORS.length]), borderRadius: 6 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` Estimate: ৳${fmt(c.parsed.x)}` } } }, scales: { x: { ticks: { callback: moneyAxis }, grid: { color: p.grid } }, y: { grid: { display: false } } } } }));
    }

    async function load() {
      const mine = ++requestId;
      if (!data) { drawTabs(); render(body, html`<div class="grid gap-4">${skeletonBlock(110)}${skeletonBlock(120)}${skeletonBlock(260)}</div>`); } else body.style.opacity = '0.6';
      try {
        const d = await ctx.alive(getForecast(period));
        if (mine !== requestId) return;
        data = d; body.style.opacity = ''; draw(d);
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('forecast', err);
        body.style.opacity = ''; data = null; destroyCharts();
        render(body, card({ body: errorState({ error: err, title: 'Could not load the forecast' }) }));
      }
    }

    ctx.on(ctx.outlet, 'click', '[data-chip="period"]', (e, el) => { period = el.dataset.value; load(); });
    ctx.on(body, 'click', '[data-action="retry"]', () => load());
    load();
  },
};
