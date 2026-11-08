# Watch Later Tools

A Chrome extension (Manifest V3) that adds tools to YouTube's Watch Later and to playlists you own. It appears as a **Watch Later Tools** button in each playlist's header, right under YouTube's own buttons.

Tools so far:

- **Shuffle order:** permanently rearranges a playlist into a random order. The new order is stored on YouTube, so it shows on every device. This is not YouTube's own Shuffle button, which plays a playlist in random order once and leaves the playlist unchanged.
- **Backups:** the current order is saved before every change, and any saved order can be restored.
- **Row buttons:** purple buttons on every video of a playlist you can edit: **move to top** and **move to bottom**, stacked, and **remove**, each one click instead of going through YouTube's ⋮ menu. Moved videos jump to their new place on the page, with no reload. The remove button is also in the playlist panel beside a playing video, and a removal can be undone.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click **Load unpacked** and select this repository's root folder, the one containing `manifest.json`.
3. Reload any open YouTube tabs.

## Use it

1. Open a playlist you own. Watch Later is at `https://www.youtube.com/playlist?list=WL`.
2. Click the purple **Watch Later Tools** button with the puzzle-piece icon, under **Play all** in the playlist's header. The puzzle piece marks it as part of an extension. The panel that opens names the playlist and lists the tools.
3. In **Shuffle order**, click **Shuffle order...**, check the question, and confirm. A backup of the current order is saved first.
4. Watch the progress bar. **Stop** is safe at any point: every move leaves a complete playlist, just partly reordered.
5. When it says Done, click **Reload page** to see the new order.

To undo a shuffle, use the **Backups** list in the same panel. Each backup shows when it was saved and has its own **Restore** button, which asks before changing anything. The oldest backup, the order from before your first shuffle, is always kept.

If a shuffle is cut short, for example because the tab was closed, the button says **Last shuffle didn't finish** the next time you open that playlist.

### Moving and removing videos

Each video in a playlist you can edit gets purple buttons just left of YouTube's ⋮ menu, centered on it: **move to top** (arrow up to a line) above **move to bottom** (arrow down to a line), and **remove** (trash can) beside them.

- **Moving** takes one click and shows on the page right away: the row jumps to the top of the list, or to the end. If YouTube hasn't loaded the end of a long playlist yet, the row leaves the page, and the video appears at the bottom when you scroll there. There is no undo for moves.
- **Removing** turns the row into a **Removed** bar with **Undo**, which adds the video back under the video that is now above it. The bar takes up exactly the row's space, so removing several videos in a row never shifts the rest of the list. The bar stays until you leave the page. The header's video count updates when you reload.

The remove button is also in the playlist panel beside a video playing from the playlist, where, like YouTube's own ⋮, it appears when the pointer is over a row. The move buttons aren't there, because that panel is narrow. That panel can start partway through a long playlist, so if you undo a removal from the first row it shows, the video is added back without being moved, and the bar says so.

The buttons appear once the extension has read the first page of the playlist, which takes about a third of a second. They don't appear on playlists you can't edit, or when you're signed out.

The button lives in YouTube's header while you are on a playlist. If you browse elsewhere during a run, or YouTube's header can't be found, a floating button at the bottom right takes its place, so progress and **Stop** are always one click away.

## Safety

Losing a video is treated as unacceptable, and losing the order as something to avoid:

- **Shuffles and restores can't remove videos.** They only ever send "move this video after that one". A check runs right before every request and refuses anything else, so no bug or setting can make a shuffle or restore remove a video. Stopping, closing the tab, a crash or a network failure at any point leaves every video in the playlist.
- **The move buttons only move.** They go through the same move-only check as shuffles.
- **The Remove button removes exactly one video: the one you clicked.** The row only supplies its video's ID, from its own link. The playlist entry to remove comes from the extension's own read of the playlist, and a check refuses any request that names more than one entry. If a video is in a playlist twice, the button refuses rather than guess which copy you meant. Undo is sent only once, so a lost answer can't add the video twice.
- **Nothing changes without a backup.** The current order is saved and read back before the first move. If that fails, the shuffle doesn't start.
- **The original order is never rotated out.** When there are more backups than `backupsToKeep`, the middle ones go and the oldest stays.
- **One shuffle at a time, across all tabs.** While one YouTube tab is shuffling or restoring, or waiting for you to confirm, the others say **Busy in another tab** and can't start.
- **Interrupted runs are reported.** A run that started changing a playlist is recorded until it finishes, so a closed tab or crash shows up the next time the playlist is opened.
- **Leaving asks first.** Closing or navigating away while the playlist is being changed brings up the browser's "Leave site?" question. Before the first move, nothing has changed, so it doesn't ask.
- **Nothing hangs.** Requests give up after 30 seconds, and Stop takes effect immediately, even mid-request.
- **Extra clicks do nothing.** Repeated clicks on Shuffle, Confirm, Restore or Resume start or continue only one run.
- **Odd settings are corrected.** Values in `wls:config` are checked, and anything invalid falls back to its default.
- **The result is checked.** After moving, the playlist is read back and anything out of place is repaired once. A shuffle that went through cleanly reads back only the start of the playlist, as far as its first request reached, because a problem that hits every request, such as YouTube ignoring moves, shows there. A difference, a pause or a rejected batch means the whole playlist is checked. Restores always check the whole playlist, because there the exact order is the point, and so does the `ytAction` transport, which gets no answers to rely on.

