const ExcelJS = require('exceljs');
const httpError = require('../utils/httpError');

// ---------------------------------------------------------------------------
// Excel (.xlsx) support for the transaction import.
//
// The workbook is converted into the SAME CSV text the CSV import uses, and that text then goes through the normal parse -> validate ->
// duplicate-check -> preview -> confirm pipeline. So every rule (columns, types, limits, duplicates, confirmation, rollback) is identical.
//
//  * only the FIRST worksheet is read; the first row must be the header (date,type,amount,category,description[,notes])
//  * formulas are NEVER evaluated: a formula cell contributes its stored RESULT as plain text
//  * Excel date cells become YYYY-MM-DD (UTC calendar day); numbers keep their value (float noise such as 0.1+0.2 is rounded to 12 digits)
//  * limits: file <= 2,000,000 bytes, <= 1,001 rows read, <= 30 columns, cells <= 5,000 characters
//  * the legacy binary .xls format is NOT supported (it is a different, riskier format): save as .xlsx or CSV
//  * a corrupt/forged file is rejected with a generic message; nothing from the file is executed (no macros: .xlsm is refused too)
// ---------------------------------------------------------------------------

const MAX_BYTES = 2_000_000;
const MAX_ROWS = 1001;
const MAX_COLS = 30;
const MAX_CELL = 5000;

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined && value.result !== null) return cellText(value.result); // formula: use the stored result only
    if ('formula' in value || 'sharedFormula' in value) return '';
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return cellText(value.text); // hyperlink
    if ('error' in value) return '';
  }
  return String(value);
}

async function xlsxToCsv(base64, fileName) {
  if (fileName && /\.xlsm$/i.test(fileName)) throw httpError(400, 'Macro-enabled workbooks (.xlsm) are not supported. Save the sheet as .xlsx or CSV.');
  if (fileName && /\.xls$/i.test(fileName)) throw httpError(400, 'The old .xls format is not supported. In Excel choose File > Save As > Excel Workbook (.xlsx) or CSV, then upload that.');
  if (typeof base64 !== 'string' || !base64.length) throw httpError(400, 'No file content was received.');
  if (base64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) throw httpError(413, `The Excel file is too large (limit ${MAX_BYTES.toLocaleString('en-US')} bytes, about 2 MB).`);
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_BYTES) throw httpError(413, `The Excel file is too large (limit ${MAX_BYTES.toLocaleString('en-US')} bytes, about 2 MB).`);
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw httpError(400, 'This is not a valid .xlsx file (a real .xlsx workbook is a zip archive). Save the sheet as .xlsx or CSV and try again.');

  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw httpError(400, 'The Excel file could not be read. It may be damaged or password-protected. Save it again as .xlsx or CSV.'); }
  const ws = wb.worksheets.find((s) => s.state !== 'hidden') || wb.worksheets[0];
  if (!ws) throw httpError(400, 'The workbook has no sheets.');
  if (ws.rowCount > MAX_ROWS + 5000) throw httpError(400, 'The first sheet has far more than 1,000 rows. Split it into smaller files.');

  const lines = [];
  let width = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (lines.length > MAX_ROWS) return;
    const cells = [];
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLS + 1); c += 1) {
      const t = cellText(row.getCell(c).value);
      if (t.length > MAX_CELL) throw httpError(400, `A cell on row ${row.number} is longer than ${MAX_CELL} characters.`);
      cells.push(t);
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (!cells.length) return;
    width = Math.max(width, cells.length);
    lines.push(cells);
  });
  if (!lines.length) throw httpError(400, 'The first sheet is empty.');
  if (width > MAX_COLS) throw httpError(400, `The first sheet has more than ${MAX_COLS} columns.`);
  if (lines.length > MAX_ROWS) throw httpError(400, 'The file has more than 1,000 data rows. Split it into smaller files.');
  const headerWidth = lines[0].length;
  // pad every row to the header width so a blank trailing notes cell is not treated as a missing column
  return lines.map((r) => { const padded = r.slice(); while (padded.length < headerWidth) padded.push(''); return padded.map(csvCell).join(','); }).join('\n');
}

module.exports = { xlsxToCsv, MAX_BYTES };
