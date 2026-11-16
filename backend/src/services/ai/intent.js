// Rule-based understanding of supported questions (no AI needed). Output is ONLY a tool name plus parameters from the closed vocabulary
// in tools.js, which validates them again. Anything it cannot match returns null (the optional external model may then classify it into the
// same whitelist, and the result is validated just the same).

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// all time expressions in the order they appear: [{ index, spec, text }]
function detectRanges(q) {
  const out = [];
  const add = (re, fn) => { for (const m of q.matchAll(re)) out.push({ index: m.index, spec: fn(m), text: m[0] }); };
  add(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/g, (m) => ({ kind: 'last_days', days: Number(m[1]) }));
  add(/\b(?:last|past|previous)\s+(\d{1,2})\s+months?\b/g, (m) => ({ kind: 'last_months', months: Number(m[1]) }));
  add(/\b(?:last|past)\s+week\b/g, () => ({ kind: 'last_days', days: 7 }));
  add(/\b(?:this|current)\s+month\b/g, () => ({ kind: 'this_month' }));
  add(/\b(?:last|previous)\s+month\b/g, () => ({ kind: 'last_month' }));
  add(/\b(?:this|current)\s+year\b/g, () => ({ kind: 'this_year' }));
  add(/\b(?:last|previous)\s+year\b/g, () => ({ kind: 'last_year' }));
  add(/\btoday\b/g, () => ({ kind: 'last_days', days: 1 }));
  return out.sort((a, b) => a.index - b.index).filter((r, i, arr) => !arr.slice(0, i).some((p) => Math.abs(p.index - r.index) < 3));
}

const findCategory = (q, categories) => (categories || []).filter((c) => new RegExp(`(^|[^a-z0-9])${esc(c.toLowerCase())}s?([^a-z0-9]|$)`).test(q)).sort((a, b) => b.length - a.length)[0] || null;

function parseQuestion(question, categories = []) {
  const q = ` ${String(question || '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  if (q.trim().length < 3) return null;
  const ranges = detectRanges(q);
  const assumptions = [];
  const range = ranges.length ? ranges[0].spec : (assumptions.push('No time period was given, so I used this month so far.'), { kind: 'this_month' });
  const category = findCategory(q, categories);
  const yes = (re) => re.test(q);

  if (yes(/\b(compare|comparison|versus|vs\.?|difference between|compared (to|with))\b/)) {
    let a = ranges[0] ? ranges[0].spec : { kind: 'this_month' }; let b = ranges[1] ? ranges[1].spec : { kind: 'last_month' };
    if (!ranges[0]) assumptions.push('No periods were given, so I compared this month with last month.'); else if (!ranges[1]) { if (a.kind === 'this_month') b = { kind: 'last_month' }; else assumptions.push('Only one period was given, so I compared it with last month.'); }
    return { tool: 'compare', params: { a, b, ...(category ? { category } : {}) }, assumptions: ranges[0] ? assumptions.filter((x) => !x.startsWith('No time')) : assumptions };
  }
  if (yes(/\b(budgets?)\b/)) return { tool: 'budgets', params: {}, assumptions: [] };
  if (yes(/\bhealth\b/)) return { tool: 'health', params: {}, assumptions: [] };
  if (yes(/(next month|forecast|expect(ed)? to save|will i save|potentially save|could i save|can i save|how much .*sav)/) && !yes(/\b(did|have) i (save|saved)\b/) && !yes(/\b(this|last) (month|year)\b.*\bsaved\b/)) {
    if (yes(/next month|forecast|potential|could|can i|will i|expect/)) return { tool: 'savings_outlook', params: {}, assumptions: [] };
  }
  if (yes(/\b(reduce|cut (down|back)?|lower|spend less|spending less|save more|how (can|do|could) i save|trim)\b/)) return { tool: 'reduce', params: {}, assumptions: [] };
  if (yes(/\b(habits?|patterns?|behaviou?rs?|tendenc)/)) return { tool: 'habits', params: { range: ranges.length ? range : { kind: 'last_months', months: 3 } }, assumptions: ranges.length ? [] : ['No time period was given, so I looked at the last 3 months.'] };
  if (yes(/\b(did|have) i (save|saved)\b|\bhow much .*\bsaved?\b|\bmy savings\b|\bsavings (this|last)\b/)) return { tool: 'summary', params: { range }, assumptions, focus: 'savings' };
  if (yes(/(which|what) (spending )?categor|most (of )?my money|biggest (category|spend)|top (categor|spend)|consum|where (does|did) my money/)) return { tool: 'categories', params: { range, type: yes(/\b(income|earn)/) ? 'INCOME' : 'EXPENSE' }, assumptions };
  if ((yes(/^ ?(show|list|display|give me|see)\b/) || yes(/\btransactions?\b/)) && yes(/\b(expenses?|transactions?|income|spending|purchases?)\b/)) {
    return { tool: 'transactions', params: { range, ...(yes(/\bincome\b/) ? { type: 'INCOME' } : yes(/\b(expenses?|spending|purchases?)\b/) ? { type: 'EXPENSE' } : {}), ...(category ? { category } : {}), limit: 10 }, assumptions };
  }
  if (category && yes(/\b(spend|spent|spending|expense|cost)/)) return { tool: 'transactions', params: { range, type: 'EXPENSE', category, limit: 5 }, assumptions };
  if (yes(/\b(spend|spent|spending|expenses?|income|earn|earned|made|total|balance)\b/)) return { tool: 'summary', params: { range }, assumptions, focus: yes(/\bincome|earn|made\b/) ? 'income' : 'expense' };
  return null;
}

const SUPPORTED_EXAMPLES = [
  'How much did I spend this month?', 'Which category consumed most of my money last month?', 'Compare my food spending this month and last month',
  'Show my expenses from the last 30 days', 'How much did I save this year?', 'Am I staying within my budgets?', 'How can I reduce my monthly expenses?',
  'How much can I potentially save next month?', 'What are my biggest spending habits?', 'How is my financial health?',
];

module.exports = { parseQuestion, detectRanges, findCategory, SUPPORTED_EXAMPLES };
