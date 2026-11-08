# Watch Later Shuffle: Chrome Extension Spec

This document is an implementation spec for a coding agent. Read all of it before writing code. Sections marked **VERIFY** describe undocumented YouTube internals that are believed correct but must be checked against real captured requests (section 4).

## 1. Goal

A Chrome extension (Manifest V3) that **permanently shuffles the stored order** of the signed-in user's YouTube Watch Later playlist. This is not shuffle-play: after it runs, the playlist itself is in a new random order on YouTube's side, so it shows that order on every device.

### In scope (v1)

- Shuffle Watch Later (`WL`).
- Back up the original order before every shuffle, and restore from that backup.
- A small floating UI on the Watch Later page with progress and cancel.
- A console API so the core flow can be tested on a throwaway playlist before touching Watch Later.

### Out of scope (v1)

- Other sort modes (by date, duration, etc.).
- A UI for playlists other than Watch Later. Keep `playlistId` a parameter everywhere so this is easy later, and so testing on a throwaway playlist works.
- Popup page, options page, background service worker, any server, any analytics.
- Firefox.

## 2. Background: why this needs internal APIs

The official YouTube Data API stopped exposing Watch Later around 2016, so scripts that shuffle playlists through the official API do not work for it. The extension instead calls the same internal "InnerTube" endpoints that youtube.com itself calls when you drag a video to a new position in a playlist.

Consequences:

- Field names, request shapes, and response shapes are undocumented and can change without notice.
- All such names must live in one constants block so they are easy to fix.
- Response parsing must be shape-tolerant (section 5.4).

## 3. Architecture

- **One content script bundle running in the page's MAIN world** on `https://www.youtube.com/*`.
  - MAIN world is required to read `window.ytcfg` (client context, session info) and to make same-origin requests exactly like the page does.
  - MAIN-world scripts **cannot use any `chrome.*` APIs**. Do not use them. Use `localStorage` and file downloads instead.
- **Match all of `youtube.com`**, not just `/playlist`. YouTube is a single-page app: content scripts are injected only on full page loads, so if the user lands on the homepage and clicks into Watch Later, a script scoped to `/playlist*` never runs. The script decides at runtime whether to show its UI.
- **No `permissions` key** in the manifest. Host access comes only from the content script `matches`. This keeps the Chrome Web Store review simple later.
- **No build step, no dependencies.** Plain JavaScript (not TypeScript).

### File layout

```
watch-later-shuffle/
  manifest.json
  src/
    core.js        pure logic: shuffle, move planning, response parsing (no DOM, no fetch)
    innertube.js   ytcfg access, auth header, fetch wrappers for browse and edit_playlist
    ui.js          floating button and progress panel (Shadow DOM, no innerHTML)
    main.js        wiring: navigation detection, run, cancel, restore, console API
  test/
    core.test.js   node:test unit tests for core.js
  fixtures/        captured responses from section 4 (optional, redacted)
  README.md
```

Content scripts are not ES modules, so there are no `import` statements. Each file is an IIFE that attaches to one namespace object, `globalThis.__wlShuffle`. The manifest lists the files in dependency order. `core.js` must also be loadable in Node for tests: at the bottom, export via `module.exports` when `module` is defined, otherwise attach to the namespace.

```js
(function (root) {
  const api = { shuffle, applyMove, planMoves, toAction, parsePlaylistPage };
  // ...function definitions...
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.__wlShuffle = root.__wlShuffle || {};
    root.__wlShuffle.core = api;
  }
})(globalThis);
```

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "Watch Later Shuffle",
  "version": "0.1.0",
  "description": "Permanently shuffle the order of your YouTube Watch Later playlist.",
  "content_scripts": [{
    "matches": ["https://www.youtube.com/*"],
    "js": ["src/core.js", "src/innertube.js", "src/ui.js", "src/main.js"],
    "world": "MAIN",
    "run_at": "document_idle"
  }]
}
```

Icons are not needed for local development. Add 16/48/128 px icons only when publishing.

## 4. Step 0: capture real requests (the developer does this)

Before or alongside implementation, the developer should capture real traffic so field names can be confirmed:

1. Sign in, open `https://www.youtube.com/playlist?list=WL`, open DevTools > Network, filter by `youtubei`.
2. Drag one video to a new position. Find the POST to `/youtubei/v1/browse/edit_playlist`.
   - Save the request body to `fixtures/edit_playlist.request.json`.
   - Save the response body to `fixtures/edit_playlist.response.json`.
   - Note the request **header names** and the **format** of the `Authorization` header (for example, whether it contains only a `SAPISIDHASH ...` part or also `SAPISID1PHASH ...` and `SAPISID3PHASH ...` parts). Write these notes to `fixtures/NOTES.md`.
