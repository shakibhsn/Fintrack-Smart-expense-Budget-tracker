import { html } from '../core/dom.js';

// Loading placeholders. They are visually distinct from "empty": a shimmering block, never a stale zero.
const wrap = (inner, label = 'Loading') => html`<div role="status" aria-busy="true" aria-label="${label}">${inner}</div>`;

export const skeletonBlock = (height = 80, extra = '') => html`<div class="skeleton ${extra}" style="height:${height}px" aria-hidden="true"></div>`;
export const skeletonCards = (count = 3, height = 120, gridClass = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3') =>
  wrap(html`<div class="${gridClass}">${Array.from({ length: count }, () => skeletonBlock(height))}</div>`);
export const skeletonRows = (rows = 5, height = 44) =>
  wrap(html`<div class="grid gap-2">${Array.from({ length: rows }, () => skeletonBlock(height))}</div>`);
export const skeletonText = (lines = 3) =>
  wrap(html`<div class="grid gap-2">${Array.from({ length: lines }, (_, i) => skeletonBlock(14, i === lines - 1 ? 'w-2/3' : ''))}</div>`);

// whole-page fallback used by the router while a page's code is loading
export const pageSkeleton = () => wrap(html`<div class="grid gap-4">${skeletonBlock(36, 'w-1/3')}<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">${Array.from({ length: 4 }, () => skeletonBlock(96))}</div>${skeletonBlock(280)}</div>`, 'Loading page');
