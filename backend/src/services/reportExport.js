const path = require('path');
const PDFDocument = require('pdfkit');
const { toCsv } = require('../utils/csv');

// ---------------------------------------------------------------------------
// Report -> CSV and PDF. Both are generated on the server from the same report object the screen shows, so an export can never
// disagree with the page.
// ---------------------------------------------------------------------------

// ----- CSV: stacked, labelled sections (one file keeps the whole report together) -----
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);

function reportToCsv(r) {
  const cur = r.meta.currency;
  const rows = [
    ['FinTrack financial report'],
    ['Title', r.meta.title],
    ['Type', r.type === 'snapshot' ? 'Saved snapshot (frozen figures)' : 'Live report (calculated at generation time)'],
    ['Period', r.meta.label],
    ['From', r.meta.range.start], ['To', r.meta.range.end],
    ['Generated at', r.meta.generatedAt], ['Currency', cur],
    [],
    ['SUMMARY'], ['Metric', 'Value'],
    ['Income', r.summary.income], ['Expense', r.summary.expense], ['Savings (income - expense)', r.summary.savings],
    ['Savings rate', r.summary.savingsRate === null ? 'n/a (no income)' : `${r.summary.savingsRate}%`],
    ['Transactions', r.summary.transactionCount], ['Average daily expense', r.summary.averageDailyExpense],
    [],
    ['COMPARISON WITH PREVIOUS PERIOD', `${r.meta.previousRange.start} to ${r.meta.previousRange.end}`],
  ];
  if (r.comparison.available) {
    rows.push(['Metric', 'Current', 'Previous', 'Change', 'Change %']);
    [['Income', r.comparison.income], ['Expense', r.comparison.expense], ['Savings', r.comparison.savings]].forEach(([n, c]) => rows.push([n, c.current, c.previous, c.change, pct(c.changePercent)]));
  } else rows.push([r.comparison.message || 'No previous data']);
  rows.push([], ['EXPENSES BY CATEGORY'], ['Category', 'Amount', 'Share %', 'Transactions']);
  r.expenseCategories.forEach((c) => rows.push([c.category, c.amount, c.percentage, c.count]));
  rows.push([], ['INCOME BY CATEGORY'], ['Category', 'Amount', 'Share %', 'Transactions']);
  r.incomeCategories.forEach((c) => rows.push([c.category, c.amount, c.percentage, c.count]));
  rows.push([], ['TREND (' + r.trend.granularity + ')'], ['Period', 'Income', 'Expense', 'Savings']);
  r.trend.points.forEach((pt) => rows.push([pt.label, pt.income, pt.expense, pt.savings]));
  rows.push([], ['LARGEST EXPENSES'], ['Date', 'Description', 'Category', 'Amount']);
  r.topExpenses.forEach((t) => rows.push([t.date, t.description, t.category, t.amount]));
  rows.push([], ['LARGEST INCOME'], ['Date', 'Description', 'Category', 'Amount']);
  r.topIncome.forEach((t) => rows.push([t.date, t.description, t.category, t.amount]));
  rows.push([], ['BUDGET PERFORMANCE (each budget over its own range)'], ['Category', 'Limit', 'Spent', 'Used %', 'Status', 'Spent inside this period', 'From', 'To', 'Counted in totals']);
  r.budgets.items.forEach((b) => rows.push([b.category, b.limit, b.spent, b.percentage, b.status, b.spentInPeriod, b.startDate, b.endDate, b.inTotals ? 'yes' : 'no (began before this period)']));
  rows.push(['Note', r.budgets.note]);
  rows.push([], ['SAVINGS GOALS (progress as of generation)'], ['Goal', 'Target', 'Saved', 'Progress %', 'Status', 'Contributed in period', 'Target date']);
  r.goals.items.forEach((g) => rows.push([g.title, g.targetAmount, g.savedAmount, g.percentage, g.status, g.contributedInPeriod, g.targetDate]));
  rows.push([], ['SUBSCRIPTIONS'], ['Active', r.subscriptions.counts.active], ['Estimated monthly cost (ESTIMATE)', r.subscriptions.estimated.monthly], ['Estimated yearly cost (ESTIMATE)', r.subscriptions.estimated.yearly], ['Confirmed payments in period (ACTUAL)', r.subscriptions.actual.inPeriod]);
  r.subscriptions.actual.byName.forEach((a) => rows.push(['  paid: ' + a.name, a.amount]));
  rows.push(['Note', r.subscriptions.note]);
  return toCsv(rows);
}

