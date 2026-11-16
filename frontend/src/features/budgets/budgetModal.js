import { html, $, isoToday, isoLastDayOfMonth } from '../../core/dom.js';
import { openModal } from '../../components/modal.js';
import { input, select, categoryOptions } from '../../components/ui.js';
import { toast } from '../../components/toast.js';
import { createBudget, updateBudget } from './budgetService.js';

// Create / edit a budget: a category, a spending limit and its OWN date range (not locked to a calendar month).
export function openBudgetModal({ budget = null, onSaved } = {}) {
  const b = budget;
  const modal = openModal({
    title: b ? 'Edit budget' : 'Create budget',
    body: html`<form id="bg-form" novalidate class="grid gap-4">
      ${select({ id: 'bg-category', label: 'Category', options: categoryOptions(), value: b ? b.category : 'Food', required: true })}
      ${input({ id: 'bg-limit', label: 'Budget limit (৳)', type: 'number', value: b ? b.limit : '', placeholder: '10000', required: true, attrs: { step: '0.01', min: '0.01', inputmode: 'decimal' } })}
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'bg-start', label: 'Start date', type: 'date', value: b ? b.startDate : isoToday(), required: true })}
        ${input({ id: 'bg-end', label: 'End date', type: 'date', value: b ? b.endDate : isoLastDayOfMonth(), required: true })}
      </div>
      <p class="field-hint">Two budgets for the same category cannot overlap in time.</p>
      <p class="field-error" id="bg-form-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="bg-form" id="bg-submit">${b ? 'Save changes' : 'Create budget'}</button>`,
  });
  const form = $('#bg-form', modal.el);
  const setError = (name, message) => {
    const el = $(`#bg-${name}`, form); const err = $(`#bg-${name}-error`, form);
    err.hidden = !message; err.textContent = message || '';
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  };
  ['limit', 'start', 'end'].forEach((n) => $(`#bg-${n}`, form).addEventListener('input', () => { setError('limit', ''); setError('start', ''); setError('end', ''); }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      category: $('#bg-category', form).value,
      limit: parseFloat($('#bg-limit', form).value),
      startDate: $('#bg-start', form).value,
      endDate: $('#bg-end', form).value,
    };
    const errors = {};
    if (!(payload.limit > 0)) errors.limit = 'Enter a limit greater than 0.';
    if (!payload.startDate) errors.start = 'Choose a start date.';
    if (!payload.endDate) errors.end = 'Choose an end date.';
    if (payload.startDate && payload.endDate && payload.endDate < payload.startDate) errors.end = 'The end date must be on or after the start date.';
    ['limit', 'start', 'end'].forEach((n) => setError(n, errors[n]));
    if (Object.keys(errors).length) { $(`#bg-${Object.keys(errors)[0]}`, form).focus(); return; }

    const btn = $('#bg-submit', modal.el);
    btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
    try {
      if (b) await updateBudget(b.id, payload); else await createBudget(payload);
      modal.close();
      toast(b ? 'Budget updated.' : 'Budget created.', 'success');
      if (onSaved) onSaved();
    } catch (err) {
      const box = $('#bg-form-error', form);
      box.hidden = false; box.textContent = err.message;
    } finally {
      btn.removeAttribute('aria-busy'); btn.disabled = false;
    }
  });
  return modal;
}
