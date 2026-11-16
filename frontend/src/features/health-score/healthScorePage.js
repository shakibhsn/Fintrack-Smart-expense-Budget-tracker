import { html, render, $ } from '../../core/dom.js';
import { pageHeader, badge, card, progressBar, icon } from '../../components/ui.js';
import { emptyState } from '../../components/states.js';
import { skeletonBlock } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { createChart, chartBox, palette } from '../../components/chartContainer.js';
import { getHealthScore } from './healthScoreService.js';

// Educational indicator, not financial advice. Components without enough data are shown as "not evaluated" and left out of
// BOTH sides of the score; missing data is never treated as poor performance.
const levelTone = (level) => ({ Excellent: 'success', Good: 'success', Fair: 'warning' }[level] || 'danger');

function gauge(score, level) {
  const r = 70; const c = 2 * Math.PI * r;
  const color = score >= 60 ? 'rgb(var(--brand-500))' : score >= 40 ? 'rgb(var(--warning))' : 'rgb(var(--danger))';
  return html`<div class="hs-gauge" role="img" aria-label="Financial health score ${score} out of 100, ${level}">
    <svg viewBox="0 0 168 168" aria-hidden="true"><circle class="track" cx="84" cy="84" r="${r}" fill="none" stroke-width="14"/>
      <circle class="value" cx="84" cy="84" r="${r}" fill="none" stroke-width="14" stroke="${color}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - score / 100)).toFixed(2)}"/></svg>
    <div class="hs-gauge-label"><span class="hs-gauge-num">${score}</span><span class="card-sub">out of 100</span></div></div>`;
}

const componentRow = (c) => c.eligible
  ? html`<div class="card card-pad hs-component"><div class="hs-component-head"><h3 class="card-title">${c.name}</h3><span class="font-extrabold tabular">${c.earned} / ${c.maxPoints}</span></div>
      ${progressBar({ value: c.earned, max: c.maxPoints, tone: c.earned / c.maxPoints >= 0.8 ? '' : c.earned / c.maxPoints > 0.5 ? 'warning' : 'danger', label: `${c.name} score` })}
      <p class="text-sm">${c.explanation}</p><p class="card-sub">${icon('lightbulb')} ${c.suggestion}</p></div>`
  : html`<div class="card card-pad hs-component" style="background:rgb(var(--surface-2) / 0.5)"><div class="hs-component-head"><h3 class="card-title">${c.name}</h3>${badge(`Not evaluated yet · ${c.maxPoints} pts not counted`)}</div>
      <p class="card-sub">${c.explanation}</p><p class="text-sm">${icon('unlock')} ${c.suggestion}</p></div>`;

const bullets = (items, empty) => items.length
  ? html`<ul class="hs-list">${items.map((i) => html`<li>${i.name ? html`<strong>${i.name}:</strong> ` : ''}${i.text}</li>`)}</ul>`
  : html`<p class="card-sub">${empty}</p>`;

export default {
  styles: [new URL('./health-score.css', import.meta.url).href],

  mount(ctx) {
    let chart = null;
    render(ctx.outlet, html`
      ${pageHeader({ title: 'Financial Health Score', subtitle: 'A transparent 0–100 score calculated from your own transactions, budgets and savings goals. It is an educational indicator, not financial advice.' })}
      <div id="hs-body"></div>`);

    mountWidget(ctx, $('#hs-body', ctx.outlet), {
      title: 'Health score',
      skeleton: html`<div class="grid gap-4">${skeletonBlock(210)}${skeletonBlock(300)}</div>`,
      load: getHealthScore,
      render: (d, el) => {
        chart?.destroy(); chart = null;
        const disclaimer = html`<p class="card-sub">${d.disclaimer}</p>`;
        if (!d.available) {
          render(el, html`<div class="grid gap-6">
            ${card({ body: emptyState({ icon: 'heart-pulse', title: d.message, text: d.requirement || '', actions: html`<a class="btn btn-primary" href="#/transactions">Add transactions</a>` }) })}
            ${card({ title: 'What the score needs', subtitle: 'Each part is measured only when you have the data for it. Nothing is scored as zero just because it is missing.', body: html`<div class="hs-components">${d.components.map(componentRow)}</div>` })}
            ${disclaimer}</div>`);
          return;
        }
        const names = Object.fromEntries(d.components.map((c) => [c.key, c.name]));
        render(el, html`<div class="grid gap-6">
          ${card({ body: html`<div class="hs-hero">${gauge(d.score, d.level)}<div class="hs-hero-text">
            <div class="flex items-center gap-3"><p class="stat-value" style="font-size:var(--text-2xl)">${d.level}</p>${badge(`${d.score} / 100`, levelTone(d.level))}</div>
            <p class="card-sub">Bands: 80–100 Excellent · 60–79 Good · 40–59 Fair · 0–39 Needs improvement</p>
            <p class="text-sm">${d.partial ? html`Based on <b>${d.basedOn.componentsEvaluated} of ${d.basedOn.componentsTotal}</b> components. Score = ${d.basedOn.earnedPoints} earned ÷ ${d.basedOn.evaluablePoints} measurable points × 100. Parts without enough data are left out, not counted as zero.` : html`Based on all ${d.basedOn.componentsTotal} components: ${d.basedOn.earnedPoints} of 100 points.`}</p>${disclaimer}</div></div>` })}
          ${card({ title: 'Score breakdown', body: html`<div class="hs-components">${d.components.map(componentRow)}</div>` })}
          <div class="hs-trio">
            ${card({ title: html`${icon('circle-check', 'text-income')} Strengths`, body: bullets(d.strengths, 'No standout strengths yet.') })}
            ${card({ title: html`${icon('arrow-trend-up', 'text-warn')} Areas to improve`, body: bullets(d.improvements, 'Nothing is scoring poorly right now.') })}
            ${card({ title: html`${icon('lightbulb')} Suggestions`, body: bullets(d.suggestions.map((s) => ({ name: names[s.key], text: s.text })), 'No suggestions right now.') })}
          </div>
          ${card({ title: 'Score history', body: d.history.length
            ? html`<p class="card-sub" style="margin-bottom:12px">Each point is the score recalculated from the data that existed at the end of that month. Months without enough data are not shown.</p>${chartBox({ id: 'hs-history', height: 230, label: 'Line chart of the financial health score over previous months' })}`
            : html`<p class="card-sub">${d.historyMessage || 'Not enough history to draw a trend yet.'}</p>` })}
        </div>`);
        if (d.history.length) {
          const p = palette();
          chart = createChart(ctx, $('#hs-history', el), { type: 'line', data: { labels: d.history.map((h) => h.label), datasets: [{ label: 'Score', data: d.history.map((h) => h.score), borderColor: p.income, backgroundColor: `${p.income}22`, fill: true, tension: 0.25, borderWidth: 2, pointRadius: 4 }] },
            options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => `${d.history[c.dataIndex].level} · ${d.history[c.dataIndex].componentsEvaluated} components` } } }, scales: { y: { min: 0, max: 100, grid: { color: p.grid }, border: { display: false } }, x: { grid: { display: false } } } } });
        }
      },
    });
  },
};