3. Scroll to the bottom of the playlist so more videos load. Find the POST to `/youtubei/v1/browse` whose body contains `continuation`. Save its response to `fixtures/browse_continuation.response.json`.
4. In the console on the same page, run `copy(JSON.stringify(ytInitialData))` and paste into `fixtures/initial_data.json`. This is the first page of the playlist.
5. **Redact before saving:** never store cookie values or `Authorization` values in the repo. Header names and the shape of the auth header are enough.

**Instruction to the coding agent:** if `fixtures/` exists, read it first and reconcile every VERIFY item below with it. If it does not exist, implement per this spec, keep all InnerTube names in one constants block, and add a README note listing what to verify.

## 5. InnerTube details

### 5.1 Page config (VERIFY)

Read values with `ytcfg.get(key)`, falling back to `ytcfg.data_[key]`:

| Key | Used for |
| --- | --- |
| `INNERTUBE_CONTEXT` | `context` field in every request body |
| `SESSION_INDEX` | `X-Goog-AuthUser` header (default `'0'`) |
| `DELEGATED_SESSION_ID` | `X-Goog-PageId` header, only if present (brand accounts) |
| `INNERTUBE_CONTEXT_CLIENT_NAME`, `INNERTUBE_CLIENT_VERSION` | `X-YouTube-Client-Name` / `X-YouTube-Client-Version` headers, only if the captured request sends them |

Read `ytcfg` fresh at the start of each run, never at script load (it can change across SPA navigations and account switches). Abort a run if `SESSION_INDEX` or `DELEGATED_SESSION_ID` changes mid-run.

### 5.2 Auth header (VERIFY format)

Logged-in InnerTube requests need an `Authorization` header built from cookies:

```
SAPISIDHASH <ts>_<sha1hex("<ts> <SAPISID> https://www.youtube.com")>
```

- `ts` is Unix time in **seconds**.
- Recompute for every request (it is cheap). Do not cache.
- Read `SAPISID` from `document.cookie`; if absent, fall back to `__Secure-3PAPISID`.
- Some current clients append `SAPISID1PHASH` and `SAPISID3PHASH` parts (same formula using `__Secure-1PAPISID` and `__Secure-3PAPISID`), space-separated in the same header. Mirror whatever the captured request does. If a cookie is not readable from JS, skip that part.

```js
function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildAuthHeader() {
  const origin = 'https://www.youtube.com';
  const ts = Math.floor(Date.now() / 1000);
  const sources = [
    ['SAPISIDHASH', readCookie('SAPISID') ?? readCookie('__Secure-3PAPISID')],
    ['SAPISID1PHASH', readCookie('__Secure-1PAPISID')],
    ['SAPISID3PHASH', readCookie('__Secure-3PAPISID')]
  ];
  const parts = [];
  for (const [label, value] of sources) {
    if (!value) continue;
    if (!CONFIG.authParts.includes(label)) continue;
    parts.push(`${label} ${ts}_${await sha1Hex(`${ts} ${value} ${origin}`)}`);
  }
  if (parts.length === 0) throw new Error('No SAPISID cookie found. Are you signed in?');
  return parts.join(' ');
}
```

Requests are same-origin `fetch` calls, so cookies attach automatically:

```js
async function innertubePost(path, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': await buildAuthHeader(),
    'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? '0'),
    'X-Origin': 'https://www.youtube.com'
  };
  const pageId = cfg('DELEGATED_SESSION_ID');
  if (pageId) headers['X-Goog-PageId'] = pageId;
  const res = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ context: cfg('INNERTUBE_CONTEXT'), ...body })
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json();
}
```

### 5.3 Fallback transport: let YouTube send the request

If manual auth keeps failing (401/403 that a fresh header does not fix), YouTube's own app can send the request for us. Dispatch a `yt-action` event on the `ytd-app` element:

```js
function sendViaYtAction(playlistId, actions) {
  const app = document.querySelector('ytd-app');
  if (!app) throw new Error('ytd-app not found');
  const command = {
    commandMetadata: {
      webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' }
    },
    playlistEditEndpoint: { playlistId, actions }
  };
  app.dispatchEvent(new CustomEvent('yt-action', {
    detail: {
      actionName: 'yt-service-request',
      returnValue: [],
      args: [{ data: {} }, command],
      optionalAction: false
    }
  }));
}
```

