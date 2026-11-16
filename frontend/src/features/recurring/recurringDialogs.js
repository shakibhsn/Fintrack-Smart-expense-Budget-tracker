import { html, $, isoToday, fmt } from '../../core/dom.js';
import { logError } from '../../core/logger.js';
import { openModal } from '../../components/modal.js';
import { input, select, textarea, segmented, badge, categoryOptions } from '../../components/ui.js';
import { skeletonRows } from '../../components/skeleton.js';
import { errorState } from '../../components/states.js';
import { toast } from '../../components/toast.js';
import { createRecurring, updateRecurring, getOccurrences, resumeRecurring } from './recurringService.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utc = (s) => new Date(`${s}T00:00:00Z`);

export function describeFrequency(r) {
  const d = utc(r.startDate); const n = d.getUTCDate();
  if (r.frequency === 'DAILY') return 'Every day';
  if (r.frequency === 'WEEKLY') return `Every ${WEEKDAYS[d.getUTCDay()]}`;
  if (r.frequency === 'MONTHLY') return `Monthly on day ${n}${n > 28 ? ' (last day in shorter months)' : ''}`;
  return `Every year on ${MONTHS[d.getUTCMonth()]} ${n}`;
}

// Hint about calendar edge cases for the chosen start date + frequency.
const hintFor = (start, freq) => {
  if (!start) return '';
  const d = utc(start);
  if (freq === 'MONTHLY' && d.getUTCDate() > 28) return `Starts on day ${d.getUTCDate()}: in months without that day it runs on the last day of the month.`;
  if (freq === 'YEARLY' && start.slice(5) === '02-29') return 'Feb 29 runs on Feb 28 in years that are not leap years.';
  if (freq === 'WEEKLY') return `Repeats every ${WEEKDAYS[d.getUTCDay()]}.`;
  return '';
};

// Create / edit a schedule. Edits only ever change FUTURE occurrences; transactions already created are never modified.
export function openRecurringForm({ schedule = null, onSaved } = {}) {
  const r = schedule;
  let type = r ? r.type : 'EXPENSE';
  const modal = openModal({
    title: r ? 'Edit recurring transaction' : 'New recurring transaction',
    body: html`<form id="rc-form" novalidate class="grid gap-4">
      ${segmented({ name: 'rc-type', value: type, items: [['EXPENSE', 'Expense'], ['INCOME', 'Income']] })}
      ${input({ id: 'rc-title', label: 'Title', value: r ? r.title : '', placeholder: 'e.g. Monthly rent, Salary, Netflix', required: true, attrs: { maxlength: 100 } })}
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'rc-amount', label: 'Amount (৳)', type: 'number', value: r ? r.amount : '', placeholder: '0.00', required: true, attrs: { step: '0.01', min: '0.01', inputmode: 'decimal' } })}
        ${select({ id: 'rc-category', label: 'Category', options: categoryOptions(), value: r ? r.category : 'Bills', required: true })}
      </div>
      ${select({ id: 'rc-frequency', label: 'Repeats', options: [['DAILY', 'Daily'], ['WEEKLY', 'Weekly (same weekday)'], ['MONTHLY', 'Monthly (same day of the month)'], ['YEARLY', 'Yearly']], value: r ? r.frequency : 'MONTHLY', required: true })}
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'rc-start', label: 'Start date', type: 'date', value: r ? r.startDate : isoToday(), required: true })}
        ${input({ id: 'rc-end', label: 'End date', type: 'date', value: r && r.endDate ? r.endDate : '', optional: true })}
      </div>
      <p class="field-hint" id="rc-hint" aria-live="polite"></p>
      ${r ? '' : html`<label class="flex items-start gap-2 text-sm" id="rc-backfill-wrap" hidden style="padding:12px;border-radius:var(--r-md);background:rgb(var(--surface-2))"><input type="checkbox" id="rc-backfill" style="margin-top:3px"><span><b>Also record the past occurrences</b> (up to 60). Leave unticked to start from today: past dates are not recorded.</span></label>`}
      ${textarea({ id: 'rc-notes', label: 'Notes', value: r && r.notes ? r.notes : '', maxlength: 500, optional: true })}
      ${r ? html`<p class="field-hint" style="color:rgb(var(--warning))">Changes apply to future occurrences only. Transactions that were already created are never changed.</p>` : ''}
      <p class="field-error" id="rc-form-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="rc-form" id="rc-submit">${r ? 'Save changes' : 'Create schedule'}</button>`,
  });
  const form = $('#rc-form', modal.el);
  const setError = (name, message) => {
    const el = $(`#rc-${name}`, form); const err = $(`#rc-${name}-error`, form);
    err.hidden = !message; err.textContent = message || '';
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  };
  const names = ['title', 'amount', 'start', 'end'];
  const refreshHints = () => {
    $('#rc-hint', form).textContent = hintFor($('#rc-start', form).value, $('#rc-frequency', form).value);
    const wrap = $('#rc-backfill-wrap', form);
    if (wrap) wrap.hidden = !$('#rc-start', form).value || $('#rc-start', form).value >= isoToday();
  };
  names.forEach((n) => $(`#rc-${n}`, form).addEventListener('input', () => setError(n, '')));
  ['rc-start', 'rc-frequency'].forEach((id) => $(`#${id}`, form).addEventListener('change', refreshHints));
  refreshHints();
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg="rc-type"]');
    if (!b) return;
    type = b.dataset.value;
    form.querySelectorAll('[data-seg="rc-type"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = $('#rc-start', form).value; const end = $('#rc-end', form).value;
    const payload = { title: $('#rc-title', form).value.trim(), type, amount: Number($('#rc-amount', form).value), category: $('#rc-category', form).value, frequency: $('#rc-frequency', form).value, startDate: start, endDate: end || null, notes: $('#rc-notes', form).value.trim() || null };
    const errors = {};
    if (!payload.title) errors.title = 'Give it a title.';
    if (!(payload.amount > 0)) errors.amount = 'Enter an amount greater than 0.';
    if (!start) errors.start = 'Choose a start date.';
    if (end && start && end < start) errors.end = 'The end date must be on or after the start date.';
    names.forEach((n) => setError(n, errors[n]));
    const first = names.find((n) => errors[n]);
    if (first) { $(`#rc-${first}`, form).focus(); return; }
    if (!r && $('#rc-backfill', form)?.checked) payload.backfill = true;
    if (r) payload.applyTo = 'future';
    const btn = $('#rc-submit', modal.el);
    btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
    try {
      if (r) await updateRecurring(r.id, payload); else await createRecurring(payload);
      modal.close();
      toast(r ? 'Updated (future occurrences only).' : 'Recurring transaction created.', 'success');
      if (onSaved) onSaved();
    } catch (err) {
      const box = $('#rc-form-error', form); box.hidden = false; box.textContent = err.message;
    } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
  });
  return modal;
}

