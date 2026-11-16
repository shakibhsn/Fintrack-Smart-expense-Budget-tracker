import { html, render, fmt } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { navigate } from '../../core/router.js';
import { pageHeader, button, badge, card } from '../../components/ui.js';
import { emptyState } from '../../components/states.js';
import { skeletonCards } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { listRecurring, pauseRecurring, deleteRecurring } from './recurringService.js';
import { openRecurringForm, openResumeDialog, openHistoryDialog, describeFrequency } from './recurringDialogs.js';

const STATUS = { active: ['Active', 'success'], paused: ['Paused', 'warning'], completed: ['Completed', 'neutral'] };

const scheduleCard = (r) => {
  const income = r.type === 'INCOME';
  const [statusLabel, statusTone] = STATUS[r.status];
  return html`<article class="card card-pad rc-card" data-recurring="${r.id}" aria-label="${r.title}">
    <div class="rc-head"><div style="min-width:0"><h3 class="card-title truncate-1">${r.title}</h3><p class="card-sub">${r.category} · ${describeFrequency(r)}</p></div>
      <div><div class="rc-amount ${income ? 'text-income' : 'text-expense'}">${income ? '+' : '-'}৳${fmt(r.amount)}</div><div style="text-align:right">${badge(statusLabel, statusTone)}</div></div></div>
    <div class="rc-facts"><div class="tile"><div class="eyebrow">Next</div><div class="v">${r.nextOccurrence || '–'}</div></div><div class="tile"><div class="eyebrow">Ends</div><div class="v">${r.endDate || 'Never'}</div></div><div class="tile"><div class="eyebrow">Recorded</div><div class="v">${r.generatedCount}</div></div></div>
    ${r.failedCount ? html`<p class="text-xs text-expense" style="font-weight:700"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${r.failedCount} ${r.failedCount === 1 ? 'date' : 'dates'} could not be recorded. It will be retried automatically.</p>` : ''}
    ${r.scheduleNote ? html`<p class="card-sub">${r.scheduleNote}</p>` : ''}
    <div class="rc-actions">
      ${button({ label: 'History', icon: 'clock-rotate-left', variant: 'secondary', size: 'sm', action: 'history', attrs: { 'data-id': r.id } })}
      ${button({ label: 'Edit', icon: 'pen', variant: 'secondary', size: 'sm', action: 'edit', attrs: { 'data-id': r.id } })}
      ${r.status === 'active' ? button({ label: 'Pause', icon: 'pause', variant: 'secondary', size: 'sm', action: 'pause', attrs: { 'data-id': r.id } }) : ''}
      ${r.status === 'paused' ? button({ label: 'Resume', icon: 'play', variant: 'secondary', size: 'sm', action: 'resume', attrs: { 'data-id': r.id } }) : ''}
      ${button({ label: 'Delete', icon: 'trash-can', variant: 'danger', size: 'sm', action: 'delete', attrs: { 'data-id': r.id } })}
    </div></article>`;
};

export default {
  styles: [new URL('./recurring.css', import.meta.url).href],

  mount(ctx) {
    let items = [];
    let prevCounts = null;
    render(ctx.outlet, html`
      ${pageHeader({ title: 'Recurring Transactions', subtitle: 'Income and expenses that repeat on a schedule. The server records them automatically on their date, so you do not need to keep this page or the app open. Dates are UTC calendar days.', actions: button({ label: 'New recurring', icon: 'plus', action: 'add' }) })}
      <div id="rc-body"></div>`);

    const reload = mountWidget(ctx, ctx.outlet.querySelector('#rc-body'), {
      title: 'Recurring transactions',
      skeleton: skeletonCards(2, 190, 'grid gap-4 sm:grid-cols-2'),
      load: listRecurring,
      render: (list, el) => {
        items = list;
        // The server also processes anything due while answering this request; if it created transactions, tell the shell.
        const counts = Object.fromEntries(list.map((x) => [x.id, x.generatedCount]));
        if (prevCounts && list.some((x) => (counts[x.id] || 0) > (prevCounts[x.id] || 0))) emit('data:changed', { scope: 'transactions' });
        prevCounts = counts;
        render(el, list.length
          ? html`<div class="rc-grid">${list.map(scheduleCard)}</div>`
          : card({ body: emptyState({ icon: 'repeat', title: 'No recurring transactions yet', text: 'Add things like salary, rent, bills or subscriptions once, and FinTrack records them for you on their dates.', actions: button({ label: 'New recurring', icon: 'plus', action: 'add' }) }) }));
      },
    });

    const afterChange = () => { emit('data:changed', { scope: 'transactions' }); emit('notifications:changed'); reload(); };
    ctx.on(ctx.outlet, 'click', '[data-action]', async (e, el) => {
      const s = items.find((x) => x.id === el.dataset.id);
      switch (el.dataset.action) {
        case 'add': openRecurringForm({ onSaved: afterChange }); break;
        case 'edit': if (s) openRecurringForm({ schedule: s, onSaved: afterChange }); break;
        case 'history': if (s) openHistoryDialog({ schedule: s, onViewTransaction: (title) => navigate(`/transactions?search=${encodeURIComponent(title)}`) }); break;
        case 'resume': if (s) openResumeDialog({ schedule: s, onDone: afterChange }); break;
        case 'pause':
          try { await pauseRecurring(el.dataset.id); toast('Paused. Nothing will be recorded until you resume it.', 'success'); reload(); } catch (err) { toastError(err); }
          break;
        case 'delete': {
          if (!s) break;
          if (!(await confirmDialog({ title: 'Delete recurring transaction?', message: `Nothing more will be recorded for “${s.title}”. Transactions it already created stay in your list.`, confirmLabel: 'Delete', danger: true }))) break;
          try { await deleteRecurring(s.id); toast('Deleted. Existing transactions were kept.', 'success'); afterChange(); } catch (err) { toastError(err); }
          break;
        }
        default: break;
      }
    });
  },
};
