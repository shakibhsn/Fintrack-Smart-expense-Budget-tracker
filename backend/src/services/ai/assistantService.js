const { z } = require('zod');
const prisma = require('../../config/prisma');
const httpError = require('../../utils/httpError');
const { runTool, userCategories, rangeSchema, resolveRange } = require('./tools');
const { parseQuestion, SUPPORTED_EXAMPLES } = require('./intent');
const { render, money } = require('./answer');
const provider = require('./provider');
const recommendations = require('./recommendationService');

// ---------------------------------------------------------------------------
// The assistant pipeline.
//   question -> (rules) tool + parameters -> validated tool run on the user's OWN data -> deterministic answer text
//            -> optionally (user opted in, server configured, daily cap not reached) the model REPHRASES that answer.
// The model never queries anything. Its text is accepted only if every number in it already appears in the computed facts; otherwise it is thrown
// away and the deterministic answer is shown. If the model cannot classify an unsupported question it may pick a tool from the same whitelist; the
// pick is validated like any other input. No SQL and no generated code is ever executed. Usage is logged without the question or any figures.
// ---------------------------------------------------------------------------

const DISCLAIMER = 'Educational information based on your own FinTrack records. It is not professional financial advice, and estimates are not guarantees.';
const MAX_QUESTION = 400;
const dailyProviderLimit = () => Number(process.env.AI_DAILY_PROVIDER_LIMIT) || 50;
const serverEnabled = () => process.env.AI_ENABLED !== 'false';

async function getSettings(userId) {
  const row = await prisma.aiSetting.findUnique({ where: { userId } });
  return { enabled: row ? row.enabled : true, externalAi: row ? row.externalAi : false };
}
const updateSettings = async (userId, patch) => {
  if (patch.externalAi === true && !provider.isConfigured()) throw httpError(409, 'No external AI service is set up on this server, so it cannot be switched on. The assistant still works without it.');
  const row = await prisma.aiSetting.upsert({ where: { userId }, create: { userId, ...patch }, update: patch });
  return { enabled: row.enabled, externalAi: row.externalAi };
};

const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
const usageToday = async (userId) => {
  const [all, prov] = await Promise.all([prisma.aiUsageLog.count({ where: { userId, createdAt: { gte: startOfDay() } } }), prisma.aiUsageLog.count({ where: { userId, source: 'PROVIDER', createdAt: { gte: startOfDay() } } })]);
  return { requests: all, providerCalls: prov, providerLimit: dailyProviderLimit() };
};
const log = (userId, tool, source, status, started) => prisma.aiUsageLog.create({ data: { userId, tool: tool || null, source, status, latencyMs: Math.min(60000, Date.now() - started) } }).catch(() => {});

async function status(userId) {
  const s = await getSettings(userId);
  return { serverEnabled: serverEnabled(), ...s, providerConfigured: provider.isConfigured(), usage: await usageToday(userId), disclaimer: DISCLAIMER, examples: SUPPORTED_EXAMPLES,
    privacy: 'Questions are answered inside FinTrack from your own data. If you switch on the external AI service, the text of your question and the summary figures of the answer (totals, category names, percentages; not individual transaction descriptions) are sent to that provider to help word the answer.' };
}

// ---- numbers guard: a model answer may only contain numbers that were computed by FinTrack ----
const numbersIn = (t) => (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, '')));
const numbersAllowed = (candidate, ...sources) => {
  const allowed = new Set(sources.flatMap(numbersIn).map(String));
  return numbersIn(candidate).every((n) => (Number.isInteger(n) && n >= 0 && n <= 9) || allowed.has(String(n)));
};

const PHRASE_SYSTEM = 'You rewrite financial facts into a short, friendly, plain-language answer (at most 90 words, plain text, no markdown). Use ONLY the numbers that appear in the draft or facts, written exactly as they appear. Do not calculate new numbers, do not invent transactions, budgets or savings, do not give guarantees, and say "estimate" when the facts say it is an estimate. Do not add advice that is not in the facts.';
const CLASSIFY_SYSTEM = 'You route a question about personal finances to exactly one tool. Reply with ONLY a JSON object, no prose: {"tool": "summary|categories|habits|transactions|budgets|health|savings_outlook|reduce", "range": "this_month|last_month|this_year|last_year|last_days:N|last_months:N", "category": "optional, must be one of the provided categories"}. If the question is not about the user\'s own finances, reply {"tool": null}.';

