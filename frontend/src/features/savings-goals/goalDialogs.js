import { html, $, todayEarliest, todayLatest, fmt } from '../../core/dom.js';
import { logError } from '../../core/logger.js';
import { openModal } from '../../components/modal.js';
import { input, select, textarea } from '../../components/ui.js';
import { skeletonRows } from '../../components/skeleton.js';
import { errorState } from '../../components/states.js';
import { toast } from '../../components/toast.js';
import { createGoal, updateGoal, addContribution, getContributions } from './goalService.js';

// The three goal dialogs: create/edit a goal, add money (a contribution), and the contribution history.

export const GOAL_ICONS = [['fa-piggy-bank', 'Piggy bank'], ['fa-laptop', 'Laptop'], ['fa-shield-halved', 'Emergency fund'], ['fa-plane', 'Travel'], ['fa-car', 'Car'], ['fa-house', 'Home'], ['fa-graduation-cap', 'Education']];

function wireErrors(form, prefix, names) {
  const setError = (name, message) => {
    const el = $(`#${prefix}-${name}`, form); const err = $(`#${prefix}-${name}-error`, form);
    if (!el || !err) return;
    err.hidden = !message; err.textContent = message || '';
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  };
  names.forEach((n) => $(`#${prefix}-${n}`, form)?.addEventListener('input', () => setError(n, '')));
  const apply = (errors) => { names.forEach((n) => setError(n, errors[n])); const first = names.find((n) => errors[n]); if (first) $(`#${prefix}-${first}`, form).focus(); return !first; };
  return { setError, apply };
}

async function submitWith(modal, btnId, run, errorBoxId, form) {
  const btn = $(btnId, modal.el);
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try { await run(); } catch (err) { const box = $(errorBoxId, form); box.hidden = false; box.textContent = err.message; } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}

export function openGoalFormModal({ goal = null, onSaved } = {}) {
  const g = goal;
  const modal = openModal({
    title: g ? 'Edit savings goal' : 'New savings goal',
    body: html`<form id="gf-form" novalidate class="grid gap-4">
      ${input({ id: 'gf-title', label: 'Goal name', value: g ? g.title : '', placeholder: 'e.g. Emergency fund', required: true, attrs: { maxlength: 100 } })}
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'gf-target', label: 'Target amount (৳)', type: 'number', value: g ? g.targetAmount : '', required: true, attrs: { step: '0.01', min: '0.01', inputmode: 'decimal' } })}
        ${g ? '' : input({ id: 'gf-saved', label: 'Already saved (৳)', type: 'number', optional: true, hint: 'Counts as your starting balance.', attrs: { step: '0.01', min: '0', inputmode: 'decimal' } })}
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        ${input({ id: 'gf-date', label: 'Target date', type: 'date', value: g && g.targetDate ? g.targetDate : '', optional: true, attrs: g ? {} : { min: todayLatest() } })}
        ${input({ id: 'gf-category', label: 'Category', value: g && g.category ? g.category : '', optional: true, placeholder: 'e.g. Education', attrs: { maxlength: 50 } })}
      </div>
      ${textarea({ id: 'gf-description', label: 'Description', value: g && g.description ? g.description : '', optional: true, maxlength: 300 })}
      ${select({ id: 'gf-icon', label: 'Icon', options: GOAL_ICONS, value: g ? g.icon : 'fa-piggy-bank' })}
      <p class="field-error" id="gf-form-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="gf-form" id="gf-submit">${g ? 'Save changes' : 'Create goal'}</button>`,
  });
  const form = $('#gf-form', modal.el);
  const names = g ? ['title', 'target'] : ['title', 'target', 'saved'];
  const { apply } = wireErrors(form, 'gf', names);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      title: $('#gf-title', form).value.trim(),
      targetAmount: parseFloat($('#gf-target', form).value),
      targetDate: $('#gf-date', form).value || null,
      category: $('#gf-category', form).value.trim() || null,
      description: $('#gf-description', form).value.trim() || null,
      icon: $('#gf-icon', form).value,
    };
    const errors = {};
    if (!payload.title) errors.title = 'Give the goal a name.';
    if (!(payload.targetAmount > 0)) errors.target = 'Enter a target greater than 0.';
    if (!g) {
      const saved = parseFloat($('#gf-saved', form).value);
      if (saved > 0) { if (saved > payload.targetAmount) errors.saved = 'Already saved cannot be more than the target.'; else payload.savedAmount = saved; }
    }
    if (!apply(errors)) return;
    submitWith(modal, '#gf-submit', async () => {
      if (g) await updateGoal(g.id, payload); else await createGoal(payload);
      modal.close();
      toast(g ? 'Goal updated.' : 'Goal created.', 'success');
      if (onSaved) onSaved();
    }, '#gf-form-error', form);
  });
  return modal;
}

export function openContributionModal({ goal, onSaved }) {
  const modal = openModal({
    title: `Add money to ${goal.title}`,
    size: 'sm',
    body: html`<form id="gc-form" novalidate class="grid gap-4">
      ${input({ id: 'gc-amount', label: 'Amount (৳)', type: 'number', required: true, placeholder: '0.00', attrs: { step: '0.01', min: '0.01', inputmode: 'decimal' } })}
      ${input({ id: 'gc-date', label: 'Date', type: 'date', value: todayEarliest(), attrs: { max: todayEarliest() } })}
      ${input({ id: 'gc-note', label: 'Note', optional: true, attrs: { maxlength: 200 } })}
      <p class="field-hint">Contributions are allocations of money you already have, so they do not change your income or expense totals.</p>
      <p class="field-error" id="gc-form-error" role="alert" hidden></p>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary" form="gc-form" id="gc-submit">Add contribution</button>`,
  });
  const form = $('#gc-form', modal.el);
  const { apply } = wireErrors(form, 'gc', ['amount']);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseFloat($('#gc-amount', form).value);
    if (!apply(amount > 0 ? {} : { amount: 'Enter an amount greater than 0.' })) return;
    submitWith(modal, '#gc-submit', async () => {
      const res = await addContribution(goal.id, { amount, date: $('#gc-date', form).value || undefined, note: $('#gc-note', form).value.trim() || undefined });
      modal.close();
      toast(`Added ৳${fmt(amount)} to ${res.goal.title}.`, 'success');
      if (onSaved) onSaved();
    }, '#gc-form-error', form);
  });
  return modal;
}

export function openHistoryModal({ goal }) {
  const modal = openModal({ title: `${goal.title}: contribution history`, body: skeletonRows(3, 44), size: 'md' });
  const load = async () => {
    modal.setBody(skeletonRows(3, 44));
    try {
      const { contributions } = await getContributions(goal.id);
      modal.setBody(contributions.length
        ? html`<ul class="grid gap-2" style="list-style:none;padding:0;margin:0">${contributions.map((c) => html`<li class="tile flex items-start justify-between gap-3"><div style="min-width:0"><p class="text-sm font-bold">${c.date}</p>${c.note ? html`<p class="card-sub" style="word-break:break-word">${c.note}</p>` : ''}</div><span class="font-extrabold text-income tabular" style="flex-shrink:0">+৳${fmt(c.amount)}</span></li>`)}</ul>`
        : html`<p class="state-text" style="margin:24px auto">No contributions yet.</p>`);
    } catch (err) {
      logError('goals:history', err);
      modal.setBody(errorState({ error: err, title: 'Could not load the history' }));
      modal.body.querySelector('[data-action="retry"]')?.addEventListener('click', load, { once: true });
    }
  };
  load();
  return modal;
}

