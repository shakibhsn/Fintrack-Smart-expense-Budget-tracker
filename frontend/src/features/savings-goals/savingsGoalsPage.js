import { html, render, fmt, money } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { pageHeader, button, badge, progressBar, card, statCard } from '../../components/ui.js';
import { emptyState } from '../../components/states.js';
import { skeletonBlock, skeletonCards } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { listGoals, getGoalsSummary, deleteGoal } from './goalService.js';
import { GOAL_STATUS, dueText } from './goalStatus.js';
import { openGoalFormModal, openContributionModal, openHistoryModal } from './goalDialogs.js';

const goalCard = (g) => {
  const st = GOAL_STATUS[g.status];
  const pct = Math.round(g.progress);
  return html`<article class="card card-pad goal-card" aria-label="${g.title}">
    <div class="goal-head">
      <div class="flex items-center gap-3 goal-title"><span class="icon-chip"><i class="fa-solid ${g.icon}" aria-hidden="true"></i></span>
        <div style="min-width:0"><h3 class="card-title truncate-1">${g.title}</h3><p class="card-sub truncate-1">${g.category ? `${g.category} · ` : ''}Target ৳${fmt(g.targetAmount)}</p></div></div>
      <div class="flex items-center gap-1" style="flex-shrink:0">
        ${button({ iconOnly: true, icon: 'pen', variant: 'ghost', size: 'sm', label: `Edit ${g.title}`, action: 'edit', attrs: { 'data-id': g.id } })}
        ${button({ iconOnly: true, icon: 'trash-can', variant: 'ghost', size: 'sm', label: `Delete ${g.title}`, action: 'delete', attrs: { 'data-id': g.id } })}</div>
    </div>
    <div class="goal-meta">${badge(st.label, st.tone)}<span>${dueText(g)}</span></div>
    ${g.description ? html`<p class="card-sub" style="word-break:break-word">${g.description}</p>` : ''}
    <div class="grid gap-2">
      <div class="flex justify-between"><span class="text-sm font-extrabold tabular">৳${fmt(g.savedAmount)} saved</span><span class="text-sm font-bold" style="color:rgb(var(--brand-text))">${pct}%</span></div>
      ${progressBar({ value: pct, tone: st.bar, label: `${g.title} progress` })}
      <div class="goal-foot"><span>Remaining: ৳${fmt(g.remaining)}</span>${g.excess > 0 ? html`<span class="text-income" style="font-weight:700">৳${fmt(g.excess)} above target</span>` : ''}</div>
    </div>
    <div class="goal-actions">
      ${button({ label: 'Add money', icon: 'plus', variant: 'secondary', size: 'sm', action: 'contribute', attrs: { 'data-id': g.id } })}
      ${button({ label: `History (${g.contributionCount ?? 0})`, icon: 'clock-rotate-left', variant: 'secondary', size: 'sm', action: 'history', attrs: { 'data-id': g.id } })}
    </div>
  </article>`;
};

export default {
  styles: [new URL('./savings-goals.css', import.meta.url).href],

  mount(ctx) {
    let goals = [];
    render(ctx.outlet, html`
      ${pageHeader({ title: 'Savings Goals', subtitle: 'Track your progress towards the things you are saving for.', actions: button({ label: 'New goal', icon: 'plus', action: 'add' }) })}
      <div class="grid gap-6"><div id="goal-summary"></div><div id="goal-list"></div></div>`);

    const reloadSummary = mountWidget(ctx, ctx.outlet.querySelector('#goal-summary'), {
      title: 'Goals summary',
      skeleton: html`<div class="goal-summary">${[0, 1, 2, 3].map(() => skeletonBlock(84))}</div>`,
      load: getGoalsSummary,
      render: (s, el) => {
        if (!s.totalCount) { render(el, ''); return; }
        render(el, html`<div class="goal-summary">
          ${statCard({ label: 'Total saved', value: money(s.totalSaved) })}
          ${statCard({ label: 'Active goals', value: s.activeCount, sub: s.activeCount ? `${s.activeProgress}% of ৳${fmt(s.activeTarget)} saved` : '' })}
          ${statCard({ label: 'Completed', value: s.completedCount })}
          ${statCard({ label: 'Overdue', value: s.overdueCount, tone: s.overdueCount ? 'text-expense' : '' })}
        </div>`);
      },
    });

    const reloadList = mountWidget(ctx, ctx.outlet.querySelector('#goal-list'), {
      title: 'Savings goals',
      skeleton: skeletonCards(3, 230),
      load: listGoals,
      render: (list, el) => {
        goals = list;
        render(el, goals.length
          ? html`<div class="goal-grid">${goals.map(goalCard)}</div>`
          : card({ body: emptyState({ icon: 'piggy-bank', title: 'No savings goals yet', text: 'Create a goal, then add contributions to watch your progress grow.', actions: button({ label: 'New goal', icon: 'plus', action: 'add' }) }) }));
      },
    });

    const afterChange = () => { emit('data:changed', { scope: 'goals' }); emit('notifications:changed'); reloadSummary(); reloadList(); };
    ctx.on(ctx.outlet, 'click', '[data-action]', async (e, el) => {
      const goal = goals.find((x) => x.id === el.dataset.id);
      switch (el.dataset.action) {
        case 'add': openGoalFormModal({ onSaved: afterChange }); break;
        case 'edit': if (goal) openGoalFormModal({ goal, onSaved: afterChange }); break;
        case 'contribute': if (goal) openContributionModal({ goal, onSaved: afterChange }); break;
        case 'history': if (goal) openHistoryModal({ goal }); break;
        case 'delete': {
          if (!goal) break;
          const ok = await confirmDialog({ title: 'Delete savings goal?', message: `“${goal.title}” and its ${goal.contributionCount ?? 0} contribution(s) will be deleted. This cannot be undone.`, confirmLabel: 'Delete goal', danger: true });
          if (!ok) break;
          try { await deleteGoal(goal.id); toast('Goal deleted.', 'info'); afterChange(); } catch (err) { toastError(err); }
          break;
        }
        default: break;
      }
    });
  },
};
