import { html, on } from '../core/dom.js';

// pagination({ page, totalPages, total, limit }) + bindPagination(root, (page) => ...)
export function pagination({ page = 1, totalPages = 1, total = 0, limit = 10, noun = 'items' } = {}) {
  if (!total) return html``;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return html`<nav class="flex flex-wrap items-center justify-between gap-3 pt-4" aria-label="Pagination">
    <p class="card-sub" aria-live="polite">Showing ${from}–${to} of ${total} ${noun}</p>
    <div class="flex items-center gap-2">
      <button type="button" class="btn btn-outline btn-sm" data-page-go="${page - 1}" ${page <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left" aria-hidden="true"></i><span>Prev</span></button>
      <span class="card-sub tabular" aria-current="page">Page ${page} of ${totalPages}</span>
      <button type="button" class="btn btn-outline btn-sm" data-page-go="${page + 1}" ${page >= totalPages ? 'disabled' : ''}><span>Next</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
    </div></nav>`;
}

export const bindPagination = (root, onChange, options) =>
  on(root, 'click', '[data-page-go]', (e, el) => { const p = Number(el.dataset.pageGo); if (p >= 1) onChange(p); }, options);