// ----- PDF -----
// Fonts: Noto Sans + Noto Sans Bengali (see FONT_FILES), so the taka sign and Bengali descriptions print correctly.
const GREEN = '#1f7a5a'; const DARK = '#1c2b26'; const MUTE = '#5c6b66'; const LINE = '#d7e2dd'; const RED = '#b3382c'; const SOFT = '#eef5f1';
// Noto Sans (Latin) and Noto Sans Bengali are bundled through npm (@fontsource), so the PDF can print the taka sign and Bengali text.
// Anything outside Latin-1, common punctuation and Bengali (e.g. emoji, CJK) becomes '?' instead of an empty box.
const FONT_PATH = (pkg, file) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', file);
const FONT_FILES = {
  NS: ['@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff'], NSB: ['@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff'],
  BN: ['@fontsource/noto-sans-bengali', 'noto-sans-bengali-bengali-400-normal.woff'], BNB: ['@fontsource/noto-sans-bengali', 'noto-sans-bengali-bengali-700-normal.woff'],
};
const BENGALI = /[ঀ-৿]/;
const BENGALI_RUN = /([ঀ-৿]+(?:[ ঀ-৿]*[ঀ-৿])?)/;
const latin = (v) => String(v ?? '').replace(/[^\x20-\x7E -ÿ–—‘’“”…‌‍ঀ-৿]/g, '?');
const num = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function reportToPdf(r) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 20 }, bufferPages: true, info: { Title: latin(r.meta.title), Author: 'FinTrack', Subject: `Financial report ${r.meta.range.start} to ${r.meta.range.end}` } });
    Object.entries(FONT_FILES).forEach(([name, [pkg, file]]) => doc.registerFont(name, FONT_PATH(pkg, file)));
    // Text mixing Latin and Bengali is drawn run by run, each run in the font that has its glyphs (single line; honours left/center/right).
    const rawText = doc.text.bind(doc);
    doc.text = function patched(str, x, y, opts) {
      if (typeof x === 'object' && x !== null) { opts = x; x = undefined; y = undefined; }
      const t = String(str ?? '');
      if (!BENGALI.test(t)) return rawText(t, x, y, opts);
      const bold = /B$/.test(doc._font.name);
      const fontOf = (bn) => (bn ? (bold ? 'BNB' : 'BN') : (bold ? 'NSB' : 'NS'));
      const runs = t.split(BENGALI_RUN).filter(Boolean).map((p) => ({ p, bn: BENGALI.test(p) }));
      const total = runs.reduce((a, r) => a + doc.font(fontOf(r.bn)).widthOfString(r.p), 0);
      const o = opts || {}; const x0 = x === undefined ? doc.x : x; const y0 = y === undefined ? doc.y : y;
      let cx = x0;
      if (o.width && o.align === 'right') cx = x0 + Math.max(0, o.width - total);
      else if (o.width && o.align === 'center') cx = x0 + Math.max(0, (o.width - total) / 2);
      const lh = doc.currentLineHeight(true);
      runs.forEach((r) => { doc.font(fontOf(r.bn)); rawText(r.p, cx, y0, { lineBreak: false }); cx += doc.widthOfString(r.p); });
      doc.font(bold ? 'NSB' : 'NS');
      doc.x = x0; doc.y = o.lineBreak === false ? y0 : y0 + lh;
      return doc;
    };
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const cur = r.meta.currency;
    const money = (n) => (cur === 'BDT' ? `৳${num(n)}` : `${cur} ${num(n)}`);
    const L = 40; const W = doc.page.width - 80; const BOTTOM = () => doc.page.height - 60;
    const need = (h) => { if (doc.y + h > BOTTOM()) doc.addPage(); };
    const h2 = (text) => { need(60); doc.moveDown(0.8).font('NSB').fontSize(13).fillColor(GREEN).text(latin(text), L, doc.y); doc.moveTo(L, doc.y + 2).lineTo(L + W, doc.y + 2).strokeColor(LINE).lineWidth(1).stroke(); doc.moveDown(0.5).fillColor(DARK); };
    const para = (text, o = {}) => doc.font('NS').fontSize(o.size || 9).fillColor(o.color || MUTE).text(latin(text), L, doc.y, { width: W });

    // header band
    doc.rect(0, 0, doc.page.width, 78).fill(GREEN);
    doc.fillColor('#ffffff').font('NSB').fontSize(22).text('FinTrack', L, 22);
    doc.font('NS').fontSize(10).text('Personal finance report', L, 50);
    doc.font('NSB').fontSize(11).text(r.type === 'snapshot' ? 'SAVED SNAPSHOT' : 'LIVE REPORT', L, 30, { width: W, align: 'right' });
    doc.font('NS').fontSize(9).text(`Generated ${r.meta.generatedAt.slice(0, 10)}`, L, 50, { width: W, align: 'right' });
    doc.y = 96;
    doc.fillColor(DARK).font('NSB').fontSize(17).text(latin(r.meta.title), L, doc.y, { width: W });
    doc.font('NS').fontSize(10).fillColor(MUTE).text(`${r.meta.label}: ${r.meta.range.start} to ${r.meta.range.end}  (${r.meta.range.days} day${r.meta.range.days === 1 ? '' : 's'})${r.meta.userName ? `   |   Prepared for ${latin(r.meta.userName)}` : ''}`);
    para(r.meta.basis, { size: 8 });

    // summary tiles
    h2('Summary');
    const tiles = [['Income', money(r.summary.income), DARK], ['Expense', money(r.summary.expense), DARK], ['Savings', money(r.summary.savings), r.summary.savings < 0 ? RED : GREEN], ['Savings rate', r.summary.savingsRate === null ? 'n/a (no income)' : `${r.summary.savingsRate}%`, r.summary.savingsRate !== null && r.summary.savingsRate < 0 ? RED : DARK]];
    const tw = (W - 3 * 8) / 4; const ty = doc.y;
    tiles.forEach(([label, value, color], i) => {
      const x = L + i * (tw + 8);
      doc.roundedRect(x, ty, tw, 50, 6).fill(SOFT);
      doc.fillColor(MUTE).font('NS').fontSize(8).text(label.toUpperCase(), x + 8, ty + 8, { width: tw - 16 });
      doc.fillColor(color).font('NSB').fontSize(value.length > 16 ? 9 : 11).text(value, x + 8, ty + 24, { width: tw - 16 });
    });
    doc.y = ty + 60;
    para(`${r.summary.transactionCount} transaction${r.summary.transactionCount === 1 ? '' : 's'} (${r.summary.incomeCount} income, ${r.summary.expenseCount} expense). Average daily expense ${money(r.summary.averageDailyExpense)}.${r.summary.isNegativeSavings ? ' You spent more than you earned in this period.' : ''}${r.summary.hasIncome ? '' : ' No income was recorded, so a savings rate cannot be calculated.'}`);
    if (!r.hasData) para('No transactions were recorded in this period.', { color: DARK, size: 10 });

    // comparison
    h2('Compared with the previous period');
    if (r.comparison.available) {
      para(`Previous period: ${r.meta.previousRange.start} to ${r.meta.previousRange.end}`);
      [['Income', r.comparison.income], ['Expense', r.comparison.expense], ['Savings', r.comparison.savings]].forEach(([n, c]) => {
        doc.fillColor(DARK).font('NS').fontSize(9).text(latin(`${n}: ${money(c.current)} vs ${money(c.previous)} - ${c.message}`), L, doc.y, { width: W });
      });
    } else para(r.comparison.message || 'No previous data to compare with.');

    // chart 1: trend bars
    const pts = r.trend.points;
    if (r.hasData && pts.length) {
      h2(`Income vs expense (${r.trend.granularity === 'day' ? 'per day' : 'per month'})`);
      const chartH = 110; const cy = doc.y + 4; need(chartH + 40);
      const base = cy + chartH; const maxV = Math.max(1, ...pts.map((p) => Math.max(p.income, p.expense)));
      const slot = W / pts.length; const bw = Math.max(1.5, Math.min(14, slot / 2.6));
      doc.moveTo(L, base).lineTo(L + W, base).strokeColor(LINE).stroke();
      pts.forEach((p, i) => {
        const x = L + i * slot + (slot - bw * 2 - 1) / 2;
        const hi = (p.income / maxV) * (chartH - 8); const he = (p.expense / maxV) * (chartH - 8);
        if (hi > 0) doc.rect(x, base - hi, bw, hi).fill(GREEN);
        if (he > 0) doc.rect(x + bw + 1, base - he, bw, he).fill(RED);
        if (pts.length <= 12 || i % Math.ceil(pts.length / 10) === 0) doc.fillColor(MUTE).font('NS').fontSize(6.5).text(latin(p.label), x - 6, base + 3, { width: bw * 2 + 14, align: 'center', lineBreak: false });
      });
      doc.rect(L, base + 16, 8, 8).fill(GREEN); doc.fillColor(MUTE).fontSize(8).text('Income', L + 12, base + 16, { lineBreak: false });
      doc.rect(L + 62, base + 16, 8, 8).fill(RED); doc.fillColor(MUTE).fontSize(8).text('Expense', L + 74, base + 16, { lineBreak: false });
      doc.y = base + 34;
    }

    // chart 2 + table: expense categories
    h2('Spending by category');
    if (!r.expenseCategories.length) para('No expenses in this period.');
    else {
      const top = r.expenseCategories.slice(0, 8); const maxA = Math.max(1, ...top.map((c) => c.amount));
      top.forEach((c) => {
        need(18);
        const y = doc.y;
        doc.fillColor(DARK).font('NS').fontSize(9).text(latin(c.category), L, y + 1, { width: 110, lineBreak: false });
        const bwid = Math.max(2, (c.amount / maxA) * (W - 250));
        doc.rect(L + 115, y + 1, bwid, 9).fill(GREEN);
        doc.fillColor(DARK).fontSize(8.5).text(`${money(c.amount)}  (${c.percentage}%)`, L + 120 + bwid, y + 1, { lineBreak: false });
        doc.y = y + 16;
      });
      if (r.expenseCategories.length > 8) para(`...and ${r.expenseCategories.length - 8} more categories (see the CSV export for all).`);
    }
    if (r.incomeCategories.length) {
      h2('Income by category');
      r.incomeCategories.slice(0, 8).forEach((c) => { need(14); doc.fillColor(DARK).font('NS').fontSize(9).text(latin(`${c.category}: ${money(c.amount)} (${c.percentage}%)`), L, doc.y); });
    }

    // tables
    const table = (head, rowsData, widths, aligns) => {
      need(70);
      let y = doc.y; const xs = widths.reduce((a, w, i) => { a.push((a[i] || L) + (i ? widths[i - 1] : 0)); return a; }, []);
      const x0 = (i) => L + widths.slice(0, i).reduce((s, w) => s + w, 0);
      doc.rect(L, y, W, 16).fill(SOFT);
      head.forEach((t, i) => doc.fillColor(MUTE).font('NSB').fontSize(8).text(latin(t), x0(i) + 4, y + 4, { width: widths[i] - 8, align: aligns[i], lineBreak: false }));
      y += 18;
      rowsData.forEach((row) => {
        if (y + 16 > BOTTOM()) { doc.addPage(); y = 50; }
        row.forEach((t, i) => doc.fillColor(DARK).font('NS').fontSize(8.5).text(latin(t), x0(i) + 4, y + 2, { width: widths[i] - 8, align: aligns[i], lineBreak: false, ellipsis: true }));
        y += 15; doc.moveTo(L, y - 1).lineTo(L + W, y - 1).strokeColor(LINE).lineWidth(0.5).stroke();
      });
      void xs; doc.y = y + 2;
    };
    h2('Largest expenses');
    if (r.topExpenses.length) table(['Date', 'Description', 'Category', 'Amount'], r.topExpenses.map((t) => [t.date, t.description, t.category, money(t.amount)]), [62, W - 62 - 110 - 110, 110, 110], ['left', 'left', 'left', 'right']);
    else para('None.');
    if (r.topIncome.length) { h2('Largest income'); table(['Date', 'Description', 'Category', 'Amount'], r.topIncome.map((t) => [t.date, t.description, t.category, money(t.amount)]), [62, W - 62 - 110 - 110, 110, 110], ['left', 'left', 'left', 'right']); }

    h2('Budget performance');
    if (!r.budgets.items.length) para('No budgets overlap this period.');
    else {
      table(['Category', 'Limit', 'Spent', 'Used', 'Status'], r.budgets.items.map((b) => [b.category + (b.inTotals ? '' : ' *'), money(b.limit), money(b.spent), `${b.percentage}%`, b.status]), [W - 330, 100, 100, 50, 80], ['left', 'right', 'right', 'right', 'left']);
      para(`* began before this period. ${r.budgets.note}`, { size: 8 });
    }

    h2('Savings goals');
    if (!r.goals.items.length) para('No savings goals yet.');
    else {
      table(['Goal', 'Saved', 'Target', 'Progress', 'This period'], r.goals.items.map((g) => [g.title, money(g.savedAmount), money(g.targetAmount), `${g.percentage}% ${g.status}`, money(g.contributedInPeriod)]), [W - 380, 95, 95, 90, 100], ['left', 'right', 'right', 'right', 'right']);
      para(r.goals.note, { size: 8 });
    }

    h2('Subscriptions');
    para(`${r.subscriptions.counts.active} active subscription${r.subscriptions.counts.active === 1 ? '' : 's'} (${r.subscriptions.counts.paused} paused, ${r.subscriptions.counts.cancelled} cancelled, ${r.subscriptions.counts.expired} expired).`, { color: DARK, size: 10 });
    para(`ESTIMATE: about ${money(r.subscriptions.estimated.monthly)} per month, ${money(r.subscriptions.estimated.yearly)} per year at current plans.`, { color: DARK });
    para(`ACTUAL: ${money(r.subscriptions.actual.inPeriod)} in ${r.subscriptions.actual.paymentCount} confirmed payment${r.subscriptions.actual.paymentCount === 1 ? '' : 's'} inside this period.`, { color: DARK });
    para(r.subscriptions.note, { size: 8 });

    // footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const fy = doc.page.height - 38;
      doc.moveTo(L, fy - 6).lineTo(L + W, fy - 6).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.fillColor(MUTE).font('NS').fontSize(8).text(`FinTrack - ${latin(r.meta.title)} - generated ${r.meta.generatedAt.slice(0, 10)}`, L, fy, { width: W - 60, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, L, fy, { width: W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { reportToCsv, reportToPdf, latin };
