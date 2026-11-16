# FinTrack frontend

A modular single-page app: **vanilla JavaScript (native ES modules) + locally built Tailwind CSS + Chart.js**.
There is no JavaScript bundler or framework; the browser loads each page's code on demand.

## Run it

```bash
# frontend setup (from the repository root)
cd frontend
npm install
npm run build
```

Start the backend in another terminal from the repository root:

```bash
cd backend && npm run dev
```

Serve the frontend from `frontend/` on the origin the backend allows (`CLIENT_URL`, default `http://localhost:5500`):

```bash
npx serve -l 5500          # or the VS Code "Live Server" extension on port 5500
```

Open `http://localhost:5500/` (redirects to the login page, or straight into the app when you are signed in).
It must be served over HTTP (not `file://`): ES modules and CORS both require it.
To point at another API without editing code, define `window.FINTRACK_CONFIG = { apiBaseUrl: '…' }` before `src/main.js` loads.

## Architecture

```
frontend/
├── index.html                    redirect: app if signed in, otherwise login
├── login.html                    sign in / create account (uses the shared auth service + design system)
├── fintrack_application.html     thin shell: CSS tokens, built local assets, <div id="app">, src/main.js
└── src/
    ├── main.js                   boot: theme → auth guard → shell → router; global last-resort error handlers
    ├── core/
    │   ├── config.js             API base URL, storage keys, category list (one place)
    │   ├── router.js, routes.js  hash router, lazy page loading, per-page lifecycle, 404, route-level error isolation
    │   ├── session.js            token + cached user; redirectToLogin() (once)
    │   ├── dom.js                html`` auto-escaping templates, delegated listeners, formatting, timezone-safe dates
    │   ├── events.js             tiny app event bus (data:changed, theme:changed, notifications:changed)
    │   ├── theme.js              light / dark / system, persisted, no flash
    │   ├── logger.js             logError(), friendlyMessage(), StaleError
    │   └── storage.js            localStorage that never throws
    ├── services/                 shared HTTP only
    │   ├── apiClient.js          base URL, auth header, timeout, de-duplicated GETs, 401 handling, friendly errors
    │   ├── authService.js, notificationService.js
    ├── components/               shared UI (used by every page; no feature imports another feature's UI)
    │   ├── ui.js                 button, input, select, textarea, date field, segmented, chips, badge, card, progress bar, stat card, page header
    │   ├── modal.js, confirmDialog.js, toast.js, skeleton.js, states.js (empty/error), pagination.js,
    │   │   searchBar.js, filterPanel.js, dropdown.js, widget.js (widget-level isolation), chartContainer.js (chart isolation + lifecycle)
    ├── layout/shell.js           sidebar, top bar, notifications, profile menu, theme toggle, mobile drawer
    ├── styles/                   tokens.css (design tokens) · base.css · components.css · layout.css · tailwind.css
    └── features/<feature>/       one folder per page: <name>Page.js, <name>Service.js, <name>.css (+ dialogs/modals where needed)
        dashboard · transactions · budgets · analytics · savings-goals · insights · health-score ·
        forecast · anomaly-detection · simulator · recurring · subscriptions · reports · notifications ·
        import-export (import page + export/backup page) · settings
```

### Routes (hash-based)

`#/dashboard  #/transactions  #/budgets  #/analytics  #/savings-goals  #/insights  #/forecast  #/health-score  #/anomaly-detection  #/simulator  #/recurring  #/subscriptions  #/reports  #/import  #/export  #/notifications  #/settings`
(anything else shows a 404 page). Hash routes work on any static host, survive a browser refresh and need no server rewrite rules.
Query parameters are supported, e.g. `#/transactions?search=rent`. Protected routes require a session; without one you are sent to `login.html`.

### A page module

```js
export default {
  styles: [new URL('./thing.css', import.meta.url).href],   // loaded lazily, once
  async mount(ctx) {
    // ctx.outlet, ctx.query, ctx.signal, ctx.onCleanup(fn), ctx.on(root, type, selector, fn),
    // ctx.alive(promise), ctx.refresh(), ctx.navigate(path)
  },
};
```
Add a page = write the module + add one line to `core/routes.js` (the sidebar is built from that list).
Everything a page registers through `ctx` (listeners, charts, timers) is cleaned up when the user leaves it.

### Error isolation (highest priority)

| Level | What happens when it fails |
|---|---|
| **Route** | The page's code can't be downloaded, or `mount` throws → an error state *inside the content area* with Retry + "Go to dashboard". Sidebar, top bar and navigation keep working. |
| **Widget** | `mountWidget()` gives each dashboard/page section its own skeleton → data → error + Retry. One failing request or render error never affects sibling widgets. |
| **Component** | `createChart()` catches Chart.js failures (library blocked, bad config): only that chart shows a message. |
| **API / network** | `apiClient` turns timeouts, offline, 4xx/5xx and 429 into friendly messages; HTTP 401 clears the session and redirects once. |
| **Global** | `window.onerror` / `unhandledrejection` → logged with full detail (`window.__fintrackErrors`) and a throttled friendly toast. Boot failure shows a minimal "could not start" screen. |

Errors are never swallowed silently: details go to the console, users see short, friendly text.

