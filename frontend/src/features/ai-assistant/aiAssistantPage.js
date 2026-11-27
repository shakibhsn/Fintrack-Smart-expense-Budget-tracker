import { html, render, $ } from '../../core/dom.js';
import { StaleError, logError } from '../../core/logger.js';
import { pageHeader, button, card, icon, badge, select } from '../../components/ui.js';
import { emptyState, errorState } from '../../components/states.js';
import { skeletonRows } from '../../components/skeleton.js';
import { toast, toastError } from '../../components/toast.js';
import { getStatus, saveSettings, ask, getRecommendations, dismissRecommendation, RANGES, rangeObject } from './aiService.js';

// Conversation history lives only in this page's memory (nothing is stored on the server or in the browser), so leaving the page clears it.
export default {
  styles: [new URL('./ai.css', import.meta.url).href],

  mount(ctx) {
    let status = null; let busy = false; let lastQuestion = '';
    const messages = []; // { role: 'user'|'bot'|'error', ... }

    render(ctx.outlet, html`
      ${pageHeader({ title: 'AI Financial Assistant', subtitle: 'Ask about your own spending, budgets and savings. Answers are calculated from your FinTrack data and explained step by step.' })}
      <p class="ai-disclaimer" id="ai-disclaimer" style="margin-bottom:12px">${icon('circle-info')} Educational information based on your own records. It is not professional financial advice, and estimates are not guarantees.</p>
      <div class="ai-layout">
        <div class="ai-chat">
          ${card({ title: 'Ask a question', body: html`
            <div id="ai-state"></div>
            <div class="ai-log" id="ai-log" aria-live="polite" aria-label="Conversation"></div>
            <form class="ai-form" id="ai-form" novalidate style="margin-top:12px">
              <div class="field" style="margin:0"><label class="label" for="ai-q">Your question</label><input class="input" id="ai-q" maxlength="400" autocomplete="off" placeholder="e.g. How much did I spend this month?"><p class="field-error" id="ai-q-error" role="alert" hidden></p></div>
              ${button({ label: 'Ask', icon: 'paper-plane', type: 'submit' })}
            </form>
            <div class="ai-form-row" style="margin-top:8px"><div style="min-width:220px">${select({ id: 'ai-range', label: 'Period', options: RANGES, value: '' })}</div>${button({ label: 'Clear conversation', icon: 'eraser', variant: 'ghost', size: 'sm', action: 'clear' })}</div>
            <div class="ai-chips" id="ai-chips" style="margin-top:10px" role="group" aria-label="Example questions"></div>` })}
        </div>
        <div class="grid gap-4">
          <div id="ai-recs"></div>
          <div id="ai-settings"></div>
        </div>
      </div>`);
    const log = $('#ai-log', ctx.outlet);
    const qInput = $('#ai-q', ctx.outlet);

    const drawChips = () => render($('#ai-chips', ctx.outlet), html`${(status ? status.examples : []).map((e) => html`<button type="button" class="chip" data-example="${e}">${e}</button>`)}`);

    const botCard = (m) => {
      const d = m.data;
      return html`<div class="ai-msg-bot" data-kind="${d.insufficient || d.unsupported ? 'insufficient' : 'ok'}">
        <div class="ai-tags">${d.aiGenerated ? badge('AI-worded by an external model', 'accent') : badge('Calculated by FinTrack', 'brand')}${d.isEstimate ? badge('ESTIMATE', 'warning') : ''}${d.insufficient ? badge('Not enough data', 'warning') : ''}</div>
        <div class="ai-answer">${d.answer}</div>
        ${d.providerNote ? html`<p class="card-sub">${icon('triangle-exclamation')} ${d.providerNote}</p>` : ''}
        ${d.assumptions && d.assumptions.length ? html`<p class="card-sub">${d.assumptions.join(' ')}</p>` : ''}
        ${d.figures && d.figures.length ? html`<div class="ai-figs">${d.figures.map((f) => html`<div class="ai-fig"><span>${f[0]}</span><span>${f[1]}</span></div>`)}</div>` : ''}
        ${d.method ? html`<details><summary class="text-xs font-bold" style="cursor:pointer">How was this calculated?</summary><p class="card-sub" style="margin-top:6px">${d.method}${d.range ? ` Period: ${d.range.label || ''}${d.range.from ? ` (${d.range.from} to ${d.range.to})` : ''}.` : ''}</p></details>` : ''}
        ${d.unsupported ? html`<p class="card-sub">Examples you can ask: ${d.examples.slice(0, 4).join(' · ')}</p>` : ''}
      </div>`;
    };

    function drawLog() {
      if (!messages.length) { render(log, html`<div class="ai-empty"><span class="icon-chip">${icon('comments')}</span><div><b>Ask your first question</b><br>Pick an example below or type your own. Everything is calculated from your recorded transactions, budgets and subscriptions.</div></div>`); return; }
      render(log, html`${messages.map((m) => (m.role === 'user' ? html`<div class="ai-msg-user">${m.text}</div>` : m.role === 'error' ? html`<div class="ai-msg-bot" data-kind="insufficient"><p class="ai-answer">${icon('circle-xmark')} ${m.text}</p>${button({ label: 'Try again', icon: 'rotate-right', variant: 'secondary', size: 'sm', action: 'retry' })}</div>` : botCard(m)))}${busy ? html`<div class="ai-msg-bot" aria-busy="true">${skeletonRows(1, 40)}</div>` : ''}`);
      log.scrollTop = log.scrollHeight;
    }

    function drawState() {
      const box = $('#ai-state', ctx.outlet);
      if (!status) { render(box, ''); return; }
      if (!status.serverEnabled) render(box, html`<p class="ie-warn" style="margin-bottom:10px">${icon('power-off')} The AI assistant is switched off on this server. The rest of FinTrack works as usual.</p>`);
      else if (!status.enabled) render(box, html`<p class="ie-warn" style="margin-bottom:10px">${icon('power-off')} The assistant is switched off in your settings (right). Switch it on to ask questions.</p>`);
      else render(box, '');
      const off = !status.serverEnabled || !status.enabled;
      $('#ai-q', ctx.outlet).disabled = off; $('#ai-form button[type="submit"]', ctx.outlet).disabled = off || busy;
    }

    function drawSettings() {
      const s = status;
      render($('#ai-settings', ctx.outlet), card({ title: 'AI settings', body: html`
        <label class="nc-pref"><input type="checkbox" class="switch" role="switch" data-set="enabled" ${s.enabled ? 'checked' : ''} ${s.serverEnabled ? '' : 'disabled'}><span>Enable the AI assistant</span></label>
        <label class="nc-pref" style="margin-top:8px"><input type="checkbox" class="switch" role="switch" data-set="externalAi" ${s.externalAi ? 'checked' : ''} ${s.providerConfigured ? '' : 'disabled'}><span>Let an external AI model word the answers</span></label>
        ${s.providerConfigured ? '' : html`<p class="card-sub" style="margin-top:6px">No external AI service is set up on this server, so every answer is calculated by FinTrack itself. Nothing is sent anywhere.</p>`}
        <p class="card-sub" style="margin-top:8px">${s.privacy}</p>
        <p class="card-sub" style="margin-top:6px">Today: ${s.usage.requests} request${s.usage.requests === 1 ? '' : 's'}${s.providerConfigured ? `, ${s.usage.providerCalls} of ${s.usage.providerLimit} external AI calls` : ''}.</p>` }));
    }

    async function loadStatus() {
      try { status = await ctx.alive(getStatus()); drawChips(); drawState(); drawSettings(); }
      catch (err) { if (err instanceof StaleError) return; logError('ai-status', err); render($('#ai-settings', ctx.outlet), card({ body: errorState({ error: err, title: 'Could not load AI settings' }) })); }
    }

    async function loadRecs() {
      const box = $('#ai-recs', ctx.outlet);
      render(box, card({ title: 'Recommendations', body: skeletonRows(3, 60) }));
      try {
        const r = await ctx.alive(getRecommendations());
        render(box, card({ title: 'Recommendations', subtitle: 'From fixed rules applied to your own data. Observations are facts; estimates are labelled.',
          body: !r.sufficient ? emptyState({ icon: 'seedling', title: 'Not enough data yet', text: r.message })
            : !r.recommendations.length ? emptyState({ icon: 'circle-check', title: 'Nothing stands out', text: r.message })
              : html`<div class="grid gap-3">${r.recommendations.map((x) => html`<div class="ai-rec" data-sev="${x.severity}">
                  <div class="ai-tags">${badge(x.kind === 'estimate' ? 'Estimate' : 'Observation', x.kind === 'estimate' ? 'warning' : 'brand')}<b class="text-sm">${x.title}</b></div>
                  <p class="card-sub">${x.text}</p>
                  ${x.estimate ? html`<p class="card-sub"><b>${x.estimate.label}</b></p>` : ''}
                  <details><summary class="text-xs font-bold" style="cursor:pointer">Why am I seeing this?</summary><ul class="ie-rules" style="margin-top:6px">${x.why.map((w) => html`<li>${w}</li>`)}</ul></details>
                  <div>${button({ label: 'Dismiss', icon: 'xmark', variant: 'ghost', size: 'sm', action: 'dismiss', attrs: { 'data-key': x.key } })}</div></div>`)}</div>` }));
      } catch (err) {
        if (err instanceof StaleError) return;
        if (!(err.status >= 400 && err.status < 500)) logError('ai-recs', err);
        render(box, card({ title: 'Recommendations', body: errorState({ error: err, title: err.status === 403 ? 'The assistant is switched off' : 'Could not load recommendations', retry: err.status !== 403 }) }));
      }
    }

    async function send(question) {
      const q = String(question || '').trim();
      const errBox = $('#ai-q-error', ctx.outlet);
      if (q.length < 3) { errBox.hidden = false; errBox.textContent = 'Please type a question (at least 3 characters).'; return; }
      errBox.hidden = true;
      if (busy) return;
      busy = true; lastQuestion = q; messages.push({ role: 'user', text: q }); qInput.value = ''; drawState(); drawLog();
      try {
        const data = await ctx.alive(ask(q, rangeObject($('#ai-range', ctx.outlet).value)));
        messages.push({ role: 'bot', data });
      } catch (err) {
        if (err instanceof StaleError) return;
        if (!(err.status >= 400 && err.status < 500)) logError('ai-ask', err);
        messages.push({ role: 'error', text: err.status === 429 ? err.message : err.status === 403 || err.status === 503 ? err.message : `Could not get an answer: ${err.message || 'something went wrong'}. The rest of FinTrack still works.` });
      } finally { busy = false; drawState(); drawLog(); loadStatusQuiet(); }
    }
    const loadStatusQuiet = () => getStatus().then((s) => { if (ctx.isActive()) { status = s; drawSettings(); } }).catch(() => {});

    ctx.on(ctx.outlet, 'submit', '#ai-form', (e) => { e.preventDefault(); send(qInput.value); });
    ctx.on(ctx.outlet, 'click', '[data-example]', (e, el) => { if (!status || !status.enabled || !status.serverEnabled) return; qInput.value = el.dataset.example; send(el.dataset.example); });
    ctx.on(ctx.outlet, 'click', '[data-action="clear"]', () => { messages.length = 0; drawLog(); });
    ctx.on(ctx.outlet, 'click', '[data-action="retry"]', () => { messages.pop(); drawLog(); send(lastQuestion); });
    ctx.on($('#ai-recs', ctx.outlet), 'click', '[data-action="dismiss"]', async (e, el) => {
      try { await dismissRecommendation(el.dataset.key); toast('Dismissed. It will not come back this month.', 'success'); loadRecs(); } catch (err) { toastError(err); }
    });
    ctx.on($('#ai-recs', ctx.outlet), 'click', '[data-action="retry"]', () => loadRecs());
    ctx.on($('#ai-settings', ctx.outlet), 'change', '[data-set]', async (e, el) => {
      try { status = { ...status, ...(await saveSettings({ [el.dataset.set]: el.checked })) }; toast('Setting saved.', 'success'); drawState(); drawSettings(); if (el.dataset.set === 'enabled') loadRecs(); }
      catch (err) { el.checked = !el.checked; toastError(err); }
    });

    drawLog(); loadStatus(); loadRecs();
  },
};
