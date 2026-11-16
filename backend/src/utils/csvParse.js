// A small, strict RFC 4180 CSV parser (no dependencies, no eval, linear time).
//
//  * quoted fields may contain commas, quotes ("" = one quote) and line breaks
//  * LF, CRLF and CR line endings; a leading UTF-8 BOM is removed; completely blank lines are skipped
//  * limits are enforced WHILE parsing, so a hostile file can never make the server build a huge structure:
//      maxRows (data rows), maxCols (columns per row), maxCell (characters per cell)
//  * an unterminated quote is an error, never silently "fixed"
//
// Returns { header: string[], rows: [{ line, cells: string[] }] } where `line` is the 1-based line number the row STARTS on
// (the header is line 1 of the file), so error messages can point at the user's spreadsheet row.

class CsvError extends Error {
  constructor(message) { super(message); this.name = 'CsvError'; this.statusCode = 400; }
}

function parseCsv(input, { maxRows = 1000, maxCols = 30, maxCell = 5000 } = {}) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (text.includes('\u0000')) throw new CsvError('This does not look like a text CSV file (it contains binary data). Export it as CSV (comma separated) and try again.');

  const records = [];
  let cells = []; let cell = ''; let inQuotes = false; let quotedCell = false; let line = 1; let recordLine = 1; let pos = 0;
  const n = text.length;

  const endCell = () => {
    if (cell.length > maxCell) throw new CsvError(`A cell on line ${recordLine} is longer than ${maxCell} characters.`);
    cells.push(cell); cell = ''; quotedCell = false;
    if (cells.length > maxCols) throw new CsvError(`Line ${recordLine} has more than ${maxCols} columns.`);
  };
  const endRecord = () => {
    endCell();
    // a record that is a single empty, unquoted cell is a blank line
    if (!(cells.length === 1 && cells[0] === '')) {
      records.push({ line: recordLine, cells });
      if (records.length > maxRows + 1) throw new CsvError(`The file has more than ${maxRows} data rows. Split it into smaller files.`);
    }
    cells = [];
  };

  while (pos < n) {
    const ch = text[pos];
    if (inQuotes) {
      if (ch === '"') {
        if (text[pos + 1] === '"') { cell += '"'; pos += 2; continue; }
        inQuotes = false; pos += 1; continue;
      }
      if (ch === '\n') line += 1;
      cell += ch; pos += 1;
      if (cell.length > maxCell + 1) throw new CsvError(`A cell starting on line ${recordLine} is longer than ${maxCell} characters.`);
      continue;
    }
    if (ch === '"') {
      if (cell !== '' || quotedCell) throw new CsvError(`Unexpected quote on line ${line}. Put the whole cell in quotes, and double any quote inside it.`);
      inQuotes = true; quotedCell = true; pos += 1; continue;
    }
    if (ch === ',') { endCell(); pos += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[pos + 1] === '\n') pos += 1;
      pos += 1; endRecord(); line += 1; recordLine = line; continue;
    }
    if (quotedCell) throw new CsvError(`Unexpected text after a closing quote on line ${line}.`);
    cell += ch; pos += 1;
  }
  if (inQuotes) throw new CsvError(`A quoted cell starting on line ${recordLine} is never closed.`);
  if (cell !== '' || cells.length || quotedCell) endRecord();

  if (!records.length) throw new CsvError('The file is empty.');
  const [head, ...rows] = records;
  return { header: head.cells.map((h) => h.trim()), headerLine: head.line, rows };
}

module.exports = { parseCsv, CsvError };
