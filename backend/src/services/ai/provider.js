// Backend-only connection to an external language model (default: the Anthropic Messages API). The browser never sees the key or talks to the provider.
//
//  * Configured ONLY through environment variables: ANTHROPIC_API_KEY (required), AI_MODEL, AI_API_URL, AI_TIMEOUT_MS (default 15000).
//  * The model is OPTIONAL: FinTrack answers every supported question without it. A user must opt in (AiSetting.externalAi), and what is sent is limited to the
//    question text plus the already-computed aggregate facts (never raw transaction lists with descriptions, e-mail, name or ids).
//  * What the provider does with that data is governed by the provider's own terms; FinTrack makes no confidentiality promise on their behalf.
//  * Failures (no key, timeout, HTTP error, bad body) throw ProviderError with a short code. The key and the request/response bodies are never logged.

class ProviderError extends Error { constructor(code) { super(code); this.name = 'ProviderError'; this.code = code; } }

const cfg = () => ({
  key: process.env.ANTHROPIC_API_KEY || '',
  url: process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages',
  model: process.env.AI_MODEL || 'claude-haiku-5-5',
  timeout: Number(process.env.AI_TIMEOUT_MS) || 15000,
});
const isConfigured = () => !!cfg().key && process.env.AI_ENABLED !== 'false';

async function complete({ system, user, maxTokens = 300 }) {
  const c = cfg();
  if (!c.key) throw new ProviderError('NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeout);
  let res;
  try {
    res = await fetch(c.url, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }) });
  } catch (err) { throw new ProviderError(err && err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); } finally { clearTimeout(timer); }
  if (res.status === 429) throw new ProviderError('PROVIDER_RATE_LIMITED');
  if (!res.ok) throw new ProviderError(`HTTP_${res.status}`);
  let body; try { body = await res.json(); } catch { throw new ProviderError('BAD_RESPONSE'); }
  const text = body && Array.isArray(body.content) ? body.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('').trim() : '';
  if (!text) throw new ProviderError('EMPTY_RESPONSE');
  return text.slice(0, 2000);
}

module.exports = { complete, isConfigured, ProviderError };