// Resume policy: skip the dates missed while paused (default) or record them now (max 60).
export function openResumeDialog({ schedule, onDone }) {
  const modal = openModal({
    title: 'Resume this schedule', size: 'sm',
    body: html`<div class="grid gap-3"><p class="state-text" style="max-width:none;text-align:left">Dates that fell due while “${schedule.title}” was paused can be skipped (recommended) or recorded now.</p>
      <button type="button" class="rc-option" data-catch="false"><b>Resume and skip missed dates</b><span>Nothing is added for the paused period. It continues from the next date.</span></button>
      <button type="button" class="rc-option" data-catch="true"><b>Resume and record the missed dates</b><span>Adds a transaction for each missed date (at most 60).</span></button>
      <p class="field-error" id="rs-error" role="alert" hidden></p></div>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button>`,
  });
  modal.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-catch]');
    if (!b) return;
    const catchUp = b.dataset.catch === 'true';
    try {
      await resumeRecurring(schedule.id, catchUp);
      modal.close();
      toast(catchUp ? 'Resumed. Missed dates were recorded.' : 'Resumed. Missed dates were skipped.', 'success');
      if (onDone) onDone();
    } catch (err) { const box = $('#rs-error', modal.el); box.hidden = false; box.textContent = err.message; }
  });
  return modal;
}

const OCC_TONE = { GENERATED: 'success', SKIPPED: 'neutral', FAILED: 'danger' };
const OCC_LABEL = { GENERATED: 'Generated', SKIPPED: 'Skipped', FAILED: 'Failed' };

export function openHistoryDialog({ schedule, onViewTransaction }) {
  const modal = openModal({ title: `${schedule.title} · ${describeFrequency(schedule)}`, size: 'lg', body: skeletonRows(3, 44) });
  const load = async () => {
    modal.setBody(skeletonRows(3, 44));
    try {
      const d = await getOccurrences(schedule.id);
      const s = d.schedule;
      modal.setBody(html`<div class="grid gap-5">
        <section><h3 class="card-title" style="margin-bottom:8px">Upcoming</h3>${d.upcoming.length
          ? html`<div class="rc-upcoming">${d.upcoming.map((u) => badge(u.scheduledDate, 'accent'))}</div>${s.status === 'paused' ? html`<p class="field-hint" style="color:rgb(var(--warning));margin-top:6px">Paused: these will not be recorded until you resume.</p>` : ''}`
          : html`<p class="card-sub">${s.status === 'completed' ? 'This schedule has finished.' : 'Nothing upcoming.'}</p>`}</section>
        <section><h3 class="card-title" style="margin-bottom:8px">Occurrence history</h3>${d.history.length
          ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Scheduled</th><th scope="col" class="hidden sm:table-cell">Generated</th><th scope="col" class="num">Amount</th><th scope="col">Status</th><th scope="col">Transaction / reason</th></tr></thead><tbody>
            ${d.history.map((h) => html`<tr><td class="tabular" style="white-space:nowrap"><b>${h.scheduledDate}</b></td><td class="hidden sm:table-cell card-sub">${h.generatedAt ? String(h.generatedAt).slice(0, 10) : '–'}</td><td class="num"><b>৳${fmt(h.amount)}</b></td><td>${badge(OCC_LABEL[h.status], OCC_TONE[h.status])}</td>
              <td class="card-sub">${h.status === 'GENERATED' ? (h.transactionId ? html`<button type="button" class="link" data-view-tx>View transaction</button>` : 'Transaction was deleted') : h.error || ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="card-sub">Nothing has been recorded by this schedule yet.</p>`}</section></div>`);
      modal.el.querySelectorAll('[data-view-tx]').forEach((b) => b.addEventListener('click', () => { modal.close(); onViewTransaction(schedule.title); }));
    } catch (err) {
      logError('recurring:history', err);
      modal.setBody(errorState({ error: err, title: 'Could not load the history' }));
      modal.body.querySelector('[data-action="retry"]')?.addEventListener('click', load, { once: true });
    }
  };
  load();
  return modal;
}