const parseRangeToken = (tok) => {
  if (!tok || typeof tok !== 'string') return { kind: 'this_month' };
  const m = /^(last_days|last_months):(\d{1,3})$/.exec(tok);
  if (m) return m[1] === 'last_days' ? { kind: 'last_days', days: Number(m[2]) } : { kind: 'last_months', months: Number(m[2]) };
  return { kind: tok };
};

async function classifyWithModel(question, categories) {
  const text = await provider.complete({ system: CLASSIFY_SYSTEM, user: JSON.stringify({ question, categories: categories.slice(0, 30) }), maxTokens: 120 });
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const schema = z.object({ tool: z.enum(['summary', 'categories', 'habits', 'transactions', 'budgets', 'health', 'savings_outlook', 'reduce']).nullable(), range: z.string().optional(), category: z.string().optional() });
  const j = schema.parse(json);
  if (!j.tool) return null;
  const range = rangeSchema.parse(parseRangeToken(j.range));
  const category = j.category && categories.includes(j.category) ? j.category : undefined;
  const params = { summary: { range }, categories: { range, type: 'EXPENSE' }, habits: { range }, transactions: { range, ...(category ? { category } : {}), limit: 10 }, budgets: {}, health: {}, savings_outlook: {}, reduce: {} }[j.tool];
  return { tool: j.tool, params, assumptions: ['The external AI service helped to understand this question; the figures were still calculated by FinTrack.'] };
}

async function runReduce(user, now) {
  const r = await recommendations.generate(user.id, user, now);
  if (!r.sufficient) return { tool: 'reduce', insufficient: r.message, facts: {}, method: '', range: null };
  const top = r.recommendations.filter((x) => x.estimate || x.kind === 'observation').slice(0, 3);
  if (!top.length) return { tool: 'reduce', insufficient: null, facts: { count: 0 }, rows: [], range: null, method: 'Rule-based review of your recent spending (see Recommendations for the rules).', empty: r.message };
  return { tool: 'reduce', range: null, facts: { count: top.length }, rows: top.map((t) => ({ title: t.title, text: t.text, estimate: t.estimate ? t.estimate.label : null })), method: 'Fixed rules compare this month with the same days last month, your budgets, your subscription costs and your savings rate. Each point lists the evidence it used on the Recommendations panel. Estimates are labelled and are not guaranteed savings.' };
}

function renderReduce(result, currency) {
  if (result.insufficient) return { text: result.insufficient, figures: [] };
  if (result.empty) return { text: result.empty, figures: [] };
  return { text: `Based on your recent data, here ${result.rows.length === 1 ? 'is' : 'are'} ${result.rows.length} thing${result.rows.length === 1 ? '' : 's'} worth a look: ${result.rows.map((r, i) => `${i + 1}. ${r.title}.`).join(' ')} These are observations from your own records, and any saving mentioned is an estimate, not a guarantee.`, figures: result.rows.map((r) => [r.title, r.estimate || r.text]) };
}

