// CSV helpers shared by report export (Phase 15) and import/export (Phase 16).
//
// FORMULA INJECTION: spreadsheet programs treat a cell starting with = + - @ (or a tab / carriage return) as a formula, so
// user-controlled text such as a transaction description "=HYPERLINK(...)" could run when the exported file is opened.
// Every STRING cell that starts with one of those characters is prefixed with a single quote (the OWASP-recommended fix), which
// makes the program show it as plain text. Real numbers (typeof number) are written as-is, so negative amounts stay numeric.
const DANGEROUS_START = /^[=+\-@\t\r]/;

const safeText = (value) => {
  const s = String(value ?? '');
  return DANGEROUS_START.test(s) ? `'${s}` : s;
};

const cell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = safeText(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// rows: array of arrays. UTF-8 BOM so Excel opens non-ASCII text (e.g. the taka sign) correctly. CRLF line endings (RFC 4180).
const toCsv = (rows, { bom = true } = {}) => (bom ? '\uFEFF' : '') + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

module.exports = { toCsv, cell, safeText, DANGEROUS_START };
