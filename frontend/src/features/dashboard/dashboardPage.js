import { html, render, $, fmt, fmt2, money } from '../../core/dom.js';
import { getStoredUser } from '../../core/session.js';
import { pageHeader, select, badge, progressBar, statCard, cardLink, icon } from '../../components/ui.js';
import { emptyState } from '../../components/states.js';
import { skeletonBlock, skeletonRows } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { createChart, chartBox, palette, CHART_COLORS, moneyAxis } from '../../components/chartContainer.js';
import { getDashboardOverview } from './dashboardService.js';
import { loadAlerts, renderAlerts } from './alertsWidget.js';
import { getBudgetSummary } from '../budgets/budgetService.js';
import { listGoals } from '../savings-goals/goalService.js';
import { getInsights } from '../insights/insightService.js';
import { getHealthScore } from '../health-score/healthScoreService.js';
import { INSIGHT_STYLE, INSIGHT_ORDER } from '../insights/insightStyles.js';
import { tierOf, TIERS } from '../budgets/budgetTiers.js';
import { GOAL_STATUS } from '../savings-goals/goalStatus.js';

// The dashboard is an OVERVIEW: compact previews, each linking to its dedicated page. Every widget loads on its own, so a
// failing widget (or chart) shows a local error with Retry while the others keep working.

const PERIODS = [['month', 'This month'], ['last_month', 'Last month'], ['year', 'This year']];

const wcard = ({ title, subtitle, link, linkText, body }) => html`<section class="card card-pad">
  <header class="card-head"><div><h2 class="card-title">${title}</h2>${subtitle ? html`<p class="card-sub">${subtitle}</p>` : ''}</div>${link ? cardLink(link, linkText) : ''}</header>${body}</section>`;

const pct = (now, prev) => (prev > 0 ? Math.round(((now - prev) / prev) * 1000) / 10 : null);
const trendBadge = (value, goodWhenUp) => {
  if (value === null) return '';
  const up = value >= 0;
  const good = goodWhenUp ? up : !up;
  return html`<span class="db-delta ${good ? 'text-income' : 'text-expense'}">${icon(up ? 'arrow-trend-up' : 'arrow-trend-down')}${up ? '+' : ''}${value}% <span class="card-sub" style="font-weight:500">vs last month</span></span>`;
};

