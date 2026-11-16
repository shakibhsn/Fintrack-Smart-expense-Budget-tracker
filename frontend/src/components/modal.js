import { html, render } from '../core/dom.js';

// Accessible modal: role=dialog + aria-modal, labelled by its title, focus moves in and is trapped, Escape and a
// backdrop click close it, focus returns to whatever opened it, and the page behind stops scrolling.
// The router closes every open modal on navigation so none can leak across pages.

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const stack = [];
let uid = 0;

const lockScroll = () => { document.body.style.overflow = stack.length ? 'hidden' : ''; };

export function openModal({ title, body, footer, size = 'md', dismissable = true, onClose, initialFocus } = {}) {
  const id = `modal-title-${++uid}`;
  const opener = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  render(backdrop, html`<div class="modal modal-${size}" role="dialog" aria-modal="true" aria-labelledby="${id}">
    <div class="modal-head"><h2 class="modal-title" id="${id}">${title}</h2>
      ${dismissable ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-modal-close aria-label="Close dialog"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : ''}</div>
    <div class="modal-body" data-modal-body></div>
    ${footer ? html`<div class="modal-foot" data-modal-foot></div>` : ''}
  </div>`);
  const dialog = backdrop.querySelector('.modal');
  const bodyEl = backdrop.querySelector('[data-modal-body]');
  const footEl = backdrop.querySelector('[data-modal-foot]');
  const setContent = (el, c) => { if (c instanceof Node) { el.replaceChildren(c); } else { render(el, c); } };
  setContent(bodyEl, body);
  if (footEl) setContent(footEl, footer);

  let closed = false;
  const modal = {
    el: dialog,
    body: bodyEl,
    setBody: (c) => setContent(bodyEl, c),
    close(result) {
      if (closed) return;
      closed = true;
      backdrop.remove();
      const i = stack.indexOf(modal);
      if (i >= 0) stack.splice(i, 1);
      lockScroll();
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
      if (onClose) onClose(result);
    },
  };
  modal.dismissable = dismissable;

  backdrop.addEventListener('mousedown', (e) => { if (dismissable && e.target === backdrop) modal.close(); });
  backdrop.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) modal.close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); modal.close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  document.body.appendChild(backdrop);
  stack.push(modal);
  lockScroll();
  const target = (initialFocus && dialog.querySelector(initialFocus)) || dialog.querySelector('input:not([type="hidden"]),select,textarea') || dialog.querySelector('[data-modal-close]') || dialog;
  if (!target.hasAttribute('tabindex') && target === dialog) dialog.setAttribute('tabindex', '-1');
  target.focus();
  return modal;
}

export function closeAllModals() {
  [...stack].forEach((m) => m.close());
}
export const hasOpenModal = () => stack.length > 0;
