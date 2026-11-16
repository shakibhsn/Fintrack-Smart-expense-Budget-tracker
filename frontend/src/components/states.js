import { html, on } from '../core/dom.js';
import { friendlyMessage } from '../core/logger.js';

// Empty and error states. A failed request shows an error (with Retry), never an empty-looking page.

export function emptyState({ icon = 'inbox', title, text, actions } = {}) {
  return html`<div class="state"><div class="state-icon"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></div>
    <h3 class="state-title">${title}</h3>${text ? html`<p class="state-text">${text}</p>` : ''}
    ${actions ? html`<div class="state-actions">${actions}</div>` : ''}</div>`;
}

// errorState({ error, title, retry: true, home: false })  - retry buttons carry data-action="retry"
export function errorState({ error, title = 'Could not load this section', retry = true, home = false } = {}) {
  return html`<div class="state is-error" role="alert"><div class="state-icon"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i></div>
    <h3 class="state-title">${title}</h3><p class="state-text">${friendlyMessage(error)}</p>
    <div class="state-actions">
      ${retry ? html`<button type="button" class="btn btn-primary btn-sm" data-action="retry"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>Try again</span></button>` : ''}
      ${home ? html`<a class="btn btn-secondary btn-sm" href="#/dashboard"><i class="fa-solid fa-house" aria-hidden="true"></i><span>Go to dashboard</span></a>` : ''}
    </div></div>`;
}

// Wires the Retry buttons inside `root` to `fn`.
export const bindRetry = (root, fn, options) => on(root, 'click', '[data-action="retry"]', () => fn(), options);