export default {
  styles: [new URL('./dashboard.css', import.meta.url).href],

  mount(ctx) {
    const user = getStoredUser() || {};
    const first = (user.name || '').split(' ')[0];
    let period = 'month';
    let trendChart = null;
    let catChart = null;

    render(ctx.outlet, html`
      ${pageHeader({ title: first ? `Welcome back, ${first}` : 'Dashboard', subtitle: 'A quick look at your money. Open any section for the full picture.',
        actions: select({ id: 'db-period', options: PERIODS, value: period, attrs: { 'aria-label': 'Dashboard period' } }) })}
      <div class="grid gap-4">
        <div id="db-alerts" hidden></div>
        <div id="db-stats"></div>
        <div class="db-row-2"><div class="db-widget" id="db-trend"></div><div class="db-widget" id="db-cats"></div></div>
        <div class="db-row-3"><div class="db-widget" id="db-recent"></div><div class="db-widget" id="db-budgets"></div></div>
        <div class="db-row-4"><div class="db-widget" id="db-goals"></div><div class="db-widget" id="db-insights"></div><div class="db-widget" id="db-health"></div></div>
      </div>`);
    const slot = (id) => $(`#${id}`, ctx.outlet);
    const overview = () => getDashboardOverview(period); // shared in-flight request across the 4 widgets below

    // alerts are independent of the period and fail silently (the strip simply stays hidden): a notification problem must not disturb the dashboard
    loadAlerts().then((d) => { if (ctx.isActive()) renderAlerts(d, slot('db-alerts')); }).catch(() => {});

    const periodWidgets = [
      mountWidget(ctx, slot('db-stats'), {
        title: 'Summary', skeleton: html`<div class="db-stats">${[0, 1, 2, 3].map(() => skeletonBlock(96))}</div>`, load: overview,
        render: (d, el) => {
          const s = d.summary; const m = d.monthlyIncomeExpense; const cur = m[m.length - 1]; const prev = m[m.length - 2];
          const showTrend = period === 'month' && cur && prev;
          render(el, html`<div class="db-stats">
            ${statCard({ label: 'Balance', value: money(s.balance), tone: s.balance < 0 ? 'text-expense' : '', sub: 'Income minus expenses' })}
            ${statCard({ label: 'Income', value: money(s.totalIncome), tone: 'text-income', sub: showTrend ? trendBadge(pct(cur.income, prev.income), true) : '' })}
            ${statCard({ label: 'Expenses', value: money(s.totalExpense), tone: 'text-expense', sub: showTrend ? trendBadge(pct(cur.expense, prev.expense), false) : '' })}
            ${statCard({ label: 'Savings rate', value: s.savingsRate === null || s.savingsRate === undefined ? 'N/A' : `${s.savingsRate}%`, sub: s.totalIncome > 0 ? 'Of income kept' : 'No income this period' })}
          </div>`);
        },
      }),
      mountWidget(ctx, slot('db-trend'), {
        title: 'Income vs expenses', skeleton: skeletonBlock(320), load: overview,
        render: (d, el) => {
          render(el, wcard({ title: 'Income vs expenses', subtitle: 'Last 6 months', link: '#/analytics', linkText: 'Analytics', body: chartBox({ id: 'db-trend-chart', height: 250, label: 'Line chart of income and expenses for the last six months' }) }));
          trendChart?.destroy();
          const p = palette(); const m = d.monthlyIncomeExpense;
          trendChart = createChart(ctx, $('#db-trend-chart', el), { type: 'line', data: { labels: m.map((x) => `${x.label} ${x.year}`), datasets: [
            { label: 'Income', data: m.map((x) => x.income), borderColor: p.income, backgroundColor: `${p.income}22`, fill: true, tension: 0.3, borderWidth: 2 },
            { label: 'Expenses', data: m.map((x) => x.expense), borderColor: p.expense, backgroundColor: `${p.expense}14`, fill: true, tension: 0.3, borderWidth: 2 }] },
          options: { plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ৳${fmt(c.parsed.y)}` } } }, scales: { y: { ticks: { callback: moneyAxis }, grid: { color: p.grid }, border: { display: false } }, x: { grid: { display: false } } } } });
        },
      }),
      mountWidget(ctx, slot('db-cats'), {
        title: 'Spending by category', skeleton: skeletonBlock(320), load: overview,
        render: (d, el) => {
          const cats = d.categoryExpenses;
          render(el, wcard({ title: 'Spending by category', subtitle: PERIODS.find((x) => x[0] === period)[1], link: '#/analytics', linkText: 'Details', body: cats.length
            ? html`${chartBox({ id: 'db-cat-chart', height: 170, label: 'Doughnut chart of spending by category' })}<div class="an-legend" style="display:grid;gap:8px;margin-top:12px;font-size:var(--text-xs)">${cats.slice(0, 5).map((c, i) => html`<div class="flex items-center justify-between gap-2"><span class="flex items-center gap-2" style="min-width:0"><span style="width:10px;height:10px;border-radius:50%;flex-shrink:0;background:${CHART_COLORS[i % CHART_COLORS.length]}"></span><span class="truncate-1">${c.category}</span></span><span class="card-sub tabular" style="font-weight:700">৳${fmt(c.amount)}</span></div>`)}</div>`
            : emptyState({ icon: 'chart-pie', title: 'No spending yet', text: 'Expenses you record will be broken down here.' }) }));
          catChart?.destroy(); catChart = null;
          if (cats.length) catChart = createChart(ctx, $('#db-cat-chart', el), { type: 'doughnut', data: { labels: cats.map((c) => c.category), datasets: [{ data: cats.map((c) => c.amount), backgroundColor: cats.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderWidth: 2, borderColor: palette().surface }] }, options: { cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ৳${fmt(c.parsed)}` } } } } });
        },
      }),
      mountWidget(ctx, slot('db-recent'), {
        title: 'Recent transactions', skeleton: skeletonRows(5, 48), load: overview,
        render: (d, el) => render(el, wcard({ title: 'Recent transactions', link: '#/transactions', linkText: 'View all', body: d.recentTransactions.length
          ? html`<ul class="db-list">${d.recentTransactions.map((t) => html`<li class="db-tx"><div class="db-tx-main"><span class="icon-chip" style="width:36px;height:36px;${t.type === 'INCOME' ? '' : 'background:rgb(var(--danger-soft));color:rgb(var(--expense))'}">${icon(t.type === 'INCOME' ? 'arrow-down' : 'arrow-up', 'text-xs')}</span>
              <div style="min-width:0"><p class="text-sm font-bold truncate-1">${t.description}</p><p class="card-sub">${t.category} · ${t.date}</p></div></div>
              <span class="tabular font-extrabold text-sm ${t.type === 'INCOME' ? 'text-income' : 'text-expense'}" style="flex-shrink:0">${t.type === 'INCOME' ? '+' : '-'}৳${fmt2(t.amount)}</span></li>`)}</ul>`
          : emptyState({ icon: 'receipt', title: 'No transactions yet', text: 'Add your first one to see it here.', actions: html`<a class="btn btn-primary btn-sm" href="#/transactions">Add a transaction</a>` }) })),
      }),
    ];

    // ----- widgets that do not depend on the selected period -----
    mountWidget(ctx, slot('db-budgets'), {
      title: 'Budgets', skeleton: skeletonBlock(250), load: getBudgetSummary,
      render: (s, el) => {
        const top = [...s.budgets].filter((b) => b.status === 'active').sort((a, b) => b.percentage - a.percentage).slice(0, 4);
        render(el, wcard({ title: 'Budgets', subtitle: 'Active budgets', link: '#/budgets', linkText: 'Manage', body: top.length
          ? html`<div class="grid gap-4"><div class="db-mini-bar"><div class="flex justify-between text-xs"><span style="font-weight:700">${money(s.totalSpent)} of ${money(s.totalLimit)}</span><span class="card-sub">${s.percentage}%</span></div>${progressBar({ value: Math.min(s.percentage, 100), tone: s.percentage > 100 ? 'danger' : s.percentage >= 90 ? 'warning' : '', label: 'Total budget used' })}</div>
            ${top.map((b) => { const t = TIERS[tierOf(b)]; return html`<div class="db-mini-bar"><div class="flex justify-between items-center gap-2 text-xs"><span style="font-weight:700">${b.category}</span>${badge(`${b.percentage}% · ${t.label}`, t.tone)}</div>${progressBar({ value: Math.min(b.percentage, 100), tone: t.bar, label: `${b.category} budget used` })}</div>`; })}</div>`
          : emptyState({ icon: 'bullseye', title: 'No active budgets', text: 'Set a spending limit to track it here.', actions: html`<a class="btn btn-secondary btn-sm" href="#/budgets">Create a budget</a>` }) }));
      },
    });

    mountWidget(ctx, slot('db-goals'), {
      title: 'Savings goals', skeleton: skeletonBlock(250), load: listGoals,
      render: (goals, el) => {
        const top = goals.filter((g) => g.status !== 'completed').sort((a, b) => b.progress - a.progress).slice(0, 3);
        render(el, wcard({ title: 'Savings goals', link: '#/savings-goals', linkText: 'All goals', body: goals.length
          ? html`<div class="grid gap-4">${top.length ? top.map((g) => { const st = GOAL_STATUS[g.status]; return html`<div class="db-mini-bar"><div class="flex justify-between items-center gap-2 text-xs"><span style="font-weight:700;min-width:0" class="truncate-1">${g.title}</span><span class="card-sub tabular" style="flex-shrink:0">${Math.round(g.progress)}%</span></div>${progressBar({ value: g.progress, tone: st.bar, label: `${g.title} progress` })}<div class="flex justify-between card-sub"><span>৳${fmt(g.savedAmount)} of ৳${fmt(g.targetAmount)}</span>${badge(st.label, st.tone)}</div></div>`; }) : html`<p class="card-sub">All your goals are completed. 🎉</p>`}</div>`
          : emptyState({ icon: 'piggy-bank', title: 'No goals yet', text: 'Create a goal and add money towards it.', actions: html`<a class="btn btn-secondary btn-sm" href="#/savings-goals">Create a goal</a>` }) }));
      },
    });

    mountWidget(ctx, slot('db-insights'), {
      title: 'Smart insights', skeleton: skeletonBlock(250), load: getInsights,
      render: (d, el) => {
        const top = d.sufficient ? [...d.insights].sort((a, b) => INSIGHT_ORDER[a.type] - INSIGHT_ORDER[b.type]).slice(0, 3) : [];
        render(el, wcard({ title: 'Smart insights', subtitle: 'Rule-based, from your data', link: '#/insights', linkText: 'All insights', body: top.length
          ? html`<div>${top.map((i) => { const st = INSIGHT_STYLE[i.type] || INSIGHT_STYLE.info; return html`<div class="db-insight">${badge(icon(st.icon), st.tone, '')}<div style="min-width:0"><p class="text-xs font-bold">${i.title}</p><p class="card-sub">${i.message}</p></div></div>`; })}</div>`
          : emptyState({ icon: 'lightbulb', title: 'No insights yet', text: d.message || 'Add a few more transactions to see insights.' }) }));
      },
    });

    mountWidget(ctx, slot('db-health'), {
      title: 'Financial health score', skeleton: skeletonBlock(250), load: getHealthScore,
      render: (h, el) => render(el, wcard({ title: 'Financial health', subtitle: 'Educational score, not advice', link: '#/health-score', linkText: 'Breakdown', body: h.available
        ? html`<div class="grid gap-3"><div class="db-score"><span class="db-score-num" style="color:rgb(var(--brand-text))">${h.score}</span><span class="card-sub">/ 100</span>${badge(h.level, h.score >= 60 ? 'success' : h.score >= 40 ? 'warning' : 'danger')}</div>
            ${progressBar({ value: h.score, tone: h.score >= 60 ? '' : h.score >= 40 ? 'warning' : 'danger', label: 'Financial health score' })}
            <p class="card-sub">Based on ${h.basedOn.componentsEvaluated} of ${h.basedOn.componentsTotal} components${h.partial ? '. The rest are left out, not counted as zero.' : '.'}</p></div>`
        : emptyState({ icon: 'heart-pulse', title: 'Score not available yet', text: 'It needs a bit more real data before a score can be calculated.' }) })),
    });

    ctx.on(ctx.outlet, 'change', '#db-period', (e, el) => { period = el.value; periodWidgets.forEach((reload) => reload()); });
  },
};
