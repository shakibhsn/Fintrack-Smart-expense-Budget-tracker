import { html, render, fmt, money } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { pageHeader, button, badge, progressBar, card } from '../../components/ui.js';
import { emptyState } from '../../components/states.js';
import { skeletonBlock, skeletonCards } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { getBudgetSummary, deleteBudget } from './budgetService.js';
import { tierOf, TIERS } from './budgetTiers.js';
import { openBudgetModal } from './budgetModal.js';

const STATUS = { active: ['Active', 'brand'], upcoming: ['Upcoming', 'accent'], ended: ['Ended', 'neutral'] };

const budgetCard = (b) => {
  const tier = tierOf(b); const t = TIERS[tier];
  const [statusLabel, statusTone] = STATUS[b.status] || [b.status, 'neutral'];
  return html`<article class="card card-pad bg-card is-${tier}" aria-label="${b.category} budget">
    <div class="bg-card-head">
      <div class="flex items-center gap-3"><span class="icon-chip"><i class="fa-solid fa-receipt" aria-hidden="true"></i></span>
        <div><h3 class="card-title">${b.category}</h3>${badge(statusLabel, statusTone)}</div></div>
      <div class="flex items-center gap-1">
        ${button({ iconOnly: true, icon: 'pen', variant: 'ghost', size: 'sm', label: `Edit ${b.category} budget`, action: 'edit', attrs: { 'data-id': b.id } })}
        ${button({ iconOnly: true, icon: 'trash-can', variant: 'ghost', size: 'sm', label: `Delete ${b.category} budget`, action: 'delete', attrs: { 'data-id': b.id } })}
      </div>
    </div>
    <p class="card-sub">${b.startDate} → ${b.endDate}</p>
    <div class="bg-amounts"><span class="font-extrabold tabular">৳${fmt(b.spent)} <span class="card-sub" style="font-weight:500">of ৳${fmt(b.limit)}</span></span>
      <span class="card-sub ${b.isOverBudget ? 'text-expense' : ''}" style="font-weight:700">${b.isOverBudget ? `Over by ৳${fmt(b.overBy)}` : `৳${fmt(b.remaining)} left`}</span></div>
    ${progressBar({ value: Math.min(b.percentage, 100), tone: t.bar, label: `${b.category} budget used` })}
    <div class="flex items-center justify-between">${badge(`${b.percentage}% used · ${t.label}`, t.tone)}</div>
  </article>`;
};

export default {
  styles: [new URL('./budgets.css', import.meta.url).href],

  mount(ctx) {
    let budgets = [];
    render(ctx.outlet, html`
      ${pageHeader({ title: 'Budgets', subtitle: 'Set spending limits for any date range and see how you are tracking.', actions: button({ label: 'Create budget', icon: 'plus', action: 'add' }) })}
      <div class="grid gap-6"><div id="bg-content"></div></div>`);

    const reload = mountWidget(ctx, ctx.outlet.querySelector('#bg-content'), {
      title: 'Budgets',
      skeleton: html`<div class="grid gap-6">${skeletonBlock(150)}${skeletonCards(3, 170)}</div>`,
      load: getBudgetSummary,
      render: (s, el) => {
        budgets = s.budgets;
        const overview = card({ body: html`<div class="bg-overview">
          <div class="bg-overview-top">
            <div><div class="eyebrow">Active budgets overview</div><div class="bg-big">${money(s.totalSpent)} <span class="card-sub" style="font-size:var(--text-base);font-weight:600">of ${money(s.totalLimit)}</span></div>
              <div class="card-sub">${s.activeCount} active of ${s.totalCount} ${s.totalCount === 1 ? 'budget' : 'budgets'}</div></div>
            <div style="text-align:right"><div class="eyebrow">Remaining</div><div class="stat-value">${money(s.totalRemaining)}</div></div>
          </div>
          ${progressBar({ value: Math.min(s.percentage, 100), tone: s.percentage > 100 ? 'danger' : s.percentage >= 90 ? 'warning' : '', label: 'Total budget used' })}
          <div class="flex justify-between card-sub" style="font-weight:700"><span>${s.percentage}% used</span><span>${Math.max(100 - s.percentage, 0)}% remaining</span></div>
        </div>` });
        render(el, html`<div class="grid gap-6">${overview}${budgets.length
          ? html`<div class="bg-grid">${budgets.map(budgetCard)}</div>`
          : card({ body: emptyState({ icon: 'bullseye', title: 'No budgets yet', text: 'Create a budget to set a spending limit for a category and track it against your real transactions.', actions: button({ label: 'Create budget', icon: 'plus', action: 'add' }) }) })}</div>`);
      },
    });

    const afterChange = () => { emit('data:changed', { scope: 'budgets' }); emit('notifications:changed'); reload(); };
    ctx.on(ctx.outlet, 'click', '[data-action]', async (e, el) => {
      const a = el.dataset.action;
      if (a === 'add') openBudgetModal({ onSaved: afterChange });
      else if (a === 'edit') openBudgetModal({ budget: budgets.find((b) => b.id === el.dataset.id), onSaved: afterChange });
      else if (a === 'delete') {
        const b = budgets.find((x) => x.id === el.dataset.id);
        const ok = await confirmDialog({ title: 'Delete budget?', message: b ? `The ${b.category} budget (${b.startDate} → ${b.endDate}) will be removed. Your transactions are not affected.` : 'Your transactions are not affected.', confirmLabel: 'Delete budget', danger: true });
        if (!ok) return;
        try { await deleteBudget(el.dataset.id); toast('Budget deleted.', 'info'); afterChange(); } catch (err) { toastError(err); }
      }
    });
  },
};
