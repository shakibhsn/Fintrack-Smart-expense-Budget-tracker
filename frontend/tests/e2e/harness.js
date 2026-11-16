// Browser-test harness for the modular frontend: static server (correct MIME for ES modules) on :5600,
// run against a TEST backend on :5055 whose CLIENT_URL is http://localhost:5600 (see README.md in this folder);
// API calls :5000 -> :5055 (the test backend), puppeteer-core attached to Edge on :9333.
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..'); // the frontend folder
const SP = path.join(__dirname, 'screenshots');
require('fs').mkdirSync(SP, { recursive: true });
const PORT = 5600;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const hits = []; // every file the browser requested (to prove lazy loading)

function serve() {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    hits.push(p);
    const f = path.join(ROOT, p === '/' ? 'fintrack_application.html' : p);
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(p.includes('favicon') ? 204 : 404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b);
    });
  });
  return new Promise((r) => srv.listen(PORT, () => r(srv)));
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

async function open(token, { viewport = 'desktop', hash = '', failMatch = null, delayMatch = null, delayMs = 0, theme = null, extraStorage = {}, noToken = false, blockMatch = null, mock = null } = {}) {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333' });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORTS[viewport] || VIEWPORTS.desktop);
  const errors = []; const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.setRequestInterception(true);
  page.on('request', (rq) => {
    const u = rq.url();
    if (u.includes('localhost:5000/')) requests.push(rq.method() + ' ' + u.replace('http://localhost:5000', ''));
    if (blockMatch && u.includes(blockMatch)) { rq.abort(); return; }
    if (mock && u.includes(mock.match) && rq.method() === 'OPTIONS') { rq.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } }); return; }
    if (mock && u.includes(mock.match)) { rq.respond({ status: mock.status || 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify(mock.body) }); return; }
    if (failMatch && u.includes(failMatch) && rq.method() === 'OPTIONS') rq.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    else if (failMatch && u.includes(failMatch)) rq.respond({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify({ success: false, message: 'Boom from server' }) });
    else if (delayMatch && u.includes(delayMatch)) setTimeout(() => rq.continue(u.startsWith('http://localhost:5000/') ? { url: u.replace(':5000', ':5055') } : {}), delayMs);
    else if (u.startsWith('http://localhost:5000/')) rq.continue({ url: u.replace(':5000', ':5055') });
    else rq.continue();
  });
  await page.evaluateOnNewDocument((t, th, extra, none) => {
    if (!sessionStorage.getItem('__seeded')) { // seed ONCE per tab so reloads/redirects see the app's own changes
      sessionStorage.setItem('__seeded', '1');
      if (!none && t) { localStorage.setItem('fintrack_token', t); localStorage.setItem('fintrack_user', JSON.stringify({ name: 'Test User', email: 't@t.dev' })); }
      if (th) localStorage.setItem('fintrack_theme', th);
      Object.entries(extra).forEach(([k, v]) => localStorage.setItem(k, v));
    }
  }, token, theme, extraStorage, noToken);
  // pages that immediately redirect themselves (auth guard) never reach network idle; that is expected, not a failure
  try { await page.goto(`http://localhost:${PORT}/${hash ? '#' + hash : ''}`, { waitUntil: noToken || /invalid|expired/.test(token || '') ? 'domcontentloaded' : 'networkidle0', timeout: 20000 }); } catch (e) { if (!/timeout|detached|Navigating frame/i.test(e.message)) throw e; }
  // a valid session must end up with the app shell rendered; wait for it explicitly (networkidle alone can fire early on a cold start)
  if (!noToken && !/invalid|expired/.test(token || '')) await page.waitForSelector('#main', { timeout: 15000 }).catch(() => {});
  const closer = { close: () => ctx.close().then(() => browser.disconnect()) };
  return { browser: closer, page, errors, requests, shot: (n, opts = {}) => page.screenshot({ path: path.join(SP, n + '.png'), fullPage: true, ...opts }) };
}
module.exports = { serve, open, SP, hits, VIEWPORTS, PORT };
