import { html, render } from '../core/dom.js';

// toast('Saved', 'success' | 'error' | 'info'). Announced to screen readers (errors assertively), auto-dismiss, click to dismiss.
let region;
const ICONS = { success: 'circle-check', error: 'circle-xmark', info: 'circle-info' };

function getRegion() {
  if (region && document.body.contains(region)) return region;
  region = document.createElement('div');
  region.className = 'toast-region';
  region.setAttribute('aria-live', 'polite');
  region.id = 'toast-region';
  document.body.appendChild(region);
  return region;
}

export function toast(message, type = 'success', { duration } = {}) {
  const host = getRegion();
  const el = document.createElement('div');
  el.className = `toast is-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  render(el, html`<i class="fa-solid fa-${ICONS[type] || ICONS.info}" aria-hidden="true"></i><span>${message}</span>`);
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  const remove = () => el.remove();
  el.addEventListener('click', remove);
  setTimeout(remove, duration || (type === 'error' ? 6000 : 3800));
  return el;
}
export const toastError = (err, fallback = 'Something went wrong.') => toast(err && err.message ? err.message : fallback, 'error');
