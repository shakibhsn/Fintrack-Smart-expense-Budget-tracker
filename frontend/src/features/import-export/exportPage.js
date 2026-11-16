import { html, render, $, fmt } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, button, card, icon, input, select, badge } from '../../components/ui.js';
import { skeletonRows } from '../../components/skeleton.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { exportCsv, exportBackup, previewRestore, restoreBackup, readFileText, LIMITS } from './dataService.js';

const ENTITIES = [['transactions', 'Transactions'], ['budgets', 'Budgets'], ['goals', 'Savings goals'], ['subscriptions', 'Subscriptions'], ['payments', 'Subscription payments'], ['recurring', 'Recurring schedules']];
const CONFIRM_PHRASE = 'REPLACE MY DATA';
const EXCLUDED = ['Password and e-mail address (the backup holds your name and currency only)', 'Login tokens and secrets (none are stored)', 'Notifications and their preferences', 'Unusual-spending findings, saved simulations and saved report snapshots (they can be recreated)', 'Import history', 'Recurring occurrence logs (the transactions they created are included)'];

export default {
  styles: [new URL('./import-export.css', import.meta.url).href],

  mount(ctx) {
    let backup = null; let fileName = ''; let mode = 'merge'; let pv = null; let busy = false;
    const lists = [['budgets', 'Budgets', 'bullseye', 'Limits with spent and remaining'], ['goals', 'Savings goals', 'piggy-bank', 'Targets and progress'], ['subscriptions', 'Subscriptions', 'rotate', 'Plans with ESTIMATED monthly/yearly cost'], ['recurring', 'Recurring schedules', 'repeat', 'Schedules and their status']];

    render(ctx.outlet, html`
      ${pageHeader({ title: 'Export & Backup', subtitle: 'Download your data as CSV, keep a full backup, or restore one. Your data is yours: exports contain only your own records.' })}
      <div class="ie-steps">
        ${card({ title: 'Transactions (CSV)', subtitle: 'Leave the filters empty to export everything. The file uses the same columns as the import template.', body: html`
          <form id="ex-form" class="ie-form" novalidate>
            ${select({ id: 'ex-type', label: 'Type', options: [['', 'All types'], ['INCOME', 'Income'], ['EXPENSE', 'Expense']], value: '' })}
            ${input({ id: 'ex-category', label: 'Category', optional: true, placeholder: 'e.g. Food' })}
            ${input({ id: 'ex-from', label: 'From', type: 'date', optional: true })}
            ${input({ id: 'ex-to', label: 'To', type: 'date', optional: true })}
            ${input({ id: 'ex-search', label: 'Search text', optional: true, placeholder: 'description or notes' })}
            ${input({ id: 'ex-min', label: 'Min amount', type: 'number', optional: true, attrs: { min: 0, step: '0.01' } })}
            ${input({ id: 'ex-max', label: 'Max amount', type: 'number', optional: true, attrs: { min: 0, step: '0.01' } })}
            <div>${button({ label: 'Download CSV', icon: 'file-csv', type: 'submit' })}</div>
          </form><p class="field-error" id="ex-error" role="alert" hidden></p>` })}
        <div class="ie-grid">${lists.map(([k, label, ic, sub]) => card({ title: label, subtitle: sub, body: button({ label: 'Download CSV', icon: 'file-csv', variant: 'secondary', action: 'csv', attrs: { 'data-kind': k } }) }))}
          ${card({ title: 'Reports', subtitle: 'Monthly and custom reports export as PDF or CSV', body: html`<a class="btn btn-secondary" href="#/reports">${icon('file-lines')} <span>Open Reports</span></a>` })}</div>

        ${card({ title: 'Full backup (JSON)', subtitle: 'One file with your transactions, budgets, goals (with contributions), subscriptions (with their payment history) and recurring schedules.', body: html`
          <div class="ie-actions">${button({ label: 'Download full backup', icon: 'download', action: 'backup' })}</div>
          <details style="margin-top:12px"><summary class="text-sm font-bold" style="cursor:pointer">What is NOT in the backup</summary><ul class="ie-rules" style="margin-top:8px">${EXCLUDED.map((x) => html`<li>${x}</li>`)}</ul></details>
          <p class="card-sub" style="margin-top:8px">The file includes a checksum so a damaged or edited file is detected when you restore it. Keep backups somewhere safe: they contain your financial data.</p>` })}

        ${card({ title: 'Restore from a backup', subtitle: 'Choose a FinTrack backup file. You will see exactly what would change before anything is written.', body: html`
          <div class="ie-actions"><label class="btn btn-secondary" for="rs-file">${icon('upload')} <span>Choose backup file (.json)</span></label><input type="file" id="rs-file" accept=".json,application/json" class="sr-only"><span class="card-sub" id="rs-fname"></span></div>
          <p class="field-error" id="rs-error" role="alert" hidden></p>
          <div id="rs-body" aria-live="polite" style="margin-top:14px"></div>` })}
      </div>`);

    const exErr = $('#ex-error', ctx.outlet); const rsErr = $('#rs-error', ctx.outlet); const rsBody = $('#rs-body', ctx.outlet);
    const guard = async (el, fn) => { if (busy) return; busy = true; if (el) el.disabled = true; try { await fn(); } catch (err) { if (!(err instanceof StaleError)) toastError(err); } finally { busy = false; if (el) el.disabled = false; } };

    // ----- CSV exports -----
    ctx.on(ctx.outlet, 'submit', '#ex-form', (e) => {
      e.preventDefault();
      const v = (id) => $(`#${id}`, ctx.outlet).value.trim();
      const f = { type: v('ex-type'), category: v('ex-category'), dateFrom: v('ex-from'), dateTo: v('ex-to'), search: v('ex-search'), minAmount: v('ex-min'), maxAmount: v('ex-max') };
      exErr.hidden = true;
      if (f.dateFrom && f.dateTo && f.dateTo < f.dateFrom) { exErr.hidden = false; exErr.textContent = 'The end date must be on or after the start date.'; return; }
      if (f.minAmount && f.maxAmount && Number(f.maxAmount) < Number(f.minAmount)) { exErr.hidden = false; exErr.textContent = 'Max amount must be at least the min amount.'; return; }
      const filters = Object.fromEntries(Object.entries(f).filter(([, x]) => x !== ''));
      guard($('button[type="submit"]', ctx.outlet), async () => { const r = await exportCsv('transactions', filters); toast(`Downloaded ${r.name}.`, 'success'); });
    });
    ctx.on(ctx.outlet, 'click', '[data-action="csv"]', (e, el) => guard(el, async () => { const r = await exportCsv(el.dataset.kind); toast(`Downloaded ${r.name}.`, 'success'); }));
    ctx.on(ctx.outlet, 'click', '[data-action="backup"]', (e, el) => guard(el, async () => { const r = await exportBackup(); toast(`Backup downloaded (${r.name}).`, 'success'); }));

    // ----- restore -----
    const countsTable = (p) => html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Data</th><th class="num">In file</th><th class="num">You have now</th><th class="num">Will be added</th><th class="num">Skipped</th>${p.mode === 'replace' ? html`<th class="num">Deleted first</th>` : ''}</tr></thead><tbody>
      ${ENTITIES.map(([k, label]) => html`<tr><td><b>${label}</b></td><td class="num">${fmt(p.fileCounts[k])}</td><td class="num">${fmt(p.existingCounts[k])}</td><td class="num text-income"><b>${fmt(p.willAdd[k])}</b></td><td class="num">${fmt(p.willSkip[k])}${p.skipReasons[k] && p.skipReasons[k].length ? html`<div class="card-sub">${p.skipReasons[k].join('; ')}</div>` : ''}</td>${p.mode === 'replace' ? html`<td class="num text-expense">${fmt(p.willDelete[k])}</td>` : ''}</tr>`)}</tbody></table></div>`;

    function drawPreview() {
      const p = pv;
      const total = Object.values(p.willAdd).reduce((a, b) => a + b, 0);
      const phraseOk = mode !== 'replace' || ($('#rs-phrase', rsBody) && $('#rs-phrase', rsBody).value === CONFIRM_PHRASE);
      render(rsBody, html`<div class="grid gap-4">
        <p class="card-sub">Backup made ${p.format.exportedAt ? String(p.format.exportedAt).slice(0, 10) : 'on an unknown date'} · format v${p.format.version} · checksum OK</p>
        <div class="ie-modes" role="radiogroup" aria-label="Restore mode">
          <label class="ie-mode"><input type="radio" name="rs-mode" value="merge" ${mode === 'merge' ? 'checked' : ''}><span><b>Merge (recommended)</b><br><span class="card-sub">Adds what is missing. Nothing you have is deleted or changed; items that already exist are skipped, so restoring twice adds nothing.</span></span></label>
          <label class="ie-mode"><input type="radio" name="rs-mode" value="replace" ${mode === 'replace' ? 'checked' : ''}><span><b>Replace my data</b><br><span class="card-sub">Deletes your current transactions, budgets, goals, subscriptions and recurring schedules first, then restores the backup. Cannot be undone.</span></span></label>
        </div>
        ${countsTable(p)}
        ${p.warnings.map((w) => html`<p class="ie-warn ${/permanently delete/.test(w) ? 'ie-danger' : ''}">${icon('triangle-exclamation')} ${w}</p>`)}
        ${p.invalidTotal ? html`<details><summary class="text-sm font-bold" style="cursor:pointer;color:rgb(var(--expense,200 60 50))">${p.invalidTotal} invalid item(s) will be skipped</summary><ul class="ie-rules" style="margin-top:8px">${ENTITIES.flatMap(([k, label]) => p.invalid[k].slice(0, 5).map((x) => html`<li>${label} #${x.index}: ${x.errors.join('; ')}</li>`))}</ul></details>` : ''}
        ${mode === 'replace' ? html`<div>${input({ id: 'rs-phrase', label: `Type ${CONFIRM_PHRASE} to confirm`, placeholder: CONFIRM_PHRASE, attrs: { autocomplete: 'off' } })}</div>` : ''}
        <div class="ie-actions">${button({ label: mode === 'replace' ? 'Replace my data with this backup' : `Restore ${fmt(total)} item${total === 1 ? '' : 's'}`, icon: 'clock-rotate-left', variant: mode === 'replace' ? 'danger' : 'primary', action: 'restore', disabled: (mode === 'merge' && !total) || !phraseOk })}${button({ label: 'Cancel', variant: 'secondary', action: 'rs-cancel' })}${mode === 'merge' && !total ? html`<span class="card-sub">Everything in this backup already exists in your account.</span>` : ''}</div>
      </div>`);
    }

    async function runPreview() {
      render(rsBody, skeletonRows(3, 60));
      try {
        pv = await ctx.alive(previewRestore(backup, mode, fileName));
        rsErr.hidden = true; drawPreview();
      } catch (err) {
        if (err instanceof StaleError) return;
        pv = null; backup = null; render(rsBody, '');
        rsErr.hidden = false; rsErr.textContent = err.message || 'Could not read that backup.';
        if (!(err.status >= 400 && err.status < 500)) logError('restore-preview', err);
      }
    }

    ctx.on(ctx.outlet, 'change', '#rs-file', async (e, el) => {
      const f = el.files[0]; el.value = '';
      rsErr.hidden = true; render(rsBody, '');
      if (!f) return;
      if (!/\.json$/i.test(f.name)) { rsErr.hidden = false; rsErr.textContent = 'Please choose the .json file you downloaded from “Download full backup”.'; return; }
      if (f.size > LIMITS.backupBytes) { rsErr.hidden = false; rsErr.textContent = 'That file is larger than 5 MB, so it cannot be a normal FinTrack backup.'; return; }
      try { backup = JSON.parse(await readFileText(f)); } catch { rsErr.hidden = false; rsErr.textContent = 'That file is not valid JSON. Use an unmodified FinTrack backup.'; return; }
      fileName = f.name; mode = 'merge'; $('#rs-fname', ctx.outlet).textContent = f.name;
      runPreview();
    });
    ctx.on(rsBody, 'change', '[name="rs-mode"]', (e, el) => { mode = el.value; runPreview(); });
    ctx.on(rsBody, 'input', '#rs-phrase', () => { const b = $('[data-action="restore"]', rsBody); if (b) b.disabled = $('#rs-phrase', rsBody).value !== CONFIRM_PHRASE; });
    ctx.on(rsBody, 'click', '[data-action="rs-cancel"]', () => { backup = null; pv = null; render(rsBody, ''); $('#rs-fname', ctx.outlet).textContent = ''; });
    ctx.on(rsBody, 'click', '[data-action="restore"]', (e, el) => guard(el, async () => {
      const replace = mode === 'replace';
      const ok = await confirmDialog({
        title: replace ? 'Replace all your data?' : 'Restore this backup?', danger: replace, confirmLabel: replace ? 'Replace my data' : 'Restore',
        message: replace ? `This permanently deletes your current data (${fmt(pv.willDelete.transactions)} transactions, ${fmt(pv.willDelete.budgets)} budgets, ${fmt(pv.willDelete.goals)} goals ...) and restores the backup. If anything fails, nothing is changed.` : 'Missing items are added; nothing you already have is deleted. If anything fails, nothing is changed.',
      });
      if (!ok) return;
      render(rsBody, skeletonRows(2, 70));
      try {
        const r = await ctx.alive(restoreBackup(backup, mode, fileName, replace ? $('#rs-phrase', rsBody) && CONFIRM_PHRASE : undefined));
        const a = r.added;
        toast('Backup restored.', 'success');
        emit('data:changed', { scope: 'all' });
        backup = null; pv = null;
        render(rsBody, html`<div class="ie-warn">${icon('circle-check')} <b>Restore complete.</b> Added ${fmt(a.transactions)} transactions, ${fmt(a.budgets)} budgets, ${fmt(a.goals)} goals (${fmt(a.goalContributions)} contributions), ${fmt(a.subscriptions)} subscriptions and ${fmt(a.recurring)} recurring schedules${a.recurring ? ' (paused: resume them on the Recurring page)' : ''}. ${r.invalid ? `${r.invalid} invalid item(s) were skipped. ` : ''}<a class="link" href="#/import">See import history</a></div>`);
      } catch (err) { if (err instanceof StaleError) return; if (pv) drawPreview(); throw err; }
    }));
    void badge;
  },
};
