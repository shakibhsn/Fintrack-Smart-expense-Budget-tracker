import { html, $, isoToday } from '../../core/dom.js';
import { openModal } from '../../components/modal.js';
import { input, select, textarea, segmented, categoryOptions } from '../../components/ui.js';
import { toast } from '../../components/toast.js';
import { createTransaction, updateTransaction } from './transactionService.js';

// Add / edit transaction dialog. Used by the Transactions page AND the global "Add transaction" button in the top bar.
// openTransactionModal({ transaction?, onSaved })

const FIELDS = ['amount', 'category', 'date', 'description'];

export function openTransactionModal({ transaction = null, onSaved } = {}) {
  const t = transaction;
  let type = t ? t.type : 'EXPENSE';
  const modal = openModal({
    title: t ? 'Edit transaction' : 'Add transaction',
    body: html`<form id="tx-form" novalidate class="grid gap-4">
      ${segmented({ name: 'tx-type', value: type, items: [['EXPENSE', 'Expense'], ['INCOME', 'Income']] })}
      ${input({ id: 'tx-amount', label: 'Amount (৳)', type: 'number', value: t ? t.amount : '', placeholder: '0.00', required: true, attrs: { step: '0.01', min: '0.01', inputmode: 'decimal' } })}
      <div class="grid gap-4 sm:grid-cols-2">
        ${select({ id: 'tx-category', label: 'Category', options: categoryOptions(), value: t ? t.category : 'Food', required: true })}
        ${input({ id: 'tx-date', label: 'Date', type: 'date', value: t ? t.date : isoToday(), required: true })}
      </div>
      ${input({ id: 'tx-description', label: 'Description / merchant', value: t ? t.description : '', placeholder: 'e.g. Grocery store, Uber, Salary', required: true, attrs: { maxlength: 200 } })}
      ${textarea({ id: 'tx-notes', label: 'Notes', value: t && t.notes ? t.notes : '', maxlength: 500, optional: true, placeholder: 'Anything worth remembering' })}
      <p class="field-error" id="tx-form-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="tx-form" id="tx-submit">${t ? 'Save changes' : 'Add transaction'}</button>`,
  });
  const form = $('#tx-form', modal.el);

  const setError = (name, message) => {
    const el = $(`#tx-${name}`, form); const err = $(`#tx-${name}-error`, form);
    if (!el || !err) return;
    err.hidden = !message; err.textContent = message || '';
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  };
  FIELDS.forEach((n) => $(`#tx-${n}`, form).addEventListener('input', () => setError(n, '')));

  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg="tx-type"]');
    if (!b) return;
    type = b.dataset.value;
    form.querySelectorAll('[data-seg="tx-type"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      type,
      amount: parseFloat($('#tx-amount', form).value),
      category: $('#tx-category', form).value,
      date: $('#tx-date', form).value,
      description: $('#tx-description', form).value.trim(),
      notes: $('#tx-notes', form).value.trim(),
    };
    const errors = {};
    if (!(payload.amount > 0)) errors.amount = 'Enter an amount greater than 0.';
    if (!payload.date) errors.date = 'Choose a date.';
    if (!payload.description) errors.description = 'Add a short description.';
    FIELDS.forEach((n) => setError(n, errors[n]));
    if (Object.keys(errors).length) { $(`#tx-${Object.keys(errors)[0]}`, form).focus(); return; }

    const btn = $('#tx-submit', modal.el);
    btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
    try {
      if (t) await updateTransaction(t.id, payload); else await createTransaction(payload);
      modal.close();
      toast(t ? 'Transaction updated.' : 'Transaction added.', 'success');
      if (onSaved) onSaved();
    } catch (err) {
      const box = $('#tx-form-error', form);
      box.hidden = false; box.textContent = err.message;
    } finally {
      btn.removeAttribute('aria-busy'); btn.disabled = false;
    }
  });
  return modal;
}