This is fire-and-forget (no response to inspect), so when this transport is used the verification pass (section 6.4) is what confirms success. Implement it behind `CONFIG.transport`: `'fetch'` (default) or `'ytAction'`. Reading the playlist always uses `fetch`.

### 5.4 Reading the playlist (VERIFY shapes)

- First page: `innertubePost('browse', { browseId: 'VL' + playlistId })`. For Watch Later that is `'VLWL'`.
- Next pages: `innertubePost('browse', { continuation: token })`.
- Roughly 100 items per page. Watch Later has historically been capped at 5,000 videos.

Parsing must tolerate layout changes:

1. **Primary:** walk the JSON and collect every object found under a `playlistVideoRenderer` key. Each has `videoId`, `setVideoId`, a title (`title.runs[0].text` or `title.simpleText`), and usually `lengthSeconds`.
2. **Fallback:** if step 1 finds nothing, collect every object that has both a string `videoId` and a string `setVideoId`.
3. Dedupe by `setVideoId`, keeping first-seen order.
4. **Continuation token:** search recursively for `continuationItemRenderer.continuationEndpoint.continuationCommand.token` (current shape), falling back to `nextContinuationData.continuation` (older shape). No token means this was the last page.

`parsePlaylistPage(json)` returns `{ items: [{ setVideoId, videoId, title }], continuation: string | null }` and lives in `core.js` so it can be tested against fixtures.

Keep fetching until there is no continuation. Add `CONFIG.delayMs` between page requests too.

**Sanity check:** try to read the playlist's displayed video count from the first page's header (shape-tolerant; give up quietly if not found). If the fetched count differs, show a warning but do not block: YouTube hides unavailable videos, so a mismatch is normal.

**Always fetch fresh** immediately before planning moves. Never reuse a list from an earlier run or from `ytInitialData` for planning: a stale list is a known cause of HTTP 400 errors in similar tools.

### 5.5 Moving a video (VERIFY)

`POST /youtubei/v1/browse/edit_playlist`:

```json
{
  "context": "<INNERTUBE_CONTEXT>",
  "playlistId": "WL",
  "actions": [{
    "action": "ACTION_MOVE_VIDEO_AFTER",
    "setVideoId": "<setVideoId of the item being moved>",
    "movedSetVideoIdPredecessor": "<setVideoId it should end up right after>"
  }]
}
```

- **Move to top:** `ACTION_MOVE_VIDEO_AFTER` with `setVideoId` and **no** `movedSetVideoIdPredecessor`.
- An equivalent form exists: `ACTION_MOVE_VIDEO_BEFORE` with `movedSetVideoIdSuccessor`. Use whichever form the captured drag request uses if `ACTION_MOVE_VIDEO_AFTER` misbehaves.
- **Success check:** the response is expected to contain `"status": "STATUS_SUCCEEDED"`. Confirm against `fixtures/edit_playlist.response.json`. Treat a 200 without the success marker as a failure unless the fixture shows otherwise.

`setVideoId` identifies a slot in the playlist and is different from `videoId`. Always use `setVideoId` for moves.

## 6. Algorithm

### 6.1 Shuffle (core.js)

Fisher-Yates with an unbiased random integer from `crypto.getRandomValues`. The random function is injectable for tests.

```js
function randomInt(maxExclusive) {
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % maxExclusive;
  }
}

function shuffle(items, rand = randomInt) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
```

### 6.2 Move planning (core.js)

A move is `{ setVideoId, after }` where `after` is a `setVideoId` or `null` (null means move to top).

```js
function applyMove(order, move) {
  const next = order.filter((id) => id !== move.setVideoId);
  const index = move.after === null ? 0 : next.indexOf(move.after) + 1;
  next.splice(index, 0, move.setVideoId);
  return next;
}

function planMoves(current, target) {
  // Precondition: current and target contain exactly the same ids.
  let model = current.slice();
  const moves = [];
  for (let i = 0; i < target.length; i++) {
    if (model[i] === target[i]) continue;
    const move = { setVideoId: target[i], after: i === 0 ? null : target[i - 1] };
    moves.push(move);
    model = applyMove(model, move);
  }
  return moves;
}

function toAction(move) {
  const action = { action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId: move.setVideoId };
  if (move.after !== null) action.movedSetVideoIdPredecessor = move.after;
  return action;
}
```

