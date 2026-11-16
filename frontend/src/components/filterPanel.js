import { html, on } from '../core/dom.js';

// A collapsible panel for advanced filters. filterPanel({ id, activeCount, open, content })
//  - bindFilterPanel(root, { signal }) toggles it (the button gets aria-expanded / aria-controls)
//  - setFilterCount(root, id, n) updates the "n active filters" badge without re-rendering the inputs
export const filterPanel = ({ id, title = 'Filters', activeCount = 0, open = false, content }) => html`<div>
  <button type="button" class="btn btn-outline" data-filter-toggle="${id}" aria-expanded="${String(open)}" aria-controls="${id}">
    <i class="fa-solid fa-sliders" aria-hidden="true"></i><span>${title}</span><span class="badge badge-brand" data-filter-count="${id}" ${activeCount ? '' : 'hidden'}>${activeCount}</span>
  </button>
  <div id="${id}" class="card card-pad mt-3" ${open ? '' : 'hidden'}>${content}</div>
</div>`;

export const bindFilterPanel = (root, options) => on(root, 'click', '[data-filter-toggle]', (e, btn) => {
  const panel = root.querySelector(`#${btn.dataset.filterToggle}`);
  if (!panel) return;
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}, options);

export function setFilterCount(root, id, n) {
  const badge = root.querySelector(`[data-filter-count="${id}"]`);
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = !n;
}
