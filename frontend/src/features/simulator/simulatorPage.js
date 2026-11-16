import { html, render, $, money, fmt } from '../../core/dom.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, select, input, button, badge, card, statTile, icon } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonBlock } from '../../components/skeleton.js';
import { createChart, chartBox, palette, moneyAxis } from '../../components/chartContainer.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { simulate } from './simulation.js';
import { getBaseline, listSimulations, saveSimulation, getSimulation, deleteSimulation } from './simulatorService.js';

// A SIMULATION tool: it starts from the user's real monthly averages and never modifies real transactions, budgets or goals.
// Results are shown instantly (local maths identical to the server's) and always labelled as simulated / estimated.
const MONTHS = [['1', 'Last month'], ['3', 'Last 3 months'], ['6', 'Last 6 months'], ['12', 'Last 12 months']];
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}৳${fmt(Math.abs(n))}`;
const rate = (r) => (r === null ? 'n/a (no income)' : `${r}%`);
const emptyInputs = () => ({ categoryReductions: {}, incomeIncrease: 0, savingsTargetPct: null, budgetAdjustments: {} });

export default {
  styles: [new URL('./simulator.css', import.meta.url).href],

  mount(ctx) {
    let months = 3;
    let baseline = null;
    let inputs = emptyInputs();
    let saved = [];
    let chart = null;
    let requestId = 0;
    let openedSaved = null; // inputs of the saved simulation currently being viewed

    render(ctx.outlet, html`
      ${pageHeader({ title: 'What-If Simulator', subtitle: 'Try hypothetical changes on top of your real monthly averages. This is a simulation: nothing here changes your transactions, budgets or savings, and the results are estimates, not guarantees.',
        actions: select({ id: 'sim-months', label: 'Based on', options: MONTHS, value: String(months) }) })}
      <div id="sim-body" aria-live="polite"></div>`);
    const body = $('#sim-body', ctx.outlet);

    // ---------- results (recomputed on every input) ----------
    function update() {
      if (!baseline) return;
      const R = simulate(baseline, inputs);
      const cur = R.current; const sim = R.simulated; const imp = R.savingsImprovement;

      baseline.categories.forEach((c, i) => {
        const el = $(`#sim-red-label-${i}`, body); const p = inputs.categoryReductions[c.category] || 0;
        if (el) el.textContent = p ? `-${p}% (-৳${fmt(Math.round(c.monthly * p / 100))})` : 'no change';
      });
      const tl = $('#sim-target-label', body); if (tl) tl.textContent = inputs.savingsTargetPct === null ? 'off' : `${inputs.savingsTargetPct}%`;

      render($('#sim-hero', body), html`<div class="flex items-center justify-between gap-2"><span class="eyebrow" style="color:rgb(var(--brand-text))">Simulated result</span>${badge('SIMULATED · ESTIMATE', 'accent')}</div>
        <div><div class="card-sub">Simulated monthly savings</div><div class="sim-big">${money(sim.savings)}</div>
          <div class="text-xs ${imp >= 0 ? 'text-income' : 'text-expense'}" style="font-weight:700">${imp === 0 ? 'Same as today' : `${signed(imp)} per month vs today`}</div></div>
        <div class="sim-pair"><div class="tile"><div class="eyebrow">Savings rate</div><div class="stat-value" style="font-size:var(--text-lg)">${rate(sim.savingsRatePercent)}</div></div>
          <div class="tile"><div class="eyebrow">Expense reduction</div><div class="stat-value" style="font-size:var(--text-lg)">${money(R.expenseReduction)}</div></div></div>
        ${sim.savings < 0 ? html`<p class="text-xs text-expense" style="font-weight:700">In this scenario expenses would still exceed income (estimated deficit).</p>` : ''}`);

      const row = (label, c, s, f = money) => html`<tr><th scope="row" style="font-weight:700">${label}</th><td class="num" style="color:rgb(var(--mute))">${f(c)}</td><td class="num"><b>${f(s)}</b></td></tr>`;
      render($('#sim-table', body), html`<thead><tr><th scope="col">Metric</th><th scope="col" class="num">Current (actual)</th><th scope="col" class="num">Simulated (estimate)</th></tr></thead><tbody>
        ${row('Income', cur.income, sim.income)}${row('Expenses', cur.expenses, sim.expenses)}${row('Savings', cur.savings, sim.savings)}${row('Savings rate', cur.savingsRatePercent, sim.savingsRatePercent, rate)}</tbody>`);

      const data = [[cur.income, sim.income], [cur.expenses, sim.expenses], [cur.savings, sim.savings]];
      if (chart) { chart.data.datasets[0].data = data.map((d) => d[0]); chart.data.datasets[1].data = data.map((d) => d[1]); chart.update('none'); }

      const T = R.savingsTarget; const tb = $('#sim-target-box', body);
      tb.hidden = !T;
      if (T) render(tb, T.available
        ? html`<h3 class="card-title">${icon('bullseye')} Savings target: ${T.targetPercent}% of income</h3>
            <p class="text-sm" style="margin-top:8px">To save ${T.targetPercent}% (${money(T.targetSavings)}/month) your monthly expenses would need to stay at or below <b>${money(T.requiredMaxExpenses)}</b>.</p>
            <p class="text-sm ${T.achieved ? 'text-income' : 'text-warn'}" style="font-weight:700;margin-top:6px">${T.achieved ? 'This scenario reaches the target.' : `This scenario is still ${money(T.additionalReductionNeeded)} per month above that limit.`}</p>
            ${T.reductionNeededFromCurrent > 0 ? html`<p class="card-sub" style="margin-top:4px">Compared with your current spending, that means about ${money(T.reductionNeededFromCurrent)} less per month.</p>` : ''}`
        : html`<p class="card-sub">${T.message}</p>`);

      const bb = $('#sim-budget-box', body); bb.hidden = !R.budgetComparison.length;
      render(bb, R.budgetComparison.length ? html`<h3 class="card-title">${icon('scale-balanced')} Hypothetical budgets vs simulated spending</h3><div class="sim-rows" style="margin-top:10px">${R.budgetComparison.map((b) => html`<div class="sim-row"><span style="font-weight:700">${b.category}</span><span class="${b.isOver ? 'text-expense' : 'text-income'}" style="font-weight:700;text-align:right">${money(b.simulatedSpend)} of ${money(b.newLimit)} · ${b.isOver ? `${money(-b.difference)} over` : `${money(b.difference)} left`}</span></div>`)}</div>` : '');

      const changed = R.categories.filter((c) => c.reductionPct > 0); const cb = $('#sim-cat-box', body); cb.hidden = !changed.length;
      render(cb, changed.length ? html`<h3 class="card-title">Category changes (per month)</h3><div class="sim-rows" style="margin-top:10px">${changed.map((c) => html`<div class="sim-row"><span style="font-weight:700">${c.category}</span><span class="card-sub">${money(c.current)} → <b style="color:rgb(var(--ink))">${money(c.simulated)}</b> (${signed(c.change)})</span></div>`)}</div>` : '');
    }

    // ---------- the whole layout (built once per baseline load) ----------
    function draw() {
      chart?.destroy(); chart = null;
      const rp = baseline.referencePeriod; const cur = simulate(baseline, {}).current;
      render(body, html`<div class="grid gap-6">
        ${card({ title: 'Your current financial summary', subtitle: `Average per month, ${rp.start} to ${rp.end} (${rp.months} complete ${rp.months === 1 ? 'month' : 'months'}). Real data.`, body: html`<div class="sim-summary">
          ${statTile({ label: 'Monthly income', value: money(cur.income) })}${statTile({ label: 'Monthly expenses', value: money(cur.expenses) })}${statTile({ label: 'Monthly savings', value: money(cur.savings), tone: cur.savings < 0 ? 'text-expense' : '' })}${statTile({ label: 'Savings rate', value: rate(cur.savingsRatePercent) })}</div>` })}
        <div class="sim-layout">
          <div class="sim-controls">
            ${card({ title: 'Reduce expenses', subtitle: 'Cut a category by a percentage of its monthly average', action: button({ label: 'Reset all', icon: 'rotate-left', variant: 'ghost', size: 'sm', action: 'reset' }), body: baseline.categories.length
              ? html`<div class="grid gap-3">${baseline.categories.map((c, i) => html`<div class="sim-cat"><div class="sim-cat-head"><label for="sim-red-${i}">${c.category} <span class="card-sub" style="font-weight:500">· ৳${fmt(Math.round(c.monthly))}/mo</span></label><span id="sim-red-label-${i}" style="color:rgb(var(--brand-text))"></span></div>
                <input type="range" id="sim-red-${i}" min="0" max="100" step="5" value="${inputs.categoryReductions[c.category] || 0}" data-sim-red="${i}"></div>`)}</div>`
              : html`<p class="card-sub">You have no recorded expenses in this period, so there is nothing to reduce.</p>` })}
            <div class="grid gap-4 sm:grid-cols-2">
              ${card({ title: 'Increase income', body: input({ id: 'sim-income', label: 'Extra monthly income (৳)', type: 'number', value: inputs.incomeIncrease || '', placeholder: '0', attrs: { min: 0, step: 100, inputmode: 'decimal' } }) })}
              ${card({ title: 'Savings target', action: html`<label class="flex items-center gap-2 text-xs" style="font-weight:700"><input type="checkbox" id="sim-target-on" ${inputs.savingsTargetPct !== null ? 'checked' : ''}> Use</label>`, body: html`<input type="range" id="sim-target" min="0" max="100" step="1" value="${inputs.savingsTargetPct ?? 20}" ${inputs.savingsTargetPct === null ? 'disabled' : ''} aria-label="Savings target percent of income"><p class="card-sub" style="margin-top:8px">Target: <b id="sim-target-label" style="color:rgb(var(--ink))">off</b> of income saved</p>` })}
            </div>
            <details class="card card-pad"><summary class="card-title" style="cursor:pointer">${icon('scale-balanced')} Try different category budgets <span class="card-sub" style="font-weight:500">(optional)</span></summary>
              <p class="card-sub" style="margin:8px 0 12px">Enter a hypothetical monthly limit to compare it with your (simulated) spending. Your real budgets are not changed.</p>
              <div class="grid gap-3 sm:grid-cols-2">${baseline.categories.map((c, i) => input({ id: `sim-budget-${i}`, label: `${c.category} (avg ৳${fmt(Math.round(c.monthly))})`, type: 'number', value: inputs.budgetAdjustments[c.category] ?? '', placeholder: 'No limit', attrs: { min: 0, step: 100, 'data-sim-budget': i } }))}</div></details>
          </div>
          <div class="sim-results">
            <div class="sim-result-hero" id="sim-hero"></div>
            ${card({ title: 'Current vs simulated (per month)', body: html`<div class="table-wrap"><table class="data-table" id="sim-table"></table></div><div style="margin-top:12px">${chartBox({ id: 'sim-chart', height: 200, label: 'Bar chart comparing current and simulated income, expenses and savings' })}</div>` })}
            <div class="card card-pad" id="sim-target-box" hidden></div><div class="card card-pad" id="sim-budget-box" hidden></div><div class="card card-pad" id="sim-cat-box" hidden></div>
            ${card({ title: 'Save this scenario', body: html`<div class="grid gap-3"><div class="flex flex-col sm:flex-row gap-2"><input class="input" id="sim-name" maxlength="100" placeholder="Scenario name (e.g. Cut shopping by 20%)" aria-label="Scenario name">${button({ label: 'Save', icon: 'floppy-disk', action: 'save', attrs: { id: 'sim-save' } })}</div>
              <p class="field-error" id="sim-save-error" role="alert" hidden></p><p class="card-sub">Saving stores only these what-if inputs and the numbers they produced. The server recalculates them before saving.</p></div>` })}
          </div>
        </div>
        ${card({ title: 'Saved simulations', body: html`<div id="sim-saved"></div><div id="sim-saved-detail"></div>` })}</div>`);

      const p = palette();
      chart = createChart(ctx, $('#sim-chart', body), { type: 'bar', data: { labels: ['Income', 'Expenses', 'Savings'], datasets: [{ label: 'Current (actual)', data: [0, 0, 0], backgroundColor: '#94A3B8', borderRadius: 6 }, { label: 'Simulated (estimate)', data: [0, 0, 0], backgroundColor: p.income, borderRadius: 6 }] },
        options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y)}` } } }, scales: { y: { ticks: { callback: moneyAxis }, grid: { color: p.grid }, border: { display: false } }, x: { grid: { display: false } } } } });
      drawSaved();
      update();
    }

    function drawSaved() {
      const el = $('#sim-saved', body); if (!el) return;
      render(el, saved.length ? html`<div class="grid gap-2">${saved.map((s) => html`<div class="sim-saved" data-saved="${s.id}"><div><div class="text-sm font-bold">${s.name}</div><div class="card-sub">Saved ${String(s.createdAt).slice(0, 10)} · simulated savings ${money(s.simulatedSavings)}/mo (${signed(s.savingsImprovement)} vs then)</div></div>
        <div class="flex gap-2">${button({ label: 'View', variant: 'secondary', size: 'sm', action: 'open', attrs: { 'data-id': s.id } })}${button({ iconOnly: true, icon: 'trash-can', variant: 'ghost', size: 'sm', label: `Delete ${s.name}`, action: 'delete', attrs: { 'data-id': s.id } })}</div></div>`)}</div>` : html`<p class="card-sub">No saved simulations yet.</p>`);
    }

    async function load() {
      const mine = ++requestId;
      if (!baseline) render(body, html`<div class="grid gap-4">${skeletonBlock(110)}${skeletonBlock(320)}</div>`);
      try {
        const [b, s] = await ctx.alive(Promise.all([getBaseline(months), listSimulations()]));
        if (mine !== requestId) return;
        baseline = b; saved = s;
        if (!b.available) { chart?.destroy(); chart = null; render(body, card({ body: emptyState({ icon: 'sliders', title: 'Not enough history to simulate', text: b.message, actions: html`<a class="btn btn-primary" href="#/transactions">Add transactions</a>` }) })); return; }
        const known = new Set(b.categories.map((c) => c.category));
        ['categoryReductions', 'budgetAdjustments'].forEach((k) => { inputs[k] = Object.fromEntries(Object.entries(inputs[k]).filter(([c]) => known.has(c))); });
        draw();
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('simulator', err); baseline = null; chart?.destroy(); chart = null;
        render(body, card({ body: errorState({ error: err, title: 'Could not load the simulator' }) }));
      }
    }

    // ---------- events ----------
    ctx.on(body, 'click', '[data-action="retry"]', () => load());
    ctx.on(ctx.outlet, 'change', '#sim-months', (e, el) => { months = Number(el.value); load(); });
    ctx.on(body, 'input', '[data-sim-red]', (e, el) => { const c = baseline.categories[Number(el.dataset.simRed)].category; const v = Number(el.value); if (v > 0) inputs.categoryReductions[c] = v; else delete inputs.categoryReductions[c]; update(); });
    ctx.on(body, 'input', '[data-sim-budget]', (e, el) => { const c = baseline.categories[Number(el.dataset.simBudget)].category; if (el.value === '' || Number(el.value) < 0 || Number.isNaN(Number(el.value))) delete inputs.budgetAdjustments[c]; else inputs.budgetAdjustments[c] = Number(el.value); update(); });
    ctx.on(body, 'input', '#sim-income', (e, el) => { const v = Number(el.value); inputs.incomeIncrease = el.value === '' || Number.isNaN(v) || v < 0 ? 0 : v; update(); });
    ctx.on(body, 'input', '#sim-target', (e, el) => { inputs.savingsTargetPct = Number(el.value); update(); });
    ctx.on(body, 'change', '#sim-target-on', (e, el) => { $('#sim-target', body).disabled = !el.checked; inputs.savingsTargetPct = el.checked ? Number($('#sim-target', body).value) : null; update(); });

    ctx.on(body, 'click', '[data-action="reset"]', () => { inputs = emptyInputs(); draw(); });
    ctx.on(body, 'click', '[data-action="save"]', async (e, btn) => {
      const name = $('#sim-name', body).value.trim(); const err = $('#sim-save-error', body);
      err.hidden = true;
      if (!name) { err.hidden = false; err.textContent = 'Give the scenario a name first.'; $('#sim-name', body).focus(); return; }
      btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
      try {
        await saveSimulation({ name, inputs, months });
        $('#sim-name', body).value = '';
        toast('Simulation saved.', 'success');
        saved = await listSimulations(); drawSaved();
      } catch (e2) { err.hidden = false; err.textContent = e2.message; } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
    });
    ctx.on(body, 'click', '[data-action="open"]', async (e, el) => {
      const box = $('#sim-saved-detail', body);
      render(box, html`<div style="margin-top:12px">${skeletonBlock(110)}</div>`);
      try {
        const s = await ctx.alive(getSimulation(el.dataset.id));
        openedSaved = s.inputs;
        const col = (title, sub, R, tag) => html`<div class="tile"><div class="flex flex-wrap items-center justify-between gap-1"><b class="text-xs">${title}</b>${badge(tag, 'accent')}</div><div class="card-sub">${sub}</div>
          <div class="text-xs" style="margin-top:6px">Income ${money(R.simulated.income)} · Expenses ${money(R.simulated.expenses)}</div>
          <div class="text-sm font-extrabold">Savings ${money(R.simulated.savings)} <span class="${R.savingsImprovement >= 0 ? 'text-income' : 'text-expense'}" style="font-size:var(--text-xs)">(${signed(R.savingsImprovement)})</span></div>
          <div class="card-sub">Savings rate ${rate(R.simulated.savingsRatePercent)}</div></div>`;
        const rp = s.baseline.referencePeriod; const rc = s.recalculated;
        render(box, html`<div class="grid gap-3" style="margin-top:16px"><div class="flex flex-wrap items-center justify-between gap-2"><h4 class="card-title">${s.name}</h4>${button({ label: 'Load these inputs into the simulator', icon: 'arrow-up-right-from-square', variant: 'secondary', size: 'sm', action: 'load-saved' })}</div>
          ${s.dataChangedSinceSaved ? html`<p class="text-xs text-warn" style="font-weight:700">${icon('circle-info')} Your financial data has changed since this was saved, so the two results below differ.</p>` : html`<p class="card-sub">Your data has not changed since this was saved.</p>`}
          <div class="sim-compare">${col('Original saved result', `Saved ${String(s.createdAt).slice(0, 10)} · based on ${rp.start} to ${rp.end}`, s.results, 'SAVED · ESTIMATE')}
            ${rc ? col('Recalculated now', `Same inputs, based on ${rc.baseline.referencePeriod.start} to ${rc.baseline.referencePeriod.end}`, rc.results, 'RECALCULATED · ESTIMATE') : html`<div class="tile card-sub">There is not enough current history to recalculate.</div>`}</div></div>`);
      } catch (err) { if (!(err instanceof StaleError)) render(box, html`<p class="field-error" style="margin-top:12px">${err.message}</p>`); }
    });
    ctx.on(body, 'click', '[data-action="load-saved"]', () => {
      if (!openedSaved) return;
      inputs = { categoryReductions: { ...(openedSaved.categoryReductions || {}) }, incomeIncrease: openedSaved.incomeIncrease || 0, savingsTargetPct: openedSaved.savingsTargetPct ?? null, budgetAdjustments: { ...(openedSaved.budgetAdjustments || {}) } };
      const known = new Set(baseline.categories.map((c) => c.category));
      ['categoryReductions', 'budgetAdjustments'].forEach((k) => { inputs[k] = Object.fromEntries(Object.entries(inputs[k]).filter(([c]) => known.has(c))); });
      draw(); window.scrollTo({ top: 0 }); toast('Inputs loaded. This is a new simulation using your current data.', 'info');
    });
    ctx.on(body, 'click', '[data-action="delete"]', async (e, el) => {
      const s = saved.find((x) => x.id === el.dataset.id);
      if (!(await confirmDialog({ title: 'Delete saved simulation?', message: `“${s ? s.name : 'This simulation'}” will be deleted. Your real data is not affected.`, confirmLabel: 'Delete', danger: true }))) return;
      try { await deleteSimulation(el.dataset.id); saved = saved.filter((x) => x.id !== el.dataset.id); $('#sim-saved-detail', body).replaceChildren(); drawSaved(); toast('Simulation deleted.', 'info'); } catch (err) { toastError(err); }
    });
    load();
  },
};
