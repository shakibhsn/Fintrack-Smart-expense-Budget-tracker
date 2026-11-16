// In-page UI audit used by ui.test.js: contrast (WCAG AA, text over the real composited background), controls without an accessible name,
// duplicate ids, headings, horizontal overflow, light backgrounds in dark mode, tiny touch targets on phones. Runs inside the browser page.
const inPage = () => {
  const out = { contrast: [], unlabeled: [], dupIds: [], lightInDark: [], tiny: [], noH1: false, h1s: 0, overflow: document.documentElement.scrollWidth - innerWidth, imgNoAlt: 0 };
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return [0, 0, 0, 1]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
  const over = (top, bottom) => { const a = top[3] + bottom[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [(top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / a, (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / a, (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / a, a]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { let c = [0, 0, 0, 0]; const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n); for (let i = chain.length - 1; i >= 0; i -= 1) { const s = getComputedStyle(chain[i]); if (s.backgroundImage !== 'none' && /gradient/.test(s.backgroundImage)) return null; c = over(parse(s.backgroundColor), c); } return over(c, [255, 255, 255, 1]); };
  const opacityOf = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]') && !el.closest('.sr-only'); };
  const sel = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const seen = new Set();
  const walker = document.createTreeWalker(document.getElementById('main') || document.body, NodeFilter.SHOW_TEXT);
  const dark = document.documentElement.dataset.theme === 'dark';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim(); if (!text) continue; const el = n.parentElement; if (!el || !visible(el) || el.closest('canvas, script, style, option')) continue;
    const s = getComputedStyle(el); const bg = bgOf(el); if (!bg) continue;
    const fg0 = parse(s.color); const o = opacityOf(el); const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * o], bg);
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700; const large = size >= 24 || (size >= 18.66 && bold);
    const r = ratio(fg, bg); const need = large ? 3 : 4.5;
    if (r < need && !el.closest('[disabled], [aria-disabled="true"]')) { const key = `${sel(el)}|${text.slice(0, 20)}`; if (!seen.has(key)) { seen.add(key); out.contrast.push({ el: sel(el), text: text.slice(0, 30), ratio: Math.round(r * 100) / 100, need, fg: s.color, bg: `rgb(${bg.slice(0, 3).map(Math.round)})` }); } }
  }
  // controls without an accessible name
  document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]').forEach((el) => {
    if (!visible(el) && !(el.type === 'checkbox' || el.type === 'radio' || el.type === 'file')) return;
    const name = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent.trim() || el.getAttribute('title') || (el.labels && el.labels.length ? el.labels[0].textContent.trim() : '') || el.getAttribute('placeholder') || '');
    if (!name) out.unlabeled.push(sel(el));
    if (innerWidth <= 480 && visible(el) && !el.closest('.sr-only')) { const r = el.getBoundingClientRect(); if ((r.width < 24 || r.height < 24) && !['checkbox', 'radio'].includes(el.type)) out.tiny.push(`${sel(el)} ${Math.round(r.width)}x${Math.round(r.height)}`); }
  });
  const ids = {}; document.querySelectorAll('[id]').forEach((e) => { ids[e.id] = (ids[e.id] || 0) + 1; }); out.dupIds = Object.entries(ids).filter(([, c]) => c > 1).map(([i]) => i);
  out.h1s = document.querySelectorAll('h1').length; out.noH1 = out.h1s === 0;
  out.imgNoAlt = [...document.images].filter((i) => !i.hasAttribute('alt')).length;
  if (dark) document.querySelectorAll('#main *, header *, aside *').forEach((el) => { if (!visible(el)) return; const s = getComputedStyle(el); const c = parse(s.backgroundColor); if (c[3] > 0.9 && c[0] > 235 && c[1] > 235 && c[2] > 235 && el.getBoundingClientRect().width > 24) out.lightInDark.push(sel(el)); });
  return out;
};
module.exports = { inPage };
