import { html, render, $, money, fmt2, isoToday, isoLastDayOfMonth, toIsoDate } from '../../core/dom.js';
import { emit } from '../../core/events.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, button, select, input, badge, categoryOptions, statCard, icon } from '../../components/ui.js';
import { searchBar, bindSearch } from '../../components/searchBar.js';
import { filterPanel, bindFilterPanel, setFilterCount } from '../../components/filterPanel.js';
import { pagination, bindPagination } from '../../components/pagination.js';
import { skeletonRows, skeletonBlock } from '../../components/skeleton.js';
import { emptyState, errorState } from '../../components/states.js';
import { mountWidget } from '../../components/widget.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { toast, toastError } from '../../components/toast.js';
import { listTransactions, deleteTransaction, getMonthSummary } from './transactionService.js';
import { openTransactionModal } from './transactionModal.js';

const LIMIT = 10;
const SORTS = [['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['amount-desc', 'Amount: high to low'], ['amount-asc', 'Amount: low to high']];
const DATE_PRESETS = [['ALL', 'All dates'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom range']];
const DEFAULTS = { type: 'ALL', category: 'ALL', sort: 'date-desc', datePreset: 'ALL', dateFrom: '', dateTo: '', minAmount: '', maxAmount: '' };

function resolveDates(f) {
  const today = new Date();
  if (f.datePreset === 'today') return { dateFrom: isoToday(), dateTo: isoToday() };
  if (f.datePreset === 'week') {
    const monday = new Date(today);
    monday.setDate(today.getDate() + (today.getDay() === 0 ? -6 : 1 - today.getDay()));
    return { dateFrom: toIsoDate(monday), dateTo: isoToday() };
  }
  if (f.datePreset === 'month') return { dateFrom: toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)), dateTo: isoLastDayOfMonth() };
  if (f.datePreset === 'custom') return { dateFrom: f.dateFrom || undefined, dateTo: f.dateTo || undefined };
  return {};
}

const activeFilterCount = (f) => ['type', 'category', 'datePreset', 'minAmount', 'maxAmount'].filter((k) => f[k] !== DEFAULTS[k]).length;

const row = (t) => html`<tr>
  <td class="tabular" style="color:rgb(var(--mute));white-space:nowrap">${t.date}</td>
  <td><div class="tx-desc"><span class="truncate-1">${t.description}</span>
    ${t.notes ? html`<i class="fa-solid fa-note-sticky meta-icon" title="${t.notes}" aria-label="Has notes"></i>` : ''}
    ${t.isRecurring ? html`<i class="fa-solid fa-repeat meta-icon recurring-icon" title="Created by a recurring schedule" aria-label="Recurring"></i>` : ''}</div></td>
  <td>${badge(t.category)}</td>
  <td>${badge(t.type === 'INCOME' ? 'Income' : 'Expense', t.type === 'INCOME' ? 'success' : 'danger')}</td>
  <td class="num tx-amount ${t.type === 'INCOME' ? 'text-income' : 'text-expense'}">${t.type === 'INCOME' ? '+' : '-'}৳${fmt2(t.amount)}</td>
  <td><div class="tx-actions">
    ${button({ iconOnly: true, icon: 'pen', variant: 'ghost', size: 'sm', label: `Edit ${t.description}`, action: 'edit', attrs: { 'data-id': t.id } })}
    ${button({ iconOnly: true, icon: 'trash-can', variant: 'ghost', size: 'sm', label: `Delete ${t.description}`, action: 'delete', attrs: { 'data-id': t.id } })}</div></td>
</tr>`;

const mobileCard = (t) => html`<div class="tx-card">
  <div class="flex items-center gap-3" style="min-width:0"><span class="tx-icon ${t.type === 'INCOME' ? 'is-income' : 'is-expense'}">${icon(t.type === 'INCOME' ? 'arrow-down' : 'arrow-up')}</span>
    <div style="min-width:0"><p class="text-sm font-bold truncate-1">${t.description}${t.isRecurring ? html` <i class="fa-solid fa-repeat meta-icon recurring-icon" aria-label="Recurring"></i>` : ''}</p>
      <p class="card-sub">${t.category} · ${t.date}</p></div></div>
  <div style="text-align:right;flex-shrink:0"><p class="tx-amount ${t.type === 'INCOME' ? 'text-income' : 'text-expense'}">${t.type === 'INCOME' ? '+' : '-'}৳${fmt2(t.amount)}</p>
    <div class="tx-actions">${button({ iconOnly: true, icon: 'pen', variant: 'ghost', size: 'sm', label: `Edit ${t.description}`, action: 'edit', attrs: { 'data-id': t.id } })}
    ${button({ iconOnly: true, icon: 'trash-can', variant: 'ghost', size: 'sm', label: `Delete ${t.description}`, action: 'delete', attrs: { 'data-id': t.id } })}</div></div>
</div>`;

export default {
  styles: [new URL('./transactions.css', import.meta.url).href],

  mount(ctx) {
    const state = { search: ctx.query.search || '', ...DEFAULTS, page: 1 };
    let items = [];
    let requestId = 0;

    render(ctx.outlet, html`
      ${pageHeader({ title: 'Transactions', subtitle: 'Search, filter and manage every income and expense entry.', actions: button({ label: 'Add transaction', icon: 'plus', action: 'add' }) })}
      <div class="grid gap-6">
        <div id="tx-summary"></div>
        <div class="tx-toolbar">
          ${searchBar({ id: 'tx-search', value: state.search, placeholder: 'Search description, category or notes…', label: 'Search transactions' })}
          ${select({ id: 'tx-sort', options: SORTS, value: state.sort, attrs: { 'aria-label': 'Sort transactions' } })}
          ${filterPanel({ id: 'tx-filter-panel', activeCount: 0, content: html`
            <div class="tx-filters">
              ${select({ id: 'tx-f-type', label: 'Type', options: [['ALL', 'All types'], ['INCOME', 'Income only'], ['EXPENSE', 'Expense only']], value: state.type })}
              ${select({ id: 'tx-f-category', label: 'Category', options: categoryOptions([['ALL', 'All categories']]), value: state.category })}
              ${select({ id: 'tx-date-preset', label: 'Date', options: DATE_PRESETS, value: state.datePreset })}
              <div class="field" data-custom-dates ${state.datePreset === 'custom' ? '' : 'hidden'} style="grid-column:span 2"><div class="grid gap-3 sm:grid-cols-2">
                ${input({ id: 'tx-date-from', label: 'From', type: 'date' })}${input({ id: 'tx-date-to', label: 'To', type: 'date' })}</div></div>
              ${input({ id: 'tx-min', label: 'Min amount (৳)', type: 'number', attrs: { min: 0, step: '0.01', inputmode: 'decimal' } })}
              ${input({ id: 'tx-max', label: 'Max amount (৳)', type: 'number', attrs: { min: 0, step: '0.01', inputmode: 'decimal' } })}
              ${button({ label: 'Reset filters', icon: 'rotate-left', variant: 'secondary', action: 'reset' })}
            </div>` })}
        </div>
        <section class="card card-pad" aria-labelledby="tx-list-title">
          <div class="card-head"><h2 class="card-title" id="tx-list-title">All transactions</h2><span class="card-sub" id="tx-count" aria-live="polite"></span></div>
          <div id="tx-list"></div>
        </section>
      </div>`);

    const listEl = $('#tx-list', ctx.outlet);
    const countEl = $('#tx-count', ctx.outlet);

    // ----- summary widget (independent of the list: either can fail without affecting the other) -----
    const reloadSummary = mountWidget(ctx, $('#tx-summary', ctx.outlet), {
      title: 'This month summary',
      skeleton: html`<div class="tx-summary">${[0, 1, 2].map(() => skeletonBlock(84))}</div>`,
      load: getMonthSummary,
      render: (s, el) => render(el, html`<div class="tx-summary">
        ${statCard({ label: 'Income this month', value: money(s.totalIncome), tone: 'text-income' })}
        ${statCard({ label: 'Expenses this month', value: money(s.totalExpense), tone: 'text-expense' })}
        ${statCard({ label: 'Net this month', value: money(s.balance), tone: s.balance < 0 ? 'text-expense' : '' })}
      </div>`),
    });

    // ----- list -----
    const params = () => {
      const p = { sort: state.sort, page: state.page, limit: LIMIT };
      if (state.search) p.search = state.search;
      if (state.type !== 'ALL') p.type = state.type;
      if (state.category !== 'ALL') p.category = state.category;
      Object.assign(p, resolveDates(state));
      if (state.minAmount !== '') p.minAmount = state.minAmount;
      if (state.maxAmount !== '') p.maxAmount = state.maxAmount;
      return p;
    };
    const filtersOn = () => !!state.search || activeFilterCount(state) > 0;

    function draw({ transactions, pagination: pg }) {
      items = transactions;
      countEl.textContent = `${pg.total} ${pg.total === 1 ? 'transaction' : 'transactions'}`;
      if (!transactions.length) {
        render(listEl, filtersOn()
          ? emptyState({ icon: 'filter-circle-xmark', title: 'No transactions match', text: 'Try changing or clearing your search and filters.', actions: button({ label: 'Reset filters', variant: 'secondary', action: 'reset' }) })
          : emptyState({ icon: 'receipt', title: 'No transactions yet', text: 'Add your first income or expense to start tracking.', actions: button({ label: 'Add transaction', icon: 'plus', action: 'add' }) }));
        return;
      }
      render(listEl, html`
        <div class="table-wrap hidden md:block"><table class="data-table"><thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Category</th><th scope="col">Type</th><th scope="col" class="num">Amount</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${transactions.map(row)}</tbody></table></div>
        <div class="tx-cards md:hidden">${transactions.map(mobileCard)}</div>
        ${pagination({ page: pg.page, totalPages: pg.totalPages, total: pg.total, limit: pg.limit, noun: 'transactions' })}`);
    }

    async function loadList() {
      const mine = ++requestId;
      render(listEl, skeletonRows(6, 48));
      setFilterCount(ctx.outlet, 'tx-filter-panel', activeFilterCount(state));
      try {
        const data = await ctx.alive(listTransactions(params()));
        if (mine === requestId) draw(data);
      } catch (err) {
        if (err instanceof StaleError || mine !== requestId) return;
        logError('transactions:list', err);
        countEl.textContent = '';
        render(listEl, errorState({ error: err, title: 'Could not load transactions' }));
      }
    }
    ctx.on(listEl, 'click', '[data-action="retry"]', () => loadList());

    const afterChange = () => { emit('data:changed', { scope: 'transactions' }); reloadSummary(); loadList(); };

    // ----- filters -----
    function readFilters() {
      const v = (id) => $(`#${id}`, ctx.outlet).value;
      Object.assign(state, { type: v('tx-f-type'), category: v('tx-f-category'), sort: v('tx-sort'), datePreset: v('tx-date-preset'), dateFrom: v('tx-date-from'), dateTo: v('tx-date-to'), minAmount: v('tx-min'), maxAmount: v('tx-max'), page: 1 });
      $('[data-custom-dates]', ctx.outlet).hidden = state.datePreset !== 'custom';
      loadList();
    }
    ctx.on(ctx.outlet, 'change', '#tx-f-type, #tx-f-category, #tx-sort, #tx-date-preset, #tx-date-from, #tx-date-to', readFilters);
    let amountTimer;
    ctx.on(ctx.outlet, 'input', '#tx-min, #tx-max', () => { clearTimeout(amountTimer); amountTimer = setTimeout(readFilters, 400); });
    ctx.onCleanup(() => clearTimeout(amountTimer));
    ctx.onCleanup(bindSearch(ctx.outlet, '#tx-search', (text) => { state.search = text; state.page = 1; loadList(); }, { signal: ctx.signal }));
    bindFilterPanel(ctx.outlet, { signal: ctx.signal });
    bindPagination(ctx.outlet, (p) => { state.page = p; loadList(); }, { signal: ctx.signal });

    // ----- actions -----
    ctx.on(ctx.outlet, 'click', '[data-action]', async (e, el) => {
      const action = el.dataset.action;
      if (action === 'add') openTransactionModal({ onSaved: afterChange });
      else if (action === 'edit') {
        const t = items.find((x) => x.id === el.dataset.id);
        if (t) openTransactionModal({ transaction: t, onSaved: afterChange });
      } else if (action === 'delete') {
        const t = items.find((x) => x.id === el.dataset.id);
        const ok = await confirmDialog({ title: 'Delete transaction?', message: t ? `“${t.description}” (${money(t.amount)}) will be permanently removed. This cannot be undone.` : 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try {
          await deleteTransaction(el.dataset.id);
          if (items.length === 1 && state.page > 1) state.page -= 1; // do not strand the user on an empty page
          toast('Transaction deleted.', 'info');
          afterChange();
        } catch (err) { toastError(err); }
      } else if (action === 'reset') {
        Object.assign(state, DEFAULTS, { search: '', page: 1 });
        $('#tx-search', ctx.outlet).value = '';
        ['tx-f-type:type', 'tx-f-category:category', 'tx-sort:sort', 'tx-date-preset:datePreset'].forEach((p) => { const [id, k] = p.split(':'); $(`#${id}`, ctx.outlet).value = state[k]; });
        ['tx-date-from', 'tx-date-to', 'tx-min', 'tx-max'].forEach((id) => { $(`#${id}`, ctx.outlet).value = ''; });
        $('[data-custom-dates]', ctx.outlet).hidden = true;
        loadList();
      }
    });

    loadList();
  },
};
