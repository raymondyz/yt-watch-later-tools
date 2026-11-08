# Watch Later Shuffle

A Chrome extension (Manifest V3) that permanently shuffles the stored order of your YouTube Watch Later playlist, so the new order shows on every device. It backs up the original order before each shuffle and can restore it.

**Status:** the core flow is finished and passed the manual tests below on a signed-in account on 2026-11-07. For now it runs from the DevTools console. The floating UI (`src/ui.js`) is not built yet, and stays out of `manifest.json` until it exists, because Chrome refuses to load an extension when a listed file is missing.

## Load the extension

1. Open `chrome://extensions` and turn on Developer mode.
2. Click **Load unpacked** and select this repository's root folder, the one containing `manifest.json`.
3. Reload any open YouTube tabs.

## Manual tests

Run these in order, signed in, in the DevTools console of any youtube.com tab. Use a throwaway playlist: do not touch Watch Later until all of them pass. Replace `PL...` with the throwaway playlist's id.

**1. Check that the extension is loaded.**

```js
__wlShuffle.config
```

**2. Read the throwaway playlist.** Create a playlist with about 10 videos, then:

```js
await __wlShuffle.fetchPlaylist('PL...')
```

Expect one item per video, each with `setVideoId`, `videoId` and `title`. If this throws "did not include the setVideoId", see [If reading fails](#if-reading-fails).

**3. Read Watch Later.** This only reads, so it is safe, and it answers the biggest open question below.

```js
(await __wlShuffle.fetchPlaylist()).length
```

**4. Shuffle.** Accept the dialog. A backup is saved before the first move.

```js
const result = await __wlShuffle.run({ playlistId: 'PL...' });
console.table(result.target.map((video) => video.title));
```

Expect `result.status` to be `'done'`. Reload the playlist page and confirm its order matches the table.

**5. Restore.**

```js
await __wlShuffle.restore({ playlistId: 'PL...' })
```

Reload and confirm the original order is back.

**6. Cancel midway.** The longer delay gives you time to cancel. Accept the dialog, then run the second part.

```js
__wlShuffle.config.delayMs = 1500;
const pending = __wlShuffle.run({ playlistId: 'PL...' });
```

```js
__wlShuffle.cancel();
await pending;
```

Reload and confirm no videos are missing, then restore as in step 5.

## If a test fails

### If reading fails

Open `https://www.youtube.com/playlist?list=WL`, run `copy(JSON.stringify(ytInitialData))` in the console, and paste the result into `fixtures/initial_data.json`. That one file shows where `setVideoId` is now. Spec section 4 lists the other useful captures. Git ignores `fixtures/` because captures contain your playlist. Never save cookie or `Authorization` values.

### If moves fail

- **HTTP 401 or 403:** compare your `Authorization` header with a real drag request, or try the fallback transport below.
- **HTTP 400 or "did not confirm the move":** drag one video by hand, then compare the `browse/edit_playlist` request and response with spec section 5.5. YouTube may need an extra field in the body, or may report success differently.

## What has been verified

Checked on 2026-11-06 against client version `2.20261030.02.00`, without signing in. The signed-in manual tests passed on 2026-11-07 with the default `fetch` transport, which confirmed the rows marked "manual tests".

| Item | Status | Evidence |
| --- | --- | --- |
| `setVideoId` present in Watch Later responses | Confirmed by the manual tests | Public pages use `lockupViewModel` with no `setVideoId`, but your own playlists still include it. |
| Edit request body | Confirmed by the manual tests | `playlistId` plus `actions`, as in spec section 5.5, is accepted. |
| Success marker on `edit_playlist` | Confirmed by the manual tests | A missing `STATUS_SUCCEEDED` would have stopped the run. |
| `X-YouTube-Client-*` headers | Not needed | The manual tests passed without them. `sendClientHeaders` stays available. |
| Shorts in Watch Later | **Open** | Shorts may use a different shape. If they are skipped, they stay in place and the count warning appears. |
| Move action and field names | Confirmed in client code | `ACTION_MOVE_VIDEO_AFTER`, `setVideoId`, `movedSetVideoIdPredecessor` |
| Move to top omits the predecessor | Confirmed in client code | The predecessor is undefined when dropping at index 0. |
| `ACTION_MOVE_VIDEO_BEFORE` alternative | Not in this client | Neither it nor `movedSetVideoIdSuccessor` appears. Do not rely on it. |
| Auth header names and parts | Confirmed in client code | `Authorization`, `X-Goog-AuthUser`, `X-Origin`, `X-Goog-PageId`, and the three `SAPISID*HASH` parts |
| Hash format | Corrected from the spec | With `USER_SESSION_ID` in `ytcfg`, the client signs `<USER_SESSION_ID> <ts> <SAPISID> <origin>` and appends `_u`. This code does the same. |
| Continuation tokens | Confirmed on live pages | `continuationItemViewModel` is now in use and is supported alongside the older shapes. A 182-video playlist read as 100 + 82 with the correct token. |
| Section-level continuation tokens | Confirmed on live pages | Pages also carry a token that does not belong to the playlist. The parser prefers the token next to the videos, and reading stops if a page adds nothing new. |
| Displayed video count | Confirmed on live pages | Read from `playlistSidebarPrimaryInfoRenderer.stats`. |
| `yt-action` fallback transport | Partly confirmed | `yt-service-request` is in the client, but the fallback has not been run. |
| MAIN world injection, `ytcfg`, Trusted Types | Confirmed in Chromium | Loaded on live youtube.com, signed out. |

## Updating for YouTube changes

- Every undocumented name is in the frozen `INNERTUBE` block at the top of `src/core.js`. It lives there rather than in `innertube.js` because `core.js` loads first, needs the names itself, and must run under Node.
- If a response shape changes, adjust the parser in `src/core.js`, then add the new shape to `test/core.test.js`.
- Files in `fixtures/` are picked up by the tests automatically: `initial_data.json` and `browse_continuation.response.json`.

## Configuration

Defaults are in `src/innertube.js`. To override them, store JSON in `localStorage` and reload:

```js
localStorage.setItem('wls:config', JSON.stringify({ debug: true }));
```

| Key | Default | Purpose |
| --- | --- | --- |
| `delayMs` | `150` | Delay between requests |
| `batchSize` | `1` | Actions per request. Experimental: raise it only after testing on a throwaway playlist. |
| `maxRetries` | `3` | Retries for network errors, 5xx and 429 before pausing |
| `transport` | `'fetch'` | Set to `'ytAction'` to let YouTube's own app send moves if auth keeps failing |
| `authParts` | all three | Which `SAPISID*HASH` parts to send |
| `sendClientHeaders` | `false` | Send `X-YouTube-Client-Name` and `X-YouTube-Client-Version` |
| `backupsToKeep` | `3` | Backups kept in `localStorage` per playlist |
| `debug` | `false` | Log progress to the console |

## Console API

Available as `__wlShuffle` on any youtube.com page.

| Function | Purpose |
| --- | --- |
| `fetchPlaylist(playlistId = 'WL')` | Returns the full item list |
| `run({ playlistId = 'WL' } = {})` | Full shuffle: confirm, backup, move, verify |
| `restore({ playlistId = 'WL' } = {})` | Restores the latest saved backup |
| `restoreFromBackup(backupObject)` | Restores from a backup object, such as an older saved backup |
| `cancel()` | Cancels the current run |
| `resume()` | Continues a paused run, or retries one that ended with items out of place |
| `config` | The effective config |

## Good to know

- **Keep the tab in the foreground during long runs.** Chrome throttles timers in background tabs, so a run slows down sharply there. It stays safe, just slow.
- **A paused run keeps its `run()` promise pending** until you call `resume()` or `cancel()`.
- **Backups live only in this browser,** in youtube.com's `localStorage`, newest first. Clearing YouTube's site data deletes them, and only the last `backupsToKeep` are kept per playlist.
- **A shuffle never runs without a backup.** If the backup can't be saved, for example because storage is full, the run stops before changing anything.
- **Restore does not create a new backup,** so repeated restores keep returning to the same order. After two shuffles, the newest backup is the first shuffled order. To get further back, restore an older backup:

  ```js
  const backups = JSON.parse(localStorage.getItem('wls:backup:WL'));
  await __wlShuffle.restoreFromBackup(backups[1]); // [0] is the newest
  ```
- **Cancelling never loses videos.** Each move leaves a valid playlist, only partly reordered.

## Tests

```sh
node --test test/
```

`test/core.test.js` covers the pure logic. `test/flow.test.js` runs the real `innertube.js` and `main.js` against a simulated YouTube backend, covering retries, pause and resume, cancel, verify and repair, and restore. Neither proves the live InnerTube contract: the manual tests above do that.