Invariant: after processing index `i`, `model[0..i]` equals `target[0..i]`. A random shuffle needs close to `n` moves. Skipping already-placed items makes restore and repair passes cheap. `planMoves` is O(n²) in the worst case, which is fine for n ≤ 5,000.

`planMoves` must throw if the precondition is violated (different lengths or different id sets).

### 6.3 Execution (main.js)

- **Sequential**, one request at a time. Never parallelize.
- `CONFIG.delayMs` (default 150) between requests. 1,000 videos takes a few minutes; that is acceptable.
- `CONFIG.batchSize` (default 1) actions per request. Batching is experimental: only raise it after testing on a throwaway playlist that multiple actions in one request are applied in order (verify with a refetch).
- **Retries:** on network error, 5xx, or 429, retry with exponential backoff (1 s, 2 s, 4 s) up to `CONFIG.maxRetries`. After that, pause and show "Paused at i / n" with Resume and Cancel. Resume re-fetches the list and re-plans (cheap because placed items are skipped).
- **401/403:** rebuild the auth header and retry once. If it still fails, stop with a clear message suggesting the `ytAction` transport.
- **400:** do not blindly retry. Re-fetch the list, re-plan, continue. If a 400 repeats on the same move, stop and report it.
- **Cancel:** checked between requests. Every single move leaves the playlist in a valid order with no videos lost, so cancelling is always safe.
- **One run at a time:** a module-level `running` flag. While running, register a `beforeunload` handler that warns before closing the tab. If the user navigates elsewhere inside YouTube during a run, keep running and keep the panel visible.

### 6.4 Run flow

1. Fetch the full list fresh (5.4). If it has fewer than 2 items, show "Nothing to shuffle" and stop.
2. Confirm with the user: "Shuffle N videos? This changes the order on YouTube on all devices. A backup will be saved first."
3. **Backup**, before any move:
   - Save `{ version: 1, createdAt, playlistId, items: [{ setVideoId, videoId, title }] }` to `localStorage` under `wls:backup:<playlistId>`, keeping the last `CONFIG.backupsToKeep` (default 3) as an array. Wrap in try/catch; if storage fails (quota), continue with the download only.
   - Also download it as `watch-later-backup-YYYYMMDD-HHMMSS.json` (Blob plus a temporary anchor with `download`).
4. `target = shuffle(ids)`, `moves = planMoves(ids, target)`, execute with progress.
5. **Verify:** re-fetch the list. If the order differs from `target`, run one repair pass (`planMoves(fresh, target)` and execute). Re-fetch once more and report: "Shuffled N videos" or "Shuffled with K items out of place" (with the option to retry).
6. Done state: "Done. Reload to see the new order." with a Reload button. The page's rendered list does not update itself.

### 6.5 Restore flow

1. Load the most recent backup for the playlist from `localStorage`. Also support `__wlShuffle.restoreFromBackup(obj)` from the console for a downloaded JSON file.
2. Fetch the current list fresh.
3. Build `target`: items not in the backup first (they were added after the backup, keep their current relative order), followed by backup items still present, in backup order. Items in the backup but no longer in the playlist are ignored.
4. Plan, execute, verify exactly as in 6.4.

## 7. UI (ui.js)

- Show the UI only when `location.pathname === '/playlist'` and the `list` query param is `WL`, or while a run is in progress.
- **Navigation detection:** listen for the `yt-navigate-finish` event on `document`, plus `popstate`, plus a cheap 1 s poll comparing `location.href` as a fallback.
- **Floating button** fixed at the bottom-right, labeled "Shuffle". Clicking it opens a small panel with:
  - "Shuffle" and "Restore last backup" buttons (restore disabled if there is no backup).
  - Progress text ("Moving 123 / 847") and a progress bar.
  - "Cancel" while running; "Resume" when paused; "Reload" when done.
  - A status/error line.
- Render inside a **Shadow DOM** host so YouTube's CSS does not leak in or out.
- **Trusted Types:** YouTube enforces Trusted Types, so assigning a string to `innerHTML` throws in the MAIN world. Build all DOM with `document.createElement`, `textContent`, and `append`. No `innerHTML`, `outerHTML`, or `insertAdjacentHTML` anywhere, including inside the shadow root. Styles go in a `<style>` element via `textContent`, or via `CSSStyleSheet.replaceSync` plus `adoptedStyleSheets`.
- Do not depend on YouTube's DOM class names for placement.
- Match YouTube's theme: dark styles when `document.documentElement.hasAttribute('dark')`, light otherwise.

## 8. Configuration

One constants block in `innertube.js`, overridable for experiments via a JSON object in `localStorage` under `wls:config`:

