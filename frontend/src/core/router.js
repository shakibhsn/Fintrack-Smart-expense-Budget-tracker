import { ROUTES, DEFAULT_ROUTE, findRoute } from './routes.js';
import { isAuthenticated, redirectToLogin } from './session.js';
import { html, render, on as domOn } from './dom.js';
import { logError, StaleError } from './logger.js';
import { errorState } from '../components/states.js';
import { pageSkeleton } from '../components/skeleton.js';
import { closeAllModals } from '../components/modal.js';

// Hash router with per-page lifecycle.
//
// A page module's default export is   { mount(ctx), styles?: [cssUrl] }.
// ctx gives the page everything it needs AND a way to clean up after itself:
//   ctx.outlet            the content element to render into
//   ctx.query             parsed ?query of the hash, e.g. #/transactions?search=rent -> { search: 'rent' }
//   ctx.signal            aborted when the user leaves the page (pass to addEventListener / fetch-like APIs)
//   ctx.onCleanup(fn)     run fn when leaving (destroy charts, clear timers...)
//   ctx.on(root,type,sel,fn)  delegated listener that is removed automatically
//   ctx.alive(promise)    await a promise; throws StaleError if the user has navigated away meanwhile
//   ctx.isActive()        is this page still the current one?
//   ctx.refresh()         re-mount the current page (fresh data)
//
// Error isolation: loading or mounting a page is wrapped, so a failure shows an error state INSIDE the content area
// while the sidebar, top bar and navigation keep working.

const loadedStyles = new Set();
let outletEl = null;
let current = null; // { route, abort, cleanups }
let navId = 0;
let firstRender = true; // do not steal focus on the very first page load: keyboard users should start at the skip link
let listeners = [];

export const onRouteChange = (fn) => { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn); }; };

export function parseHash(hash = window.location.hash) {
  const raw = hash.replace(/^#/, '') || DEFAULT_ROUTE;
  const [path, search = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  return { path: path.length > 1 ? path.replace(/\/+$/, '') : path, query };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (window.location.hash === target) return refresh();
  if (replace) window.location.replace(target); else window.location.hash = target;
  return undefined;
}

function injectStyles(urls = []) {
  urls.forEach((href) => {
    if (loadedStyles.has(href)) return;
    loadedStyles.add(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  });
}

function announce(text) {
  const el = document.getElementById('route-announcer');
  if (el) el.textContent = text;
}

async function teardown() {
  if (!current) return;
  const { abort, cleanups } = current;
  current = null;
  abort.abort();
  closeAllModals();
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch (err) { logError('cleanup', err); }
  }
}

function createContext(route, query, myNav) {
  const abort = new AbortController();
  const cleanups = [];
  const ctx = {
    route,
    outlet: outletEl,
    query,
    signal: abort.signal,
    isActive: () => navId === myNav && !abort.signal.aborted,
    onCleanup: (fn) => cleanups.push(fn),
    on: (root, type, selector, handler) => domOn(root, type, selector, handler, { signal: abort.signal }),
    alive: async (promise) => {
      const value = await promise;
      if (navId !== myNav || abort.signal.aborted) throw new StaleError();
      return value;
    },
    refresh,
    navigate,
  };
  return { ctx, abort, cleanups };
}

function showFailure(route, error, { chunk = false } = {}) {
  render(outletEl, html`<div class="page-enter">${errorState({
    error,
    title: chunk ? `Could not load ${route ? route.title : 'this page'}` : `${route ? route.title : 'This page'} ran into a problem`,
    home: true,
  })}</div>`);
  // listener on the button itself (not delegated on the outlet), so it dies with the button when the page changes
  outletEl.querySelector('[data-action="retry"]')?.addEventListener('click', () => refresh(), { once: true });
}

async function resolve() {
  const myNav = ++navId;
  // an empty/bare hash means 'home': show the default route AND make the address bar say so
  if (!window.location.hash || window.location.hash === '#') history.replaceState(null, '', `#${DEFAULT_ROUTE}`);
  const { path, query } = parseHash();

  if (!isAuthenticated()) { redirectToLogin({ expired: false }); return; }
  await teardown();
  if (myNav !== navId) return;

  const route = findRoute(path);
  listeners.forEach((l) => l({ route, path, query }));

  if (!route) {
    document.title = 'Page not found · FinTrack';
    render(outletEl, html`<div class="page-enter state">
      <div class="state-icon"><i class="fa-solid fa-compass" aria-hidden="true"></i></div>
      <h1 class="state-title" id="page-title">Page not found</h1>
      <p class="state-text">There is no page at <code>#${path}</code>. It may have moved, or the link may be mistyped.</p>
      <div class="state-actions"><a class="btn btn-primary" href="#${DEFAULT_ROUTE}">Go to dashboard</a></div></div>`);
    announce('Page not found');
    return;
  }

  document.title = `${route.title} · FinTrack`;
  render(outletEl, pageSkeleton());

  let mod;
  try {
    mod = await route.load();
  } catch (err) {
    if (myNav !== navId) return;
    logError('router:load', err, { route: route.path });
    showFailure(route, Object.assign(new Error('The page could not be downloaded. Check your connection and try again.'), { code: 'NETWORK' }), { chunk: true });
    return;
  }
  if (myNav !== navId) return;

  const page = mod.default;
  injectStyles(page.styles);
  const { ctx, abort, cleanups } = createContext(route, query, myNav);
  current = { route, abort, cleanups };
  render(outletEl, '');
  const wrapper = document.createElement('div');
  wrapper.className = 'page-enter';
  outletEl.appendChild(wrapper);
  ctx.outlet = wrapper;

  try {
    await page.mount(ctx);
  } catch (err) {
    if (err instanceof StaleError || myNav !== navId) return;
    logError('router:mount', err, { route: route.path });
    await teardown();
    showFailure(route, err);
    return;
  }
  if (myNav !== navId) return;
  announce(`${route.title} page loaded`);
  // after a route CHANGE move focus to the content so keyboard/screen-reader users are not left in the sidebar
  if (!firstRender) outletEl.focus({ preventScroll: true });
  firstRender = false;
}

export function refresh() { return resolve(); }

export function start(outlet) {
  outletEl = outlet;
  window.addEventListener('hashchange', resolve);
  if (!window.location.hash) window.location.replace(`#${DEFAULT_ROUTE}`); // triggers hashchange
  else resolve();
}

export const routes = ROUTES;
