import { html, render } from '../../core/dom.js';
import { pageHeader, badge, card, icon } from '../../components/ui.js';
import { emptyState } from '../../components/states.js';
import { skeletonCards } from '../../components/skeleton.js';
import { mountWidget } from '../../components/widget.js';
import { getInsights } from './insightService.js';
import { INSIGHT_STYLE, INSIGHT_ORDER, INSIGHT_GROUPS } from './insightStyles.js';

// Smart Insights: fixed rules over the user's own transactions, budgets and goals (no AI/ML is claimed).
// "Why?" on every insight shows the rule and numbers behind it.
const insightCard = (i) => {
  const st = INSIGHT_STYLE[i.type] || INSIGHT_STYLE.info;
  return html`<article class="card card-pad ins-card">
    <div class="ins-head">${badge(html`${icon(st.icon)} ${st.label}`, st.tone)}<h3 class="ins-title">${i.title}</h3></div>
    <p class="text-sm">${i.message}</p>
    <details><summary>Why am I seeing this?</summary><p>${i.reason}</p></details>
  </article>`;
};

export default {
  styles: [new URL('./insights.css', import.meta.url).href],

  mount(ctx) {
    render(ctx.outlet, html`
      ${pageHeader({ title: 'Smart Insights', subtitle: 'Observations calculated from your own transactions, budgets and goals using fixed rules (no AI or machine learning). Open “Why am I seeing this?” on any insight to see the rule and numbers behind it.' })}
      <p class="card-sub" id="ins-period" style="margin:-8px 0 16px"></p>
      <div id="ins-body"></div>`);

    mountWidget(ctx, ctx.outlet.querySelector('#ins-body'), {
      title: 'Insights',
      skeleton: skeletonCards(3, 130),
      load: getInsights,
      render: (d, el) => {
        if (d.period) ctx.outlet.querySelector('#ins-period').textContent = `Based on ${d.period.label} (${d.period.start} to ${d.period.end}), compared with the previous period.`;
        if (!d.sufficient) {
          render(el, card({ body: emptyState({ icon: 'lightbulb', title: 'Not enough data yet', text: d.message, actions: html`<a class="btn btn-primary" href="#/transactions">Add transactions</a>` }) }));
          return;
        }
        const groups = INSIGHT_GROUPS.map(([key, title, ic]) => [key, title, ic, [...(d.groups[key] || [])].sort((a, b) => INSIGHT_ORDER[a.type] - INSIGHT_ORDER[b.type])]).filter((g) => g[3].length);
        render(el, groups.length
          ? html`<div class="ins-groups">${groups.map(([, title, ic, items]) => html`<section><h2 class="ins-group-title"><span class="icon-chip" style="width:32px;height:32px">${icon(ic, 'text-sm')}</span>${title}</h2><div class="ins-list">${items.map(insightCard)}</div></section>`)}</div>`
          : card({ body: emptyState({ icon: 'circle-check', title: 'Nothing notable right now', text: d.message || 'No insights were triggered for this period.' }) }));
      },
    });
  },
};
