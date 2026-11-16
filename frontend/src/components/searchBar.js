import { html, debounce } from '../core/dom.js';

// searchBar({ id, value, placeholder, label }) + bindSearch(root, '#id', (text) => ..., { delay, signal })
export const searchBar = ({ id, value = '', placeholder = 'Search…', label = 'Search' }) => html`<div class="input-icon">
  <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
  <input class="input" type="search" id="${id}" value="${value}" placeholder="${placeholder}" aria-label="${label}" autocomplete="off">
</div>`;

export function bindSearch(root, selector, onChange, { delay = 300, signal } = {}) {
  const el = root.querySelector(selector);
  if (!el) return () => {};
  const fire = debounce(() => onChange(el.value.trim()), delay);
  el.addEventListener('input', fire, { signal });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { fire.cancel(); onChange(el.value.trim()); } }, { signal });
  return () => fire.cancel();
}
