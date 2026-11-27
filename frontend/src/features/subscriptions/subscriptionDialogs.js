import { html, $, isoToday } from '../../core/dom.js';
import { logError } from '../../core/logger.js';
import { openModal } from '../../components/modal.js';
import { input, select, textarea, badge } from '../../components/ui.js';
import { skeletonRows } from '../../components/skeleton.js';
import { errorState } from '../../components/states.js';
import { toast } from '../../components/toast.js';
import { createSubscription, updateSubscription, getSubscription, recordPayment, CATEGORIES, CURRENCIES, FREQUENCIES, frequencyLabel, moneyIn } from './subscriptionService.js';

const STATUS_TONE = { active: 'success', paused: 'warning', cancelled: 'danger', expired: 'neutral' };
export const statusBadge = (s) => badge(s.status[0].toUpperCase() + s.status.slice(1), STATUS_TONE[s.status] || 'neutral');

// Create / edit. "Next renewal" is optional on create: if blank it is worked out from the start date and billing cycle.
export function openSubscriptionForm({ subscription = null, onSaved }) {
  const s = subscription;
  const modal = openModal({
    title: s ? 'Edit subscription' : 'Add subscription',
    body: html`<form id="sb-form" novalidate class="grid gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'sb-name', label: 'Subscription name', value: s ? s.name : '', placeholder: 'e.g. Video streaming', required: true, attrs: { maxlength: 100 } })}
        ${input({ id: 'sb-provider', label: 'Provider / service', value: s && s.provider ? s.provider : '', optional: true, attrs: { maxlength: 100 } })}
      </div>
      <div class="grid gap-4 sm:grid-cols-3">
        ${select({ id: 'sb-category', label: 'Category', options: CATEGORIES.map((c) => [c, c]), value: s ? s.category : 'Entertainment', required: true })}
        ${input({ id: 'sb-amount', label: 'Amount', type: 'number', value: s ? s.amount : '', placeholder: '0.00', required: true, attrs: { step: '0.01', min: '0.01', inputmode: 'decimal' } })}
        ${select({ id: 'sb-currency', label: 'Currency', options: CURRENCIES.map((c) => [c, c]), value: s ? s.currency : 'BDT' })}
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        ${select({ id: 'sb-frequency', label: 'Billing frequency', options: FREQUENCIES, value: s ? s.frequency : 'MONTHLY', required: true })}
        <div id="sb-custom-wrap" ${s && s.frequency === 'CUSTOM' ? '' : 'hidden'}>${input({ id: 'sb-interval', label: 'Every how many days?', type: 'number', value: s && s.customIntervalDays ? s.customIntervalDays : '', attrs: { min: 1, max: 3650, step: 1 } })}</div>
      </div>
      <div class="grid gap-4 sm:grid-cols-3">
        ${input({ id: 'sb-start', label: 'Start date', type: 'date', value: s ? s.startDate : isoToday(), required: true })}
        ${input({ id: 'sb-next', label: 'Next renewal', type: 'date', value: s && s.nextRenewalDate ? s.nextRenewalDate : '', optional: true })}
        ${input({ id: 'sb-end', label: 'End date', type: 'date', value: s && s.endDate ? s.endDate : '', optional: true })}
      </div>
      <p class="field-hint">Leave “Next renewal” empty to calculate it from the start date and billing cycle. Month-end dates (29th–31st) renew on the last day of shorter months.</p>
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'sb-method', label: 'Payment method', value: s && s.paymentMethod ? s.paymentMethod : '', optional: true, attrs: { maxlength: 60 } })}
        ${input({ id: 'sb-reminder', label: 'Remind me (days before)', type: 'number', value: s && s.reminderDays !== null && s.reminderDays !== undefined ? s.reminderDays : '', optional: true, hint: 'Empty = your default in notification preferences.', attrs: { min: 0, max: 60 } })}
      </div>
      ${textarea({ id: 'sb-notes', label: 'Notes', value: s && s.notes ? s.notes : '', maxlength: 500, optional: true })}
      <label class="flex items-start gap-2 text-sm" style="padding:12px;border-radius:var(--r-md);background:rgb(var(--surface-2))"><input type="checkbox" class="switch" role="switch" id="sb-auto" style="margin-top:3px" ${s && s.autoRecord ? 'checked' : ''}><span><b>Record each payment as an expense automatically</b> on its renewal date. Off by default: a renewal is only recorded when you confirm it. Only for your account currency.</span></label>
      <p class="field-error" id="sb-form-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="sb-form" id="sb-submit">${s ? 'Save changes' : 'Add subscription'}</button>`,
  });
  const form = $('#sb-form', modal.el);
  const names = ['name', 'amount', 'interval', 'start', 'end'];
  const setError = (n, m) => { const el = $(`#sb-${n}`, form); const err = $(`#sb-${n}-error`, form); if (!el || !err) return; err.hidden = !m; err.textContent = m || ''; if (m) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); };
  names.forEach((n) => $(`#sb-${n}`, form).addEventListener('input', () => setError(n, '')));
  $('#sb-frequency', form).addEventListener('change', (e) => { $('#sb-custom-wrap', form).hidden = e.target.value !== 'CUSTOM'; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => $(`#sb-${id}`, form).value.trim();
    const payload = {
      name: v('name'), provider: v('provider') || null, category: v('category'), amount: Number(v('amount')), currency: v('currency'), frequency: v('frequency'),
      customIntervalDays: v('frequency') === 'CUSTOM' ? Number(v('interval')) || null : null, startDate: v('start'), endDate: v('end') || null,
      paymentMethod: v('method') || null, notes: v('notes') || null, autoRecord: $('#sb-auto', form).checked, reminderDays: v('reminder') === '' ? null : Number(v('reminder')),
    };
    if (v('next')) payload.nextRenewalDate = v('next');
    const errors = {};
    if (!payload.name) errors.name = 'Give it a name.';
    if (!(payload.amount > 0)) errors.amount = 'Enter an amount greater than 0.';
    if (payload.frequency === 'CUSTOM' && !payload.customIntervalDays) errors.interval = 'Enter the interval in days.';
    if (!payload.startDate) errors.start = 'Choose a start date.';
    if (payload.endDate && payload.startDate && payload.endDate < payload.startDate) errors.end = 'The end date must be on or after the start date.';
    names.forEach((n) => setError(n, errors[n]));
    const first = names.find((n) => errors[n]);
    if (first) { $(`#sb-${first}`, form).focus(); return; }
    const btn = $('#sb-submit', modal.el); btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
    try {
      let warnings = [];
      if (s) await updateSubscription(s.id, payload); else ({ warnings } = await createSubscription(payload));
      modal.close();
      toast(s ? 'Subscription updated.' : 'Subscription added.', 'success');
      warnings.forEach((w) => toast(w, 'info'));
      if (onSaved) onSaved();
    } catch (err) { const box = $('#sb-form-error', form); box.hidden = false; box.textContent = err.message; } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
  });
  return modal;
}

