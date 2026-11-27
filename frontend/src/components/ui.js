import { html, raw, esc } from '../core/dom.js';
import { CATEGORIES } from '../core/config.js';

// Presentational building blocks. Each returns safe HTML (see core/dom.js) styled by styles/components.css,
// so every page gets identical buttons, fields, badges, cards and progress bars.

// attribute object -> ' a="x" b' (values escaped; true = bare attribute; false/null/undefined skipped)
export const attrs = (obj = {}) => raw(Object.entries(obj)
  .filter(([, v]) => v !== false && v !== null && v !== undefined)
  .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join(''));

export const icon = (name, extra = '') => html`<i class="fa-solid fa-${name} ${extra}" aria-hidden="true"></i>`;

// ----- Button -----
// button({ label, icon, variant: primary|secondary|outline|ghost|danger, size: sm, action, type, attrs, ariaLabel, tooltip })
export function button({ label = '', icon: ic, variant = 'primary', size = '', type = 'button', action, disabled = false, ariaLabel, tooltip, iconOnly = false, attrs: extra = {} } = {}) {
  const cls = `btn btn-${variant}${size ? ` btn-${size}` : ''}${iconOnly ? ' btn-icon' : ''}`;
  return html`<button type="${type}" class="${cls}"${attrs({ 'data-action': action, disabled, 'aria-label': ariaLabel || (iconOnly ? label : undefined), 'data-tooltip': tooltip, ...extra })}>${ic ? icon(ic) : ''}${iconOnly ? '' : html`<span>${label}</span>`}</button>`;
}

// ----- Form fields -----
const fieldWrap = (id, label, optional, control, hint, error) => html`
  <div class="field">
    ${label ? html`<label class="label" for="${id}">${label}${optional ? html` <span class="opt">optional</span>` : ''}</label>` : ''}
    ${control}
    ${hint ? html`<p class="field-hint" id="${id}-hint">${hint}</p>` : ''}
    <p class="field-error" id="${id}-error" role="alert" ${error ? '' : 'hidden'}>${error || ''}</p>
  </div>`;

export function input({ id, name = id, label, type = 'text', value = '', placeholder = '', required = false, optional = false, hint, error, icon: ic, attrs: extra = {} } = {}) {
  const control = html`<input class="input" id="${id}" name="${name}" type="${type}" value="${value ?? ''}"${attrs({ placeholder, required, 'aria-required': required || undefined, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': error ? `${id}-error` : (hint ? `${id}-hint` : undefined), ...extra })}>`;
  return fieldWrap(id, label, optional, ic ? html`<div class="input-icon">${icon(ic)}${control}</div>` : control, hint, error);
}

// Date picker: the platform's accessible native date control, styled consistently (min/max supported).
export const dateField = (opts) => input({ ...opts, type: 'date' });

export function select({ id, name = id, label, options = [], value, required = false, optional = false, hint, error, attrs: extra = {} } = {}) {
  const control = html`<select class="select" id="${id}" name="${name}"${attrs({ required, 'aria-invalid': error ? 'true' : undefined, ...extra })}>${options.map(([v, l]) => html`<option value="${v}"${v === value ? raw(' selected') : ''}>${l}</option>`)}</select>`;
  return fieldWrap(id, label, optional, control, hint, error);
}

export function textarea({ id, name = id, label, value = '', rows = 2, maxlength, placeholder = '', optional = false, hint, attrs: extra = {} } = {}) {
  const control = html`<textarea class="textarea" id="${id}" name="${name}" rows="${rows}"${attrs({ maxlength, placeholder, ...extra })}>${value ?? ''}</textarea>`;
  return fieldWrap(id, label, optional, control, hint);
}

export const categoryOptions = (extra = []) => [...extra, ...CATEGORIES];

// Segmented two-way control (e.g. Expense / Income). Pages listen for [data-seg].
export const segmented = ({ name, items, value }) => html`<div class="seg" role="group" data-seg-group="${name}">${items.map(([v, l]) => html`<button type="button" data-seg="${name}" data-value="${v}" aria-pressed="${String(v === value)}">${l}</button>`)}</div>`;

// Filter chips / tabs. items: [{ value, label, disabled, title }]
export const chipGroup = ({ name, items, value, label }) => html`<div class="chips" role="group" aria-label="${label || name}">${items.map((it) => html`<button type="button" class="chip" data-chip="${name}" data-value="${it.value}" aria-pressed="${String(it.value === value)}"${attrs({ disabled: it.disabled, title: it.title })}>${it.label}</button>`)}</div>`;

// ----- Data display -----
export const badge = (text, tone = 'neutral', extra = '') => html`<span class="badge${tone === 'neutral' ? '' : ` badge-${tone}`} ${extra}">${text}</span>`;

export function progressBar({ value, max = 100, tone = '', label = 'Progress' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return html`<div class="progress ${tone ? `is-${tone}` : ''}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct}%"></span></div>`;
}

// card({ title, subtitle, action: SafeHtml, body: SafeHtml, pad, id, className })
export function card({ title, subtitle, action, body, pad = true, id, className = '' } = {}) {
  return html`<section class="card ${pad ? 'card-pad' : ''} ${className}"${attrs({ id })}>
    ${title || action ? html`<header class="card-head"><div>${title ? html`<h3 class="card-title">${title}</h3>` : ''}${subtitle ? html`<p class="card-sub">${subtitle}</p>` : ''}</div>${action || ''}</header>` : ''}
    ${body}
  </section>`;
}

export const cardLink = (href, text = 'View all') => html`<a class="card-link" href="${href}">${text} ${icon('arrow-right', 'text-[10px]')}</a>`;

export const pageHeader = ({ title, subtitle, actions }) => html`<header class="page-header">
  <div><h1 class="page-title" id="page-title">${title}</h1>${subtitle ? html`<p class="page-sub">${subtitle}</p>` : ''}</div>
  ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
</header>`;

export const statTile = ({ label, value, sub, tone = '' }) => html`<div class="tile"><div class="eyebrow">${label}</div><div class="stat-value ${tone}">${value}</div>${sub ? html`<div class="card-sub">${sub}</div>` : ''}</div>`;

// A single-metric card (label, big number, optional caption). Use this instead of nesting a tile inside a card.
export const statCard = ({ label, value, sub, tone = '', id, icon: ic, iconTone = '' }) => html`<div class="card card-pad stat"${attrs({ id })}><div class="stat-top"><div class="stat-label">${label}</div>${ic ? html`<span class="stat-icon ${iconTone}">${icon(ic)}</span>` : ''}</div><div class="stat-value ${tone}">${value}</div>${sub ? html`<div class="card-sub">${sub}</div>` : ''}</div>`;