### Security notes
All dynamic text is escaped by the `html` template tag (user-supplied descriptions, notes, category names can't inject markup).
No secrets live in the frontend. The session token is the same JWT as before (`fintrack_token` in localStorage), so existing sessions survive the refactor.

## Design system

`src/styles/tokens.css` is the single source for colour, typography, radius, elevation, layout and motion tokens, in light and dark.
Brand palette: **#228B22** (primary / indicators / focus / charts), **#1E5631** (button fill and brand text: 8.6:1 contrast), **#2E8B57** (secondary accent),
**#4CAF50** (bright accent; dark-mode primary with dark text), **#A9DFBF** (tints; brand text in dark mode). Expenses use a red because green already means "good".
Contrast is verified in code for both themes (`m_quality` suite): all text pairs ≥ 4.5:1, focus ring ≥ 3:1.
Typography: Plus Jakarta Sans. Components are CSS classes (`.btn`, `.card`, `.badge`, `.input`, `.modal`, …) so they look identical everywhere; Tailwind is used only for layout utilities.

Accessibility: skip link, landmarks, one `<h1>` per page, labelled fields, visible `:focus-visible`, accessible modals (focus trap, Escape, focus return, `aria-modal`),
menus with arrow-key navigation, `aria-current` navigation, live regions for route changes/toasts, `prefers-reduced-motion` respected, sticky header never hides focused content.
Responsive at 1440 / 1280 / 768 / 390 px: collapsible sidebar (desktop, tooltips when collapsed) and off-canvas drawer (< 1024 px).

## Build
Run `npm run build` in `frontend/` after installing its dependencies and before serving/deploying; this generates the local Tailwind CSS and Chart.js assets in `dist/`.

## Downloads and uploads
`services/apiClient.js` has `download(path, query, { method, body })`: files are fetched **with the Bearer token** (a plain link cannot send it), turned into a Blob and saved through a temporary link. The server's suggested file name is read from `Content-Disposition` (exposed through CORS). Uploads are read in the browser (`FileReader`) and sent as JSON text; the client pre-checks type (`.csv` / `.json`) and size (1 MB / 5 MB) and the server enforces its own, stricter limits.

## Known limitations
- **No SMS.** E-mail copies of notifications exist but are off unless the server has SMTP configured (the Notifications page shows that state honestly). Only `.xlsx`/`.csv` can be imported (not legacy `.xls`).
- PDF reports embed Noto Sans + Noto Sans Bengali; characters in neither font (emoji, CJK) print as `?` in the PDF (CSV and screen keep the original text).
- Hash routes (`#/…`) rather than path routes (`/transactions`): chosen so refresh works on any static server. Path routes need a server rewrite rule.
- Settings is honest about what exists: the account is read-only (the API has no profile-update endpoint); only theme and sidebar preferences are editable.
- Dates are UTC days on the server; the browser uses local dates. Date pickers that must not be in the future/past use `todayEarliest()/todayLatest()` so people ahead of UTC (e.g. UTC+6) never hit a false "future date" error.

## Phase 18 - UI/UX audit, dark mode, responsiveness

The existing design system was **audited, not replaced**: `tests/e2e/uiAudit.js` runs inside every page (18 routes x light/dark x desktop/phone = 72 renders) and measures WCAG AA text contrast against the *real composited background*, controls without an accessible name, duplicate ids, heading structure, horizontal overflow, touch-target size on phones and light panels in dark mode. The audit found the baseline strong (no overflow, one `h1` per page, labelled controls) and these real issues, now fixed:
- secondary text (`--subtle`, used for "optional", timestamps) was 3.3-4.4:1 -> darker/lighter tokens, now >= 4.5:1 in both themes (`styles/tokens.css`);
- stand-alone links and range sliders were under 24 px tall on phones -> minimum target sizes (`styles/components.css`);
- native controls (range sliders, date pickers, scrollbars) were not themed in dark mode -> `color-scheme: light|dark` follows the theme (`styles/base.css`);
- phone dashboard stacked four full-width stat cards -> two compact columns; the AI example chips overflowed the screen -> wrapping chips.
Added: a dashboard "Needs your attention" strip (real unread budget/subscription/recurring/unusual-spending notifications, hidden when there are none).

**Dark mode** (already present, now covered by tests): light / dark / follow-the-OS; the choice is stored (`localStorage fintrack_theme`) and applied by an inline script in `<head>` before first paint (no flash, verified by a first-paint probe); the login page honours it; charts read their colours from the theme (`palette()`); dialogs, dropdowns, toasts, validation messages and tables are checked in dark. Switch with the half-moon button in the top bar. `prefers-reduced-motion` removes animations.

`node ui.test.js` (in `tests/e2e`) asserts all of the above on every page and also covers keyboard focus, the skip link, and the phone navigation drawer.

**What automated tests cannot prove - check on real devices before inviting users** (none of this was done on physical hardware):
1. iPhone Safari and an Android Chrome device: open every page in light and dark; rotate; pull to refresh; pinch zoom must stay enabled.
2. Touch: tap every button and link in the sidebar drawer, tables, filters, dialogs (the software keyboard must not hide the focused field or the submit button).
3. Date inputs and the file pickers (CSV/XLSX/JSON import, backup restore) use the OS pickers: verify they open and return files.
4. Charts: tooltips on touch, no clipped labels.
5. Screen reader pass (VoiceOver or TalkBack) on Dashboard, Transactions and the AI Assistant.
