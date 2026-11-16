// Small DOM/template helpers shared by every feature.

// ---- Safe HTML templates --------------------------------------------------------------------
// html`...` escapes every interpolated value UNLESS it is itself the result of html`` (or raw()).
// So user-supplied text (descriptions, category names, notes...) can never inject markup, and nested
// templates/arrays compose naturally:  html`<ul>${items.map((i) => html`<li>${i.name}</li>`)}</ul>`
class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
export const raw = (s) => new SafeHtml(String(s ?? ''));
const part = (v) => {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
};
export const html = (strings, ...values) => {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < values.length) out += part(values[i]); });
  return new SafeHtml(out);
};
export const render = (el, content) => { el.innerHTML = String(content); return el; };

// ---- Querying -------------------------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Delegated listener: on(root, 'click', '[data-action]', (event, matchedEl) => ...). Returns an unsubscribe fn.
// Pass { signal } to have it removed automatically with the page.
export function on(root, type, selector, handler, options = {}) {
  const listener = (e) => {
    const target = e.target instanceof Element ? e.target.closest(selector) : null;
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

// ---- Formatting -----------------------------------------------------------------------------
export const fmt = (n) => Number(n || 0).toLocaleString('en-US');
export const fmt2 = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const money = (n) => `${Number(n) < 0 ? '-' : ''}৳${fmt2(Math.abs(Number(n) || 0))}`;
export const pad2 = (n) => String(n).padStart(2, '0');
// Local-date YYYY-MM-DD (what <input type="date"> uses).
export const toIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const isoToday = () => toIsoDate(new Date());
// The server works in UTC days, the browser in local days. For people ahead of UTC (e.g. Bangladesh, UTC+6) the local date can be
// a day ahead of the server's. Use these when a date must not be in the future / the past from the SERVER's point of view:
export const todayEarliest = () => { const u = new Date().toISOString().slice(0, 10); const l = isoToday(); return u < l ? u : l; }; // safe as a MAX ("not in the future")
export const todayLatest = () => { const u = new Date().toISOString().slice(0, 10); const l = isoToday(); return u > l ? u : l; };   // safe as a MIN ("not in the past")
export const isoLastDayOfMonth = () => { const d = new Date(); return toIsoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function timeAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// ---- Timing ---------------------------------------------------------------------------------
export function debounce(fn, ms = 250) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