// Confirm a renewal payment (never assumed). Records one payment, optionally one linked expense, and moves to the next renewal.
export function openPaymentDialog({ subscription: s, onDone }) {
  const sameCurrency = s.currency === 'BDT';
  const modal = openModal({
    title: `Record renewal: ${s.name}`, size: 'sm',
    body: html`<form id="sp-form" novalidate class="grid gap-4">
      <p class="text-sm">Confirm that <b>${moneyIn(s.amount, s.currency)}</b> was paid for the renewal due <b>${s.nextRenewalDate}</b>.</p>
      ${input({ id: 'sp-date', label: 'Date paid', type: 'date', value: isoToday() })}
      ${sameCurrency ? html`<label class="flex items-start gap-2 text-sm"><input type="checkbox" id="sp-tx" checked style="margin-top:3px"><span>Also record it as an expense (counted once in your analytics).</span></label>` : html`<p class="field-hint">This subscription is in ${s.currency}, so no expense is created (your transactions are in BDT). The payment is still kept in its history.</p>`}
      <p class="field-error" id="sp-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="sp-form" id="sp-submit">Confirm payment</button>`,
  });
  const form = $('#sp-form', modal.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#sp-submit', modal.el); btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
    try {
      await recordPayment(s.id, { paidDate: $('#sp-date', form).value || undefined, recordTransaction: sameCurrency ? $('#sp-tx', form).checked : false });
      modal.close(); toast('Payment recorded.', 'success'); if (onDone) onDone();
    } catch (err) { const box = $('#sp-error', form); box.hidden = false; box.textContent = err.message; } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
  });
  return modal;
}