async function ask(user, { question, range }, now = new Date()) {
  const started = Date.now();
  const q = String(question || '').trim();
  if (!serverEnabled()) throw httpError(503, 'The AI assistant is switched off on this server.');
  const settings = await getSettings(user.id);
  if (!settings.enabled) throw httpError(403, 'The AI assistant is switched off in your settings.');
  if (q.length < 3) throw httpError(400, 'Please type a question.');
  if (q.length > MAX_QUESTION) throw httpError(400, `Questions can be at most ${MAX_QUESTION} characters.`);

  const categories = await userCategories(user.id);
  let usage = await usageToday(user.id);
  const modelOk = () => provider.isConfigured() && settings.externalAi && usage.providerCalls < usage.providerLimit;
  let providerNote = null; let providerUsed = false;

  let intent = parseQuestion(q, categories);
  if (!intent && modelOk()) {
    try { intent = await classifyWithModel(q, categories); providerUsed = true; usage = { ...usage, providerCalls: usage.providerCalls + 1 }; await log(user.id, intent && intent.tool, 'PROVIDER', 'CLASSIFY', started); }
    catch (err) { providerNote = 'The external AI service could not help with this question.'; await log(user.id, null, 'PROVIDER', `PROVIDER_ERROR:${err.code || 'BAD_OUTPUT'}`, started); }
  }
  if (!intent) {
    await log(user.id, null, 'ENGINE', 'UNSUPPORTED', started);
    return { answer: 'I can only answer questions about your own FinTrack data. Try one of the examples below.', unsupported: true, aiGenerated: false, source: 'engine', examples: SUPPORTED_EXAMPLES, disclaimer: DISCLAIMER, providerNote };
  }

  // an explicit date filter chosen in the UI overrides the period found in the text (for tools that take one)
  const params = { ...intent.params };
  if (range && ['summary', 'categories', 'habits', 'transactions'].includes(intent.tool)) { params.range = rangeSchema.parse(range); intent.assumptions = (intent.assumptions || []).filter((a) => !a.startsWith('No time')); }
  if (range && intent.tool === 'compare') { intent.assumptions = [...(intent.assumptions || []), 'The date filter was ignored because comparisons use two periods taken from your question.']; }

  const result = intent.tool === 'reduce' ? await runReduce(user, now) : await runTool(user.id, intent.tool, params, now);
  const cur = user.currency || 'BDT';
  const rendered = intent.tool === 'reduce' ? renderReduce(result, cur) : render(result, { currency: cur, focus: intent.focus });
  const base = {
    answer: rendered.text, figures: rendered.figures, tool: result.tool, params: result.params || params, range: result.range || null, method: result.method || '',
    assumptions: intent.assumptions || [], insufficient: !!result.insufficient, isEstimate: !!result.isEstimate, disclaimer: DISCLAIMER, aiGenerated: false, source: 'engine', providerNote,
  };

  // optional rephrasing; only for answers that have real figures and only if the user opted in
  if (!result.insufficient && !result.empty && modelOk() && !providerUsed) {
    const facts = { tool: result.tool, range: result.range, facts: result.facts, rows: (result.rows || []).filter(() => !(result.localOnly || []).includes('rows')).map((r) => (r.description !== undefined ? { ...r, description: undefined } : r)), currency: cur, isEstimate: !!result.isEstimate };
    try {
      const phrased = await provider.complete({ system: PHRASE_SYSTEM, user: JSON.stringify({ question: q, draftAnswer: rendered.text, facts }), maxTokens: 250 });
      if (numbersAllowed(phrased, rendered.text, JSON.stringify(facts), q)) { base.answer = phrased; base.aiGenerated = true; base.source = 'engine+model'; await log(user.id, result.tool, 'PROVIDER', 'OK', started); }
      else { base.providerNote = 'The external AI service returned a wording with numbers FinTrack did not calculate, so it was discarded. Showing the calculated answer.'; await log(user.id, result.tool, 'PROVIDER', 'PROVIDER_REJECTED', started); }
    } catch (err) {
      base.providerNote = 'The external AI service is unavailable right now, so this answer was calculated by FinTrack without it.';
      await log(user.id, result.tool, 'PROVIDER', `PROVIDER_ERROR:${err.code || 'ERROR'}`, started);
    }
    return base;
  }
  await log(user.id, result.tool, providerUsed ? 'PROVIDER' : 'ENGINE', result.insufficient ? 'INSUFFICIENT' : 'OK', started);
  if (providerUsed) base.source = 'engine+model';
  return base;
}

async function getRecommendations(user, now = new Date()) {
  const settings = await getSettings(user.id);
  if (!serverEnabled() || !settings.enabled) throw httpError(403, 'The AI assistant is switched off.');
  const started = Date.now();
  const r = await recommendations.generate(user.id, user, now);
  await log(user.id, 'recommendations', 'ENGINE', r.sufficient ? 'OK' : 'INSUFFICIENT', started);
  return r;
}

module.exports = { ask, status, getSettings, updateSettings, getRecommendations, DISCLAIMER, numbersAllowed, MAX_QUESTION, resolveRange, money };