```js
const DEFAULT_CONFIG = {
  delayMs: 150,
  batchSize: 1,
  maxRetries: 3,
  transport: 'fetch',
  authParts: ['SAPISIDHASH', 'SAPISID1PHASH', 'SAPISID3PHASH'],
  backupsToKeep: 3,
  debug: false
};
```

All InnerTube string constants (endpoint paths, action names, field names, renderer keys) go in a second frozen object next to it, so a YouTube change is a one-place fix.

## 9. Console API

Exposed on `globalThis.__wlShuffle` (reachable from the DevTools console because the script runs in the page's world):

| Function | Purpose |
| --- | --- |
| `fetchPlaylist(playlistId = 'WL')` | Returns the full item list |
| `run({ playlistId = 'WL' } = {})` | Full shuffle flow, including confirm, backup, verify |
| `restore({ playlistId = 'WL' } = {})` | Restore the latest saved backup |
| `restoreFromBackup(backupObject)` | Restore from a downloaded JSON backup |
| `cancel()` | Cancel the current run |
| `config` | The effective config |

Log progress to the console when `config.debug` is true.

## 10. Testing

### Unit tests (Node, no dependencies): `node --test test/`

- `shuffle`: returns a permutation of the input; does not mutate input; deterministic with a seeded `rand`; handles 0 and 1 items.
- `applyMove`: move to top; move after a predecessor; moving an item after its current predecessor is a no-op.
- `planMoves`: for sizes 0, 1, 2, 10, 1000 with random `current` and `target`, applying the plan to `current` yields exactly `target`; identical arrays give zero moves; mismatched id sets throw.
- `toAction`: emits `movedSetVideoIdPredecessor` only when `after` is not null.
- `parsePlaylistPage`: run against `fixtures/*.json` when present (items are non-empty, `setVideoId`s unique, continuation found on non-final pages). Also include a small hand-written fixture covering both the primary and fallback shapes so tests pass without real captures.

### Manual tests (the developer, in Chrome)

1. `chrome://extensions` > Developer mode > Load unpacked > select the folder.
2. Create a throwaway playlist with about 10 videos. On any youtube.com page, in the console: `await __wlShuffle.fetchPlaylist('PL...')` and check the items.
3. `await __wlShuffle.run({ playlistId: 'PL...' })`. Reload and confirm the new order matches the logged target.
4. `await __wlShuffle.restore({ playlistId: 'PL...' })` and confirm the original order is back.
5. Start a run on the throwaway playlist and cancel midway. Confirm no videos are missing, then restore.
6. Only then use the floating button on Watch Later. Check the order in the YouTube mobile app afterwards to confirm it changed server-side.

## 11. Known risks

- **Undocumented API:** will break when YouTube changes internals. Mitigated by the constants block, shape-tolerant parsing, and the verify pass.
- **Rate limiting / abuse detection:** keep the delay, never parallelize, keep batching off unless verified.
- **Hidden or unavailable videos** may not appear in the fetched list. They stay wherever they end up; this is acceptable.
- **Account switching mid-run:** detected via `ytcfg` session values; the run aborts.

## 12. Implementation order

1. `core.js` and `test/core.test.js`. All tests passing.
2. `innertube.js`: config, auth header, `fetchPlaylist`, single move, ytAction fallback.
3. `main.js`: run, verify, restore, cancel, console API. **Then stop and write the manual test steps (section 10, steps 1 to 5) into README.md** so the developer can validate against the live site before UI work.
4. `ui.js`: floating button and panel.
5. Finish `README.md`: what it does, how to load unpacked, manual test steps, the list of VERIFY items and how to update constants if YouTube changes.

## 13. Coding conventions

- 2-space indentation everywhere (JS, JSON, Markdown code blocks). Never tabs or 4 spaces.
- Single quotes in JavaScript unless the string contains a single quote.
- Prefer `const` over `let`.
- No trailing whitespace; newline at end of every file.
- Plain JavaScript, no dependencies, no build step.

## 14. Later: publishing to the Chrome Web Store

Not part of v1, but keep these true so publishing is easy:

- No `permissions` entry; host access only via content script `matches`.
- Single purpose statement: "Shuffles the order of the user's YouTube Watch Later playlist."
- Data disclosure: reads YouTube session cookies locally only to sign requests to youtube.com; no data is collected or sent anywhere else. Link a short privacy policy page.
- Add icons (16, 48, 128 px) and at least one 1280x800 screenshot.
- Consider publishing as Unlisted.