export function openDetailsDialog({ subscription: s0 }) {
  const modal = openModal({ title: s0.name, size: 'lg', body: skeletonRows(3, 44) });
  const load = async () => {
    modal.setBody(skeletonRows(3, 44));
    try {
      const s = await getSubscription(s0.id);
      const row = (k, v) => html`<div class="tile"><div class="eyebrow">${k}</div><div class="text-sm font-bold" style="word-break:break-word">${v}</div></div>`;
      modal.setBody(html`<div class="grid gap-5">
        <div class="flex flex-wrap items-center gap-2">${statusBadge(s)}${badge(s.category)}${s.autoRecord ? badge('Auto-records payments', 'brand') : ''}</div>
        <div class="grid gap-3 sm:grid-cols-3">${row('Price', `${moneyIn(s.amount, s.currency)} · ${frequencyLabel(s)}`)}${row('Estimated monthly', html`${moneyIn(s.estimate.monthly, s.currency)} <span class="sb-est">ESTIMATE</span>`)}${row('Estimated yearly', html`${moneyIn(s.estimate.yearly, s.currency)} <span class="sb-est">ESTIMATE</span>`)}
          ${row('Next renewal', s.nextRenewalDate ? `${s.nextRenewalDate}${s.daysUntilRenewal !== null ? ` (${s.daysUntilRenewal < 0 ? `${-s.daysUntilRenewal} days ago, not confirmed` : s.daysUntilRenewal === 0 ? 'today' : `in ${s.daysUntilRenewal} days`})` : ''}` : 'None')}${row('Start / end', `${s.startDate} → ${s.endDate || 'no end date'}`)}${row('Provider / payment method', `${s.provider || '–'} · ${s.paymentMethod || '–'}`)}</div>
        ${s.notes ? html`<p class="card-sub" style="word-break:break-word">${s.notes}</p>` : ''}
        <section><h3 class="card-title" style="margin-bottom:8px">Payment history <span class="sb-est" style="background:rgb(var(--brand-500)/.12);color:rgb(var(--brand-text))">ACTUAL</span></h3>${s.payments.length
          ? html`<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Renewal</th><th scope="col" class="num">Amount</th><th scope="col">Status</th><th scope="col">How</th></tr></thead><tbody>${s.payments.map((p) => html`<tr><td class="tabular"><b>${p.dueDate}</b></td><td class="num"><b>${moneyIn(p.amount, p.currency)}</b></td><td>${badge(p.status === 'PAID' ? 'Paid' : 'Skipped', p.status === 'PAID' ? 'success' : 'neutral')}</td><td class="card-sub">${p.source === 'AUTO' ? 'Auto-recorded' : 'Confirmed by you'}${p.transactionId ? ' · expense recorded' : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="card-sub">No payments recorded yet. A renewal is only recorded when you confirm it.</p>`}</section></div>`);
    } catch (err) {
      logError('subscriptions:details', err);
      modal.setBody(errorState({ error: err, title: 'Could not load the details' }));
      modal.body.querySelector('[data-action="retry"]')?.addEventListener('click', load, { once: true });
    }
  };
  load();
  return modal;
}
