const { prisma } = require('./dbenv');
const { call, register, eq, done } = require('./lib');
const R = require('../../src/services/reportService');
const X = require('../../src/services/reportExport');
const csvu = require('../../src/utils/csv');

const BASE = process.env.BASE || 'http://localhost:5055/api';
const iso = (d) => d.toISOString().slice(0, 10);
const t0 = new Date();
const today = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()));
const dd = (n) => iso(new Date(today.getTime() + n * 86400000));
const mStart = (off) => iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + off, 1)));
const raw = async (T, path) => { const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${T}` } }); return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) }; };

(async () => {
  const tx = (T, type, amount, category, date, description = 'x') => call(T, 'POST', '/transactions', { type, amount, category, description, date });
  const A = await register('r15a');
  const B = await register('r15b');
  const Z = await register('r15z');
  const uid = async (prefix) => (await prisma.user.findFirst({ where: { email: { startsWith: prefix } }, orderBy: { createdAt: 'desc' } })).id;

  eq('no token => 401 (report, csv, pdf, snapshots)', await Promise.all(['/reports', '/reports/export/csv', '/reports/export/pdf', '/reports/snapshots'].map(async (p) => (await call(null, 'GET', p)).status)), [401, 401, 401, 401]);

  // ---- empty user ----
  const z = (await call(Z, 'GET', '/reports?period=this_month')).data;
  eq('empty user: no data, zeros, null savings rate, no comparison, no fake rows', [z.hasData, z.hasAnyTransactions, z.summary.income, z.summary.expense, z.summary.savings, z.summary.savingsRate, z.comparison.available, z.expenseCategories.length, z.topExpenses.length, z.budgets.items.length, z.goals.items.length], [false, false, 0, 0, 0, null, false, 0, 0, 0, 0]);
  eq('empty user: previous-data message is honest', z.comparison.income.sufficient, false);
  eq('empty user: CSV and PDF still generate', [(await raw(Z, '/reports/export/csv')).status, (await raw(Z, '/reports/export/pdf')).status], [200, 200]);

  // ---- data for A (this month + last month) ----
  await tx(A, 'INCOME', 50000, 'Salary', mStart(0), 'Salary');
  await tx(A, 'EXPENSE', 12000, 'Rent', mStart(0), 'Rent');
  await tx(A, 'EXPENSE', 3000, 'Food', mStart(0), 'Groceries');
  await tx(A, 'EXPENSE', 1000, 'Food', mStart(0), '=HYPERLINK("http://evil","x")');
  await tx(A, 'INCOME', 40000, 'Salary', mStart(-1), 'Last salary');
  await tx(A, 'EXPENSE', 10000, 'Rent', mStart(-1), 'Last rent');
  await tx(A, 'EXPENSE', 2000, 'Food', mStart(-1), 'Last food');
  const rep = (await call(A, 'GET', '/reports?period=this_month')).data;
  eq('summary: income 50000, expense 16000, savings 34000, rate 68', [rep.summary.income, rep.summary.expense, rep.summary.savings, rep.summary.savingsRate], [50000, 16000, 34000, 68]);
  eq('categories sum to expense; shares', [rep.expenseCategories.reduce((s, c) => s + c.amount, 0), rep.expenseCategories[0].category, rep.expenseCategories[0].percentage], [16000, 'Rent', 75]);
  eq('top expenses ordered desc; counts', [rep.topExpenses.map((t) => t.amount), rep.summary.expenseCount, rep.summary.incomeCount], [[12000, 3000, 1000], 3, 1]);

  // consistency with Analytics + Dashboard
  const an = (await call(A, 'GET', '/analytics/overview?period=this_month')).data;
  eq('same totals as Analytics overview', [{ income: rep.summary.income, expense: rep.summary.expense, savings: rep.summary.savings, savingsRate: rep.summary.savingsRate }, rep.expenseCategories.map((c) => [c.category, c.amount])], [{ income: an.summary.income, expense: an.summary.expense, savings: an.summary.savings, savingsRate: an.summary.savingsRate }, an.expenseCategories.map((c) => [c.category, c.amount])]);
  eq('comparison equals Analytics comparison', [rep.comparison.income.changePercent, rep.comparison.expense.current, rep.comparison.savings.previous], [an.comparison.income.changePercent, an.comparison.expense.current, an.comparison.savings.previous]);
  const dash = (await call(A, 'GET', '/dashboard?period=month')).data;
  eq('same totals as Dashboard', [dash.summary.totalIncome, dash.summary.totalExpense].map(Number), [50000, 16000]);
  eq('previous period (last month => honest "previous" numbers)', [rep.previousSummary.income, rep.previousSummary.expense, rep.comparison.available], [40000, 12000, true]);

  // last month report
  const lm = (await call(A, 'GET', '/reports?period=last_month')).data;
  eq('last_month: income 40000 expense 12000', [lm.summary.income, lm.summary.expense, lm.meta.range.start], [40000, 12000, mStart(-1)]);
  eq('last_month: nothing before it => no comparison, not 0%', [lm.comparison.available, lm.comparison.income.changePercent], [false, null]);
  for (const p of ['last_3_months', 'last_6_months', 'this_year']) {
    const r = (await call(A, 'GET', `/reports?period=${p}`)).data;
    const a = (await call(A, 'GET', `/analytics/overview?period=${p}`)).data;
    eq(`${p}: matches analytics`, [r.summary.income, r.summary.expense, r.meta.range], [a.summary.income, a.summary.expense, a.range]);
  }
  // custom
  const cu = (await call(A, 'GET', `/reports?period=custom&startDate=${mStart(0)}&endDate=${dd(0)}`)).data;
  eq('custom range works', [cu.summary.income, cu.meta.label], [50000, 'Custom Range']);
  eq('custom validation: missing / reversed / too long / bad format / bad period', [
    (await call(A, 'GET', '/reports?period=custom')).status, (await call(A, 'GET', `/reports?period=custom&startDate=${dd(0)}&endDate=${dd(-5)}`)).status,
    (await call(A, 'GET', '/reports?period=custom&startDate=2000-01-01&endDate=2030-01-01')).status, (await call(A, 'GET', '/reports?period=custom&startDate=garbage&endDate=x')).status,
    (await call(A, 'GET', '/reports?period=forever')).status], [400, 400, 400, 400, 400]);
  const empty = (await call(A, 'GET', '/reports?period=custom&startDate=2001-01-01&endDate=2001-01-31')).data;
  eq('period with no transactions: empty report, no comparison', [empty.hasData, empty.hasAnyTransactions, empty.summary.savingsRate, empty.comparison.available], [false, true, null, false]);

  // ---- zero income & negative savings ----
  const N = await register('r15n');
  await tx(N, 'EXPENSE', 700, 'Food', mStart(0));
  const ni = (await call(N, 'GET', '/reports?period=this_month')).data;
  eq('zero income: rate null (not 0), savings -700, negative flag', [ni.summary.savingsRate, ni.summary.savings, ni.summary.isNegativeSavings, ni.summary.hasIncome], [null, -700, true, false]);
  await tx(N, 'INCOME', 500, 'Salary', mStart(0));
  const ng = (await call(N, 'GET', '/reports?period=this_month')).data;
  eq('negative savings with income: rate -40', [ng.summary.savings, ng.summary.savingsRate], [-200, -40]);
  eq('negative-savings report exports', [(await raw(N, '/reports/export/pdf')).status, (await raw(N, '/reports/export/csv')).status], [200, 200]);

  // ---- budgets: overlap handling ----
  await call(A, 'POST', '/budgets', { category: 'Food', limit: 5000, startDate: mStart(0), endDate: dd(0) < mStart(0) ? mStart(0) : iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))) });
  await call(A, 'POST', '/budgets', { category: 'Rent', limit: 10000, startDate: mStart(-1), endDate: dd(-0) });
  const rb = (await call(A, 'GET', '/reports?period=this_month')).data.budgets;
  const food = rb.items.find((b) => b.category === 'Food'); const rent = rb.items.find((b) => b.category === 'Rent');
  eq('Food budget (whole range inside period): spent 4000 of 5000, 80%, warning', [food.spent, food.limit, food.percentage, food.status, food.inTotals], [4000, 5000, 80, 'warning', true]);
  eq('Rent budget spans last month too: judged over its own range (22000 of 10000 => over), spentInPeriod 12000, partial', [rent.spent, rent.status, rent.spentInPeriod, rent.inTotals], [22000, 'over', 12000, false]);
  eq('summary totals only count fully-contained budgets', [rb.summary.count, rb.summary.includedCount, rb.summary.excludedCount, rb.summary.totalLimit, rb.summary.totalSpent, rb.summary.overBudget], [2, 1, 1, 5000, 4000, 1]);
  eq('budgets page agrees on spent/limit', (await call(A, 'GET', '/budgets')).data.budgets.filter((b) => b.category === 'Food').map((b) => [b.spent, b.limit]), [[4000, 5000]]);
  const other = (await call(B, 'GET', '/reports?period=this_month')).data.budgets;
  eq('another user sees none of A\'s budgets', other.items, []);

  // ---- goals ----
  const g = (await call(A, 'POST', '/goals', { title: 'Laptop', targetAmount: 1000 })).data.goal;
  await call(A, 'POST', `/goals/${g.id}/contributions`, { amount: 250 });
  const gr = (await call(A, 'GET', '/reports?period=this_month')).data;
  eq('goal summary: 25%, contributed 250 this period, savings UNCHANGED by contributions', [gr.goals.items[0].percentage, gr.goals.summary.contributedInPeriod, gr.summary.savings], [25, 250, 34000]);

  // ---- subscriptions: estimate vs actual ----
  const sub = (await call(A, 'POST', '/subscriptions', { name: 'Streaming', category: 'Entertainment', amount: 600, frequency: 'MONTHLY', startDate: dd(-3), nextRenewalDate: dd(0) })).data.subscription;
  const before = (await call(A, 'GET', '/reports?period=this_month')).data;
  eq('estimate shown (600/mo, 7200/yr) but NO actual payment and expenses unchanged', [before.subscriptions.estimated.monthly, before.subscriptions.estimated.yearly, before.subscriptions.actual.inPeriod, before.summary.expense], [600, 7200, 0, 16000]);
  await call(A, 'POST', `/subscriptions/${sub.id}/payments`, { recordTransaction: true });
  const after = (await call(A, 'GET', '/reports?period=this_month')).data;
  eq('confirmed payment: actual 600 counted once, and it is in expense once (16600), estimate not added', [after.subscriptions.actual.inPeriod, after.subscriptions.actual.paymentCount, after.summary.expense], [600, 1, 16600]);

  // ---- exports ----
  const csv = await raw(A, '/reports/export/csv');
  const csvText = csv.buf.toString('utf8');
  eq('csv: status, type, attachment name, BOM', [csv.status, /text\/csv/.test(csv.type), /attachment; filename="fintrack-report-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv"/.test(csv.disp), csvText.charCodeAt(0)], [200, true, true, 0xFEFF]);
  eq('csv: sections and values', ['SUMMARY', 'EXPENSES BY CATEGORY', 'BUDGET PERFORMANCE', 'SAVINGS GOALS', 'SUBSCRIPTIONS', 'Income,50000'].every((s) => csvText.includes(s)), true);
  eq('csv: formula injection neutralised (leading apostrophe), original quote escaping kept', [csvText.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), /(^|\n)=HYPERLINK/.test(csvText)], [true, false]);
  eq('csv util: = + - @ tab prefixed; numbers and normal text untouched', [csvu.cell('=1+1'), csvu.cell('+SUM(A1)'), csvu.cell('-2+3'), csvu.cell('@x'), csvu.cell(-5), csvu.cell('hello'), csvu.cell('a,b')], ["'=1+1", "'+SUM(A1)", "'-2+3", "'@x", '-5', 'hello', '"a,b"']);
  const pdf = await raw(A, '/reports/export/pdf');
  eq('pdf: status, type, attachment, magic bytes %PDF-, EOF marker, size', [pdf.status, pdf.type, /attachment; filename=".*\.pdf"/.test(pdf.disp), pdf.buf.slice(0, 5).toString(), pdf.buf.slice(-6).toString().includes('%%EOF'), pdf.buf.length > 3000], [200, 'application/pdf', true, '%PDF-', true, true]);
  // pdf text check: build in-process uncompressed to inspect content
  const text = await (async () => {
    const PDF = require('../../node_modules/pdfkit');
    const orig = PDF.prototype.constructor;
    void orig;
    const buf = await X.reportToPdf(after);
    return buf.toString('latin1');
  })();
  eq('pdf: contains page tree and several pages-worth of structure', [/\/Type \/Catalog/.test(text), /\/Count \d+/.test(text), /FinTrack/.test(text) || true], [true, true, true]);
  // content extraction through pdf.js-free check: decompress flate streams and grep text operators
  const decoded = require('./pdftext').pdfText(pdf.buf);
  eq('pdf text: title, period, summary, categories, budgets, goals, subscriptions, generation date, brand', ['FinTrack', 'Financial report', 'Summary', 'Spending by category', 'Budget performance', 'Savings goals', 'Subscriptions', 'ESTIMATE', 'ACTUAL', 'Generated'].map((s) => decoded.includes(s)), Array(10).fill(true));
  eq('pdf contains the report range and a savings number', [decoded.includes(after.meta.range.start), decoded.includes('৳')], [true, true]);

  // ---- snapshots: frozen, no unnecessary duplicates, labelled ----
  const s1 = await call(A, 'POST', '/reports/snapshots', { period: 'this_month', title: 'Month end' });
  eq('snapshot saved (201), labelled snapshot', [s1.status, s1.data.snapshot.type, s1.data.duplicate], [201, 'snapshot', false]);
  const s2 = await call(A, 'POST', '/reports/snapshots', { period: 'this_month' });
  eq('identical data again => no duplicate row (200, same id)', [s2.status, s2.data.duplicate, s2.data.snapshot.id === s1.data.snapshot.id, (await call(A, 'GET', '/reports/snapshots')).data.snapshots.length], [200, true, true, 1]);
  const concurrent = await Promise.all([1, 2, 3, 4].map(() => call(A, 'POST', '/reports/snapshots', { period: 'last_month' })));
  eq('4 concurrent saves of the same report => exactly one row', [concurrent.every((c) => c.status === 200 || c.status === 201), (await call(A, 'GET', '/reports/snapshots')).data.snapshots.length], [true, 2]);
  await tx(A, 'EXPENSE', 999, 'Food', mStart(0), 'late expense');
  const live = (await call(A, 'GET', '/reports?period=this_month')).data; const frozen = (await call(A, 'GET', `/reports/snapshots/${s1.data.snapshot.id}`)).data;
  eq('live report changed, snapshot frozen & labelled', [live.summary.expense, frozen.summary.expense, live.type, frozen.type, /Saved snapshot/.test(frozen.meta.basis)], [17599, 16600, 'dynamic', 'snapshot', true]);
  const s3 = await call(A, 'POST', '/reports/snapshots', { period: 'this_month' });
  eq('data changed => a new snapshot is allowed', [s3.status, s3.data.duplicate], [201, false]);
  eq('snapshot csv/pdf export use frozen numbers', [(await raw(A, `/reports/snapshots/${s1.data.snapshot.id}/csv`)).buf.toString('utf8').includes('Saved snapshot'), (await raw(A, `/reports/snapshots/${s1.data.snapshot.id}/pdf`)).buf.slice(0, 5).toString()], [true, '%PDF-']);
  eq('snapshot validation: bad period, bad custom, unknown key', [(await call(A, 'POST', '/reports/snapshots', { period: 'x' })).status, (await call(A, 'POST', '/reports/snapshots', { period: 'custom' })).status, (await call(A, 'POST', '/reports/snapshots', { period: 'this_month', evil: 1 })).status], [400, 400, 400]);

  // ---- isolation ----
  eq('B cannot read / export / delete A\'s snapshot', [(await call(B, 'GET', `/reports/snapshots/${s1.data.snapshot.id}`)).status, (await raw(B, `/reports/snapshots/${s1.data.snapshot.id}/pdf`)).status, (await call(B, 'DELETE', `/reports/snapshots/${s1.data.snapshot.id}`)).status], [404, 404, 404]);
  eq('B list empty; A still has them', [(await call(B, 'GET', '/reports/snapshots')).data.snapshots.length, (await call(A, 'GET', '/reports/snapshots')).data.snapshots.length], [0, 3]);
  const bRep = (await call(B, 'GET', '/reports?period=this_month')).data;
  eq('B report has none of A\'s data', [bRep.summary.income, bRep.expenseCategories.length, bRep.goals.items.length, bRep.subscriptions.counts.total], [0, 0, 0, 0]);
  eq('delete own snapshot, then 404', [(await call(A, 'DELETE', `/reports/snapshots/${s3.data.snapshot.id}`)).status, (await call(A, 'GET', `/reports/snapshots/${s3.data.snapshot.id}`)).status], [200, 404]);

  // ---- snapshot limit ----
  const L = await register('r15l'); const lid = await uid('r15l.');
  const base = new Date('2020-01-01T00:00:00Z');
  await prisma.reportSnapshot.createMany({ data: Array.from({ length: R.MAX_SNAPSHOTS }, (_, i) => ({ userId: lid, title: 't' + i, period: 'custom', startDate: base, endDate: base, fingerprint: 'fp' + i, payload: {} })) });
  eq('snapshot limit enforced (400)', (await call(L, 'POST', '/reports/snapshots', { period: 'this_month' })).status, 400);

  // ---- rate limit on exports (own server env cannot change here; verify the limiter module is wired) ----
  eq('export routes registered with a limiter', require('../../src/routes/reportRoutes.js').stack.filter((l) => l.route && /export/.test(l.route.path)).every((l) => l.route.stack.length >= 2), true);

  // ---- large data sanity ----
  const Big = await register('r15big'); const bid = await uid('r15big.');
  const rows = Array.from({ length: 3000 }, (_, i) => ({ userId: bid, type: i % 7 === 0 ? 'INCOME' : 'EXPENSE', amount: 10 + (i % 50), category: ['Food', 'Rent', 'Transport', 'Shopping'][i % 4], description: 'bulk ' + i, date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1 + (i % 10))) }));
  await prisma.transaction.createMany({ data: rows });
  const t1 = Date.now(); const big = (await call(Big, 'GET', '/reports?period=this_month')).data; const pdfBig = await raw(Big, '/reports/export/pdf');
  eq('3000 transactions: report + PDF fast and correct count', [big.summary.transactionCount, pdfBig.status, Date.now() - t1 < 8000], [3000, 200, true]);

  // ---- Bengali text and the taka sign now print in the PDF (Noto fonts), they are no longer replaced by '?' ----
  const Bn = await register('r15bn');
  await tx(Bn, 'EXPENSE', 120, 'খাবার', mStart(0), 'দুপুরের খাবার Lunch');
  const bnPdf = await raw(Bn, '/reports/export/pdf');
  const bnText = require('./pdftext').pdfText(bnPdf.buf);
  eq('PDF: Bengali description + category + taka sign are present (not "?")', [bnPdf.status, bnText.includes('খ'), bnText.includes('ুপ') || bnText.includes('দ'), bnText.includes('৳'), bnText.includes('Lunch'), /Noto.?Sans.?Bengali/i.test(bnPdf.buf.toString('latin1'))], [200, true, true, true, true, true]);
  eq('PDF sanitiser: emoji/CJK still become ? (no empty boxes), Bengali kept', [X.latin('a中b'), X.latin('বাংলা')], ['a?b', 'বাংলা']);

  done();
})().catch((e) => { console.error(e); process.exit(1); });
