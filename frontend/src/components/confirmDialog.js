import { html } from '../core/dom.js';
import { openModal } from './modal.js';

// await confirmDialog({ title, message, confirmLabel, danger }) -> true | false. Replaces window.confirm().
// Dangerous actions put initial focus on Cancel so Enter can't delete by accident.
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const modal = openModal({
      title,
      size: 'sm',
      body: html`<p class="state-text" style="max-width:none;text-align:left">${message}</p>`,
      footer: html`<button type="button" class="btn btn-secondary" data-confirm="no">${cancelLabel}</button>
        <button type="button" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-confirm="yes">${confirmLabel}</button>`,
      initialFocus: danger ? '[data-confirm="no"]' : '[data-confirm="yes"]',
      onClose: () => resolve(answer),
    });
    modal.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-confirm]');
      if (!b) return;
      answer = b.dataset.confirm === 'yes';
      modal.close();
    });
  });
}
