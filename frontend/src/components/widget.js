import { render, on } from '../core/dom.js';
import { logError, StaleError } from '../core/logger.js';
import { errorState } from './states.js';
import { skeletonBlock } from './skeleton.js';

// Widget-level error isolation. A widget is one self-contained section of a page (a card, a chart, a list):
//
//   const reload = mountWidget(ctx, el, { load: () => service.get(), render: (data, el) => ..., title: 'Recent transactions' });
//
// It shows a skeleton while loading, renders the data, and if the request OR the render fails it shows an error state with a
// Retry button in that section only. Sibling widgets, the page and the rest of the app are unaffected.
export function mountWidget(ctx, el, { load, render: draw, skeleton = skeletonBlock(120), title = 'This section', retry = true } = {}) {
  const run = async () => {
    render(el, skeleton);
    try {
      const data = await ctx.alive(load());
      try {
        draw(data, el);
      } catch (err) {
        logError('widget:render', err, { widget: title });
        render(el, errorState({ error: err, title: `${title} could not be displayed`, retry }));
      }
    } catch (err) {
      if (err instanceof StaleError) return;
      logError('widget:load', err, { widget: title });
      render(el, errorState({ error: err, title: `${title} could not be loaded`, retry }));
    }
  };
  on(el, 'click', '[data-action="retry"]', (e) => { e.stopPropagation(); run(); }, { signal: ctx.signal });
  run();
  return run;
}
