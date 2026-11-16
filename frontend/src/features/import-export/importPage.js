import { html, render, $, fmt2 } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, button, card, icon, badge } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonRows } from '../../components/skeleton.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { downloadTemplate, previewImport, confirmImport, downloadErrorReport, getImportHistory, undoImport, readFileText, readFileBase64, LIMITS } from './dataService.js';

const tile = (label, value, tone = '') => html`<div class="tile"><div class="eyebrow">${label}</div><div class="stat-value ${tone}" style="font-size:var(--text-xl)">${value}</div></div>`;
const rowCells = (r) => html`<td class="tabular" style="white-space:nowrap">${r.row}</td>`;

export default {
  styles: [new URL('./import-export.css', import.meta.url).href],

  mount(ctx) {
    let file = null; // { src: { csv } | { xlsx }, name }
    let analysis = null;
    let selected = new Set(); // duplicate rows the user chose to import anyway
    let busy = false;

    render(ctx.outlet, html`
      ${pageHeader({ title: 'Import transactions', subtitle: 'Bring transactions in from a CSV file. You see exactly what will happen first: nothing is saved until you confirm.' })}
      <div class="ie-steps">
        <div class="ie-grid">
          ${card({ title: '1. Use the CSV format', subtitle: 'Columns: date, type, amount, category, description, notes (notes is optional)', body: html`
            <ul class="ie-rules">
              <li><b>date</b>: YYYY-MM-DD, a real day (01/02/2024 is rejected, never guessed)</li>
              <li><b>type</b>: INCOME or EXPENSE</li>
              <li><b>amount</b>: a positive number, up to 2 decimals, no commas or currency signs</li>
              <li><b>category</b> up to 50 characters, <b>description</b> up to 200</li>
              <li>At most ${fmt2(1000)} rows. <b>CSV</b> (about 1 MB) or <b>Excel .xlsx</b> (about 2 MB, first sheet, same columns in the first row; formulas are never run, only their values are read). The old .xls format is not supported.</li>
            </ul>
            <div class="ie-actions" style="margin-top:12px">${button({ label: 'Download template', icon: 'file-arrow-down', variant: 'secondary', action: 'template' })}</div>` })}
          ${card({ title: '2. Choose your file', body: html`
            <div class="ie-drop" id="imp-drop"><span class="icon-chip">${icon('file-csv')}</span>
              <p class="card-sub" style="margin:0">Drop a .csv or .xlsx file here, or</p>
              <label class="btn btn-primary" for="imp-file">${icon('upload')} <span>Choose file</span></label>
              <input type="file" id="imp-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="sr-only" aria-describedby="imp-error">
              <p class="card-sub" id="imp-fname" style="margin:0"></p></div>
            <p class="field-error" id="imp-error" role="alert" hidden></p>` })}
        </div>
        <div id="imp-body" aria-live="polite"></div>
        <div id="imp-history"></div>
      </div>`);
    const body = $('#imp-body', ctx.outlet);
    const errBox = $('#imp-error', ctx.outlet);
    const setError = (msg) => { errBox.hidden = !msg; errBox.textContent = msg || ''; };

    // ----- preview rendering -----
    const invalidTable = (rows, truncated) => html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Row</th><th>Problem</th><th class="hidden md:table-cell">Row content</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr>${rowCells(r)}<td class="ie-cell text-expense">${r.errors.join('; ')}</td><td class="hidden md:table-cell card-sub ie-cell">${r.raw.join(' | ')}</td></tr>`)}</tbody></table></div>${truncated ? html`<p class="card-sub">Only the first rows are shown. The error report lists every problem.</p>` : ''}`;
    const dupTable = (rows, truncated) => html`<div class="table-wrap"><table class="data-table"><thead><tr><th style="width:44px"><span class="sr-only">Import anyway</span></th><th>Row</th><th>Date</th><th class="hidden sm:table-cell">Description</th><th class="num">Amount</th><th>Why</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td><input type="checkbox" data-dup="${r.row}" aria-label="Import row ${r.row} anyway" ${selected.has(r.row) ? 'checked' : ''}></td>${rowCells(r)}<td class="tabular">${r.data.date}</td><td class="hidden sm:table-cell ie-cell">${r.data.description}</td><td class="num">৳${fmt2(r.data.amount)}</td><td class="card-sub">${r.duplicate.kind === 'existing' ? 'Already in your transactions' : `Same as row ${r.duplicate.firstRow} in this file`}</td></tr>`)}</tbody></table></div>${truncated ? html`<p class="card-sub">Only the first ${rows.length} possible duplicates are listed here. Use “import all duplicates” in the confirm step only if you are sure.</p>` : ''}`;
    const sampleTable = (rows) => html`<div class="table-wrap"><table class="data-table"><thead><tr><th>Row</th><th>Date</th><th>Type</th><th class="hidden sm:table-cell">Category</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
      ${rows.slice(0, 10).map((r) => html`<tr>${rowCells(r)}<td class="tabular">${r.data.date}</td><td>${r.data.type === 'INCOME' ? badge('Income', 'brand') : badge('Expense', 'danger')}</td><td class="hidden sm:table-cell">${r.data.category}</td><td class="ie-cell">${r.data.description}</td><td class="num">৳${fmt2(r.data.amount)}</td></tr>`)}</tbody></table></div>`;

    function drawPreview() {
      const a = analysis; const c = a.counts;
      const toImport = c.valid + selected.size;
      render(body, html`<div class="grid gap-4">
        ${card({ title: '3. Review before importing', subtitle: `${a.fileName || 'Your file'} · nothing has been saved yet`, body: html`
          <div class="ie-tiles">${tile('Rows in file', c.total)}${tile('Ready to import', c.valid, 'text-income')}${tile('Invalid (skipped)', c.invalid, c.invalid ? 'text-expense' : '')}${tile('Possible duplicates', c.duplicate, c.duplicate ? 'text-warn' : '')}</div>
          ${a.sameFileAlreadyImported ? html`<p class="ie-warn ie-danger" style="margin-top:12px" role="alert">${icon('triangle-exclamation')} This exact file was already imported on ${String(a.sameFileAlreadyImported.at).slice(0, 10)} (${a.sameFileAlreadyImported.importedRows} rows). Importing it again would create duplicates; they are flagged below.</p>` : ''}
          ${a.ignoredColumns.length ? html`<p class="ie-warn" style="margin-top:12px">${icon('circle-info')} Ignored columns: ${a.ignoredColumns.join(', ')}.</p>` : ''}` })}
        ${c.invalid ? card({ title: `Invalid rows (${c.invalid})`, subtitle: 'These rows will NOT be imported. Fix them in your file and upload again, or import the valid rows now.', action: button({ label: 'Download error report', icon: 'file-arrow-down', variant: 'secondary', size: 'sm', action: 'error-report' }), body: invalidTable(a.invalid, a.invalidTruncated) }) : ''}
        ${c.duplicate ? card({ title: `Possible duplicates (${c.duplicate})`, subtitle: `${a.duplicateRule} They are skipped unless you tick them.`, action: html`<div class="ie-actions">${button({ label: 'Select all', variant: 'ghost', size: 'sm', action: 'dup-all' })}${button({ label: 'Select none', variant: 'ghost', size: 'sm', action: 'dup-none' })}</div>`, body: dupTable(a.duplicates, a.duplicatesTruncated) }) : ''}
        ${c.valid ? card({ title: 'Rows that will be imported', subtitle: `First ${Math.min(10, a.validSample.length)} of ${c.valid}`, body: sampleTable(a.validSample) }) : ''}
        ${card({ body: html`<div class="ie-actions">
          ${button({ label: toImport ? `Import ${toImport} transaction${toImport === 1 ? '' : 's'}` : 'Nothing to import', icon: 'check', action: 'confirm', disabled: !toImport || busy })}
          ${button({ label: 'Cancel', variant: 'secondary', action: 'cancel' })}
          <span class="card-sub">${c.invalid ? `${c.invalid} invalid row${c.invalid === 1 ? '' : 's'} will be skipped. ` : ''}${c.duplicate - selected.size > 0 ? `${c.duplicate - selected.size} possible duplicate${c.duplicate - selected.size === 1 ? '' : 's'} will be skipped.` : ''}</span></div>` })}
      </div>`);
    }

    function drawDone(r) {
      render(body, card({ title: 'Import finished', body: html`
        <div class="ie-tiles">${tile('Imported', r.imported, 'text-income')}${tile('Skipped duplicates', r.skippedDuplicates)}${tile('Invalid (not imported)', r.invalid, r.invalid ? 'text-expense' : '')}${tile('Rows in file', r.total)}</div>
        <div class="ie-actions" style="margin-top:14px"><a class="btn btn-primary" href="#/transactions">View transactions</a>${button({ label: 'Import another file', variant: 'secondary', action: 'cancel' })}${button({ label: 'Undo this import', icon: 'rotate-left', variant: 'secondary', action: 'undo-now', attrs: { 'data-id': r.batchId } })}</div>
        <p class="card-sub" style="margin-top:8px">You can undo an import later from the history below. Undo removes only the transactions this file created.</p>` }));
    }

    // ----- file handling -----
    async function handleFile(f) {
      setError('');
      if (!f) return;
      const isXlsx = /\.xlsx$/i.test(f.name);
      if (!isXlsx && !/\.csv$/i.test(f.name)) { setError(/\.(xls|xlsm)$/i.test(f.name) ? 'That Excel format is not supported. In Excel choose File > Save As > Excel Workbook (.xlsx) or CSV, then upload that file.' : 'Please choose a .csv or .xlsx file.'); return; }
      const limit = isXlsx ? LIMITS.xlsxBytes : LIMITS.csvBytes;
      if (f.size > limit) { setError(`That file is ${(f.size / 1_000_000).toFixed(1)} MB. The limit is ${isXlsx ? '2' : '1'} MB (about 1,000 rows). Split it into smaller files.`); return; }
      if (f.size === 0) { setError('That file is empty.'); return; }
      $('#imp-fname', ctx.outlet).textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
      render(body, skeletonRows(3, 90));
      try {
        const src = isXlsx ? { xlsx: await readFileBase64(f) } : { csv: await readFileText(f) };
        const result = await ctx.alive(previewImport(src, f.name));
        file = { src, name: f.name }; analysis = result; selected = new Set();
        drawPreview();
      } catch (err) {
        if (err instanceof StaleError) return;
        file = null; analysis = null; render(body, '');
        setError(err.message || 'Could not read that file.');
        if (!(err.status >= 400 && err.status < 500)) logError('import-preview', err); // a rejected file is a normal outcome, not an app error
      }
    }
    const input = $('#imp-file', ctx.outlet);
    ctx.on(ctx.outlet, 'change', '#imp-file', (e, el) => { handleFile(el.files[0]); el.value = ''; });
    const drop = $('#imp-drop', ctx.outlet);
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.dataset.over = 'true'; }, { signal: ctx.signal }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.dataset.over = 'false'; }, { signal: ctx.signal }));
    drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]), { signal: ctx.signal });
    void input;

    const guard = async (el, fn) => { if (busy) return; busy = true; if (el) el.disabled = true; try { await fn(); } catch (err) { if (!(err instanceof StaleError)) toastError(err); } finally { busy = false; if (el) el.disabled = false; } };
    ctx.on(ctx.outlet, 'click', '[data-action="template"]', (e, el) => guard(el, async () => { await downloadTemplate(); toast('Template downloaded.', 'success'); }));
    ctx.on(body, 'click', '[data-action="error-report"]', (e, el) => guard(el, async () => { await downloadErrorReport(file.src, file.name); toast('Error report downloaded.', 'success'); }));
    ctx.on(body, 'click', '[data-action="cancel"]', () => { file = null; analysis = null; selected = new Set(); render(body, ''); $('#imp-fname', ctx.outlet).textContent = ''; setError(''); });
    ctx.on(body, 'change', '[data-dup]', (e, el) => { const n = Number(el.dataset.dup); if (el.checked) selected.add(n); else selected.delete(n); drawPreview(); });
    ctx.on(body, 'click', '[data-action="dup-all"]', () => { analysis.duplicates.forEach((d) => selected.add(d.row)); drawPreview(); });
    ctx.on(body, 'click', '[data-action="dup-none"]', () => { selected = new Set(); drawPreview(); });
    ctx.on(body, 'click', '[data-action="confirm"]', (e, el) => guard(el, async () => {
      const n = analysis.counts.valid + selected.size;
      const ok = await confirmDialog({ title: `Import ${n} transaction${n === 1 ? '' : 's'}?`, message: `${analysis.counts.invalid ? `${analysis.counts.invalid} invalid row(s) will be skipped. ` : ''}${analysis.counts.duplicate - selected.size ? `${analysis.counts.duplicate - selected.size} possible duplicate(s) will be skipped. ` : ''}You can undo the import afterwards.`, confirmLabel: 'Import' });
      if (!ok) return;
      render(body, skeletonRows(2, 90));
      try {
        const r = await ctx.alive(confirmImport(file.src, file.name, { duplicateAction: 'skip', includeRows: [...selected] }));
        toast(`Imported ${r.imported} transaction${r.imported === 1 ? '' : 's'}.`, 'success');
        emit('data:changed', { scope: 'transactions' });
        file = null; analysis = null;
        drawDone(r); loadHistory();
      } catch (err) { if (err instanceof StaleError) return; drawPreview(); throw err; }
    }));
    ctx.on(body, 'click', '[data-action="undo-now"]', (e, el) => undo(el.dataset.id));

    // ----- history -----
    const hist = $('#imp-history', ctx.outlet);
    const statusBadge = (s) => (s === 'COMPLETED' ? badge('Completed', 'brand') : s === 'UNDONE' ? badge('Undone') : badge('Failed', 'danger'));
    async function loadHistory() {
      try {
        const rows = await ctx.alive(getImportHistory());
        render(hist, card({ title: 'Import history', subtitle: 'Your recent imports and backup restores', body: rows.length
          ? html`<div class="ie-hist">${rows.map((h) => html`<div class="ie-hist-item"><div style="min-width:0;flex:1 1 240px"><div class="text-sm font-bold truncate-1">${h.kind === 'BACKUP_RESTORE' ? 'Backup restore' : 'CSV import'}${h.fileName ? ` · ${h.fileName}` : ''} ${statusBadge(h.status)}</div>
              <div class="card-sub">${String(h.createdAt).slice(0, 16).replace('T', ' ')} · ${h.importedRows} imported${h.duplicateSkipped ? `, ${h.duplicateSkipped} duplicates skipped` : ''}${h.invalidRows ? `, ${h.invalidRows} invalid` : ''}${h.errorMessage ? ` · ${h.errorMessage}` : ''}</div></div>
              ${h.canUndo ? button({ label: 'Undo', icon: 'rotate-left', variant: 'ghost', size: 'sm', action: 'undo', ariaLabel: `Undo import ${h.fileName || ''}`, attrs: { 'data-id': h.id } }) : ''}</div>`)}</div>`
          : emptyState({ icon: 'clock-rotate-left', title: 'No imports yet', text: 'Imports and restores you make will be listed here.' }) }));
      } catch (err) {
        if (err instanceof StaleError) return;
        logError('import-history', err);
        render(hist, card({ body: errorState({ error: err, title: 'Could not load import history' }) }));
      }
    }
    async function undo(id) {
      const ok = await confirmDialog({ title: 'Undo this import?', message: 'This deletes the transactions that this import created (and only those). Transactions you added or edited yourself are not affected.', confirmLabel: 'Undo import', danger: true });
      if (!ok) return;
      try {
        const r = await undoImport(id);
        toast(`Import undone: ${r.removed} transaction${r.removed === 1 ? '' : 's'} removed.`, 'success');
        emit('data:changed', { scope: 'transactions' });
        loadHistory();
        if ($('[data-action="undo-now"]', body)) render(body, '');
      } catch (err) { toastError(err); }
    }
    ctx.on(hist, 'click', '[data-action="undo"]', (e, el) => undo(el.dataset.id));
    ctx.on(hist, 'click', '[data-action="retry"]', () => loadHistory());
    loadHistory();
  },
};
