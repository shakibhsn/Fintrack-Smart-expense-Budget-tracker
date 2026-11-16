import { html } from '../core/dom.js';
import { logError } from '../core/logger.js';
import { currentTheme } from '../core/theme.js';
import { on as onEvent } from '../core/events.js';

// Chart.js wrapper with the two guarantees the app needs:
//   1. ISOLATION: if Chart.js is missing or a chart throws while being built, only that chart's box shows a message;
//      the page and the rest of the app keep working.
//   2. LIFECYCLE: every chart is destroyed when its page unmounts (no leaks) and re-themed when the theme changes.

// Palette derived from the brand colours. Green carries the "good / income / primary" meaning; categories
// beyond five greens fall back to calm neutral hues so they stay distinguishable.
// Order alternates dark/light so neighbouring slices and bars stay distinguishable.
export const CHART_COLORS = ['#228B22', '#A9DFBF', '#1E5631', '#4CAF50', '#2E8B57', '#C58A1B', '#5B7B8C', '#B25F7A', '#7C6FB0', '#8A9A5B'];
export function palette() {
  const dark = currentTheme() === 'dark';
  return {
    income: dark ? '#4CAF50' : '#228B22',
    expense: dark ? '#F87171' : '#C93A3A',
    savings: dark ? '#A9DFBF' : '#2E8B57',
    estimate: dark ? '#A9DFBF' : '#4CAF50',
    text: dark ? '#9CB2A5' : '#54685D',
    grid: dark ? 'rgba(156,178,165,0.16)' : 'rgba(84,104,93,0.14)',
    surface: dark ? '#111D16' : '#FFFFFF',
  };
}

// <div class="chart-box"><canvas .../></div>. `label` becomes the accessible description of the chart.
export const chartBox = ({ id, height = 260, label }) =>
  html`<div class="chart-box" style="height:${height}px"><canvas id="${id}" role="img" aria-label="${label}"></canvas></div>`;

function themeChart(chart) {
  const p = palette();
  const o = chart.options;
  if (o.scales) Object.values(o.scales).forEach((s) => { s.ticks = { ...(s.ticks || {}), color: p.text }; if (s.grid && s.grid.display !== false) s.grid = { ...s.grid, color: p.grid }; });
  if (o.plugins && o.plugins.legend && o.plugins.legend.labels) o.plugins.legend.labels.color = p.text;
  chart.update('none');
}

// createChart(page, canvas, config) -> Chart | null. `page` is the router context (needs onCleanup + signal).
export function createChart(page, canvas, config) {
  const box = canvas && canvas.parentElement;
  try {
    if (!canvas) throw new Error('Chart canvas not found');
    if (typeof window.Chart === 'undefined') throw new Error('Chart.js failed to load');
    const p = palette();
    const Chart = window.Chart;
    Chart.defaults.font.family = "'Plus Jakarta Sans', 'Inter', sans-serif";
    Chart.defaults.color = p.text;
    const cfg = { ...config, options: { responsive: true, maintainAspectRatio: false, ...(config.options || {}) } };
    const chart = new Chart(canvas.getContext('2d'), cfg);
    page.onCleanup(() => chart.destroy());
    onEvent('theme:changed', () => { Chart.defaults.color = palette().text; themeChart(chart); }, { signal: page.signal });
    themeChart(chart);
    return chart;
  } catch (err) {
    logError('chart', err, { chart: canvas && canvas.id });
    if (box && !box.querySelector('.chart-fallback')) {
      const msg = document.createElement('div');
      msg.className = 'chart-fallback';
      msg.setAttribute('role', 'status');
      msg.textContent = 'This chart could not be displayed. The rest of the page is unaffected.';
      box.appendChild(msg);
    }
    return null;
  }
}

export const moneyAxis = (v) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v);
export const gridOptions = () => ({ y: { ticks: { callback: moneyAxis }, grid: { color: palette().grid }, border: { display: false } }, x: { grid: { display: false }, border: { display: false } } });
