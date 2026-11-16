// Minimal PDF text extractor for pdfkit output: inflates streams, reads each font's ToUnicode map and decodes the Tj/TJ glyph strings.
const zlib = require('zlib');

function pdfText(buf) {
  const bin = buf.toString('latin1');
  const objs = new Map();
  for (const m of bin.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) objs.set(m[1], m[2]);
  const streamOf = (body) => {
    const s = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(body);
    if (!s) return null;
    try { return zlib.inflateSync(Buffer.from(s[1], 'latin1')).toString('latin1'); } catch { return s[1]; }
  };
  const cmapOf = (objId) => {
    const map = new Map();
    const t = streamOf(objs.get(objId) || '') || '';
    for (const blk of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const l of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(l[1], 16), String.fromCodePoint(...(l[2].match(/.{4}/g) || []).map((h) => parseInt(h, 16))));
    for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const l of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) { const lo = parseInt(l[1], 16); (l[3].match(/<([0-9a-fA-F ]+)>/g) || []).forEach((h, k) => map.set(lo + k, String.fromCodePoint(...(h.slice(1, -1).replace(/\s+/g, '').match(/.{4}/g) || []).map((x) => parseInt(x, 16))))); }
    for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) if (!blk[1].includes('[')) for (const l of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) { const lo = parseInt(l[1], 16); const hi = parseInt(l[2], 16); const base = parseInt(l[3], 16); for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCodePoint(base + c - lo)); }
    return map;
  };
  // font resource names -> ToUnicode maps
  const fonts = new Map();
  for (const m of bin.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
    const body = objs.get(m[2]) || '';
    const tu = /\/ToUnicode\s+(\d+) 0 R/.exec(body);
    if (tu) fonts.set(m[1], cmapOf(tu[1]));
  }
  let out = '';
  for (const body of objs.values()) {
    const t = streamOf(body);
    if (!t || !/ Tf/.test(t)) continue;
    let cur = null;
    for (const tok of t.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]+)>\s*Tj|\[([^\]]*)\]\s*TJ/g)) {
      if (tok[1]) { cur = fonts.get(tok[1]); continue; }
      const hexes = tok[2] ? [tok[2]] : (tok[3].match(/<([0-9a-fA-F]+)>/g) || []).map((h) => h.slice(1, -1));
      hexes.forEach((h) => { for (let i = 0; i < h.length; i += 4) out += (cur && cur.get(parseInt(h.slice(i, i + 4), 16))) || ''; });
      out += ' ';
    }
  }
  return out;
}
module.exports = { pdfText };