## Testing changes

Run the automated tests:

```sh
node --test test/
```

`test/core.test.js` covers the pure logic. `test/flow.test.js` runs the real `innertube.js` and `main.js` against a simulated YouTube backend, covering retries, pause and resume, stop, verify and repair, restore, the panel's wiring, and the row buttons' requests and Undo. It also covers the safety cases: several tabs, closed tabs, requests that never answer, repeated clicks and bad settings. One randomized test throws failures at runs and checks that no video is ever lost; run `CHAOS_SEEDS=1000 node --test test/` for a longer search. `ui.js` and `rows.js` need a real page, so check them by hand: the button should appear under **Play all** in both the wide sidebar header and the narrow top header, and each video should have the stacked move buttons and a trash button just left of its ⋮ menu.

After changing anything that talks to YouTube, repeat these manual tests, signed in, on a throwaway playlist of about 10 videos before using Watch Later:

1. **Read.** In the DevTools console, run `await __wlTools.fetchPlaylist('PL...')` with the playlist's id. Expect one item per video, each with a `setVideoId`. If it throws "did not include the setVideoId", see [If reading fails](#if-reading-fails).
2. **Shuffle** from the panel. Reload and check the order changed and no videos are missing.
3. **Restore** the latest backup from the panel. Reload and check the original order is back.
4. **Stop midway.** Run `Object.assign(__wlTools.config, { batchSize: 1, delayMs: 1500 })` to slow it down, shuffle from the panel, then click **Stop**. Reload, check nothing is missing, and restore.
5. **Remove and Undo.** Click the trash button on the third video. Check the row turns into a **Removed** bar, then click **Undo** and reload: the video should be back in third place. Remove it again and reload: only that video should be gone.
6. **Move to top and bottom.** Click move to top on the fifth video: it should jump to the top. Click move to bottom on the sixth: it should leave the page. Reload: the fifth should be first and the sixth last. With `debug` on, a line saying YouTube refused a one-step move to the bottom means the slower fallback is in use.

## If something fails

### If reading fails

Open `https://www.youtube.com/playlist?list=WL`, run `copy(JSON.stringify(ytInitialData))` in the console, and paste the result into `fixtures/initial_data.json`. That one file shows where `setVideoId` is now. Spec section 4 lists the other useful captures. Git ignores `fixtures/` because captures contain your playlist. Never save cookie or `Authorization` values.

A playlist you don't own fails the same way, because YouTube leaves out the ids needed to move its videos. That is expected.

### If moves fail

- **HTTP 401 or 403:** compare your `Authorization` header with a real drag request, or switch to the fallback transport: run `localStorage.setItem('wls:config', '{"transport":"ytAction"}')` and reload.
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
| Panel: shuffle, restore, stop, themes, navigation | Confirmed in Chromium | Driven on a live youtube.com playlist page with the playlist requests answered by a mock, on 2026-11-07. |
| Moving rows on the page | Confirmed in Chromium | After a move, the row's element is moved within YouTube's list. YouTube then still loaded the rest of a 182-video playlist correctly, on 2026-11-07. |
| Move to bottom | **Not yet confirmed** | YouTube's web client has no request for it. The button first sends `ACTION_MOVE_VIDEO_BEFORE` with no successor named, which is how YouTube Music's client moves a video to the end. If YouTube refuses that, it reads the whole playlist and moves the video after the last one, and keeps doing that until the page reloads. Both paths pass in Chromium against a mock. |
| Remove and add actions | Confirmed in client code | `ACTION_REMOVE_VIDEO` with `setVideoId`, and `ACTION_ADD_VIDEO` with `addedVideoId`. An add's answer names the new entry in `playlistEditResults[].playlistEditVideoAddedResultData`. |
| Remove button and Undo | Confirmed in Chromium, **not yet signed in** | Driven on a live public playlist page and its watch page with the playlist requests answered by a mock, on 2026-11-07: placement and centering on the ⋮ in both window widths, the watch page panel (`ytd-playlist-panel-video-renderer`, shown on hover), one request per click, undo back to the same place, failure messages, dark theme. Signed out, YouTube draws playlist page rows as `yt-lockup-view-model`. Your own playlists may still use `ytd-playlist-video-renderer`, which is supported but has only been checked in code. |
| Batched moves | Confirmed by a signed-in test | Batches of 50 were applied in order on 2026-11-07, about 100 times faster than one move per request. YouTube's own client also sends its queued moves in one request. |

## Updating for YouTube changes

- Every undocumented name is in the frozen `INNERTUBE` block at the top of `src/core.js`. It lives there rather than in `innertube.js` because `core.js` loads first, needs the names itself, and must run under Node.
- If a response shape changes, adjust the parser in `src/core.js`, then add the new shape to `test/core.test.js`.
- Files in `fixtures/` are picked up by the tests automatically: `initial_data.json` and `browse_continuation.response.json`.
- The header button is placed after YouTube's visible action row, found by the selectors in the `YOUTUBE_DOM` block at the top of `src/ui.js`. If a redesign breaks them, the floating button appears instead after 3 seconds, so everything keeps working until the selector is updated.
- The Remove buttons find rows and YouTube's ⋮ menu with the selectors in the `YOUTUBE_ROWS` block at the top of `src/rows.js`, one entry per kind of row. Each button is lined up with the ⋮ by measuring both, so a layout change moves it along. If a redesign breaks the selectors, the buttons simply don't appear; nothing else is affected.
- Storage keys and the `wls:config` setting keep the extension's original `wls` prefix, so backups and settings saved before the rename to Watch Later Tools stay readable. Don't rename them without migrating.

## Configuration

Defaults are in `src/innertube.js`. To override them, store JSON in `localStorage` and reload:

```js
localStorage.setItem('wls:config', JSON.stringify({ debug: true }));
```

| Key | Default | Purpose |
| --- | --- | --- |
| `delayMs` | `0` | Pause between requests, in milliseconds |
| `batchSize` | `50` | Moves per request. If YouTube rejects a batch, the run halves the size and carries on. |
| `maxRetries` | `3` | Retries for network errors, 5xx and 429 before pausing |
| `requestTimeoutMs` | `30000` | How long to wait for YouTube before treating a request as a network error |
| `transport` | `'fetch'` | Set to `'ytAction'` to let YouTube's own app send moves if auth keeps failing |
| `authParts` | all three | Which `SAPISID*HASH` parts to send |
| `sendClientHeaders` | `false` | Send `X-YouTube-Client-Name` and `X-YouTube-Client-Version` |
| `backupsToKeep` | `3` | Backups kept in `localStorage` per playlist, at least 2. The oldest is always one of them. |
| `debug` | `false` | Log progress and timings to the console |

## Console API

Everything the panel does is also available as `__wlTools` on any youtube.com page. It was called `__wlShuffle` before the rename.

| Function | Purpose |
| --- | --- |
| `fetchPlaylist(playlistId = 'WL')` | Returns the full item list |
| `run({ playlistId = 'WL' } = {})` | Full shuffle: confirm, backup, move, verify |
| `restore({ playlistId = 'WL' } = {})` | Restores the latest saved backup |
| `restoreFromBackup(backupObject)` | Restores from a backup object, such as an older saved backup |
| `cancel()` | Stops the current run |
| `resume()` | Continues a paused run, or retries one that ended with items out of place |
| `config` | The effective config |

A run started from the console still opens the panel, and asks its question there.

## Good to know

- **Keep the tab open until a run finishes.** It can be in the background.
- **Hidden and unavailable videos are not moved.** YouTube's count includes deleted and private videos but doesn't list them, so the question before a shuffle says how many will stay where they are.
- **Console output is quiet by default.** Only real failures are logged, so Chrome's extension Errors page stays meaningful. Set `debug` to see progress, and how long reading, moving and checking each took.
- **Reading takes about a third of a second per 100 videos.** YouTube serves 100 videos per page, and each page's link comes from the page before, so pages are read one after another.
- **You can browse elsewhere on YouTube during a run.** The panel stays visible and keeps going.
- **Backups live only in this browser,** in youtube.com's `localStorage`. Clearing YouTube's site data deletes them.
- **Restore does not create a new backup,** so repeated restores keep returning to the same order. After two shuffles, the newest backup is the first shuffled order: restore an older one to get further back.
