// Which videos are in your Watch later, so their thumbnails can be marked
// anywhere on YouTube. It reads Watch later in full in the background now and
// then, and keeps in step with every Watch later edit made in this tab, by
// YouTube's own buttons or by this extension. The list is cached in
// youtube.com's storage, shared by every tab, and kept per signed-in account.
(function (root) {
  const ns = root.__wlTools;
  const { core, innertube: it } = ns;
  const IT = core.INNERTUBE;

  const WATCH_LATER = 'WL';
  // Keeps the extension's original "wls" prefix, like its other keys.
  const CACHE_KEY = 'wls:saved';
  // Watch later can change from other devices, so it is read again after this.
  const REFRESH_MS = 15 * 60 * 1000;
  const CHECK_EVERY_MS = 60 * 1000;
  // Only one tab reads at a time; the others pick up its result.
  const REFRESH_LOCK = 'wls:saved';

  // setVideoId -> videoId, in Watch later's order. Removals name the
  // setVideoId, so both are kept, and the order says where a video was.
  let entries = new Map();
  let videoIds = new Set();
  let savedAt = 0;
  let refreshing = null;
  let started = false;
  const listeners = new Set();

  function log(...args) {
    if (it.CONFIG.debug) console.log('[wlt]', ...args);
  }

  function account() {
    const { index, pageId } = it.readSession();
    return `${index}/${pageId ?? ''}`;
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[wlt]', err);
      }
    }
  }

  // Replaces the list and tells listeners, but only if anything changed.
  function setEntries(next) {
    const nextIds = new Set(next.values());
    const changed = nextIds.size !== videoIds.size || [...nextIds].some((id) => !videoIds.has(id));
    entries = next;
    videoIds = nextIds;
    if (changed) notify();
  }

  function save() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        version: 1,
        account: account(),
        savedAt,
        entries: [...entries]
      }));
    } catch (err) {
      log('Could not cache the Watch later list.', err);
    }
  }

  // Takes the cached list when it belongs to the signed-in account.
  function load() {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    } catch (err) {
      cached = null;
    }
    const usable = cached?.version === 1 && cached.account === account()
      && Array.isArray(cached.entries) && typeof cached.savedAt === 'number';
    if (!usable) return false;
    savedAt = cached.savedAt;
    setEntries(new Map(cached.entries.filter((pair) => Array.isArray(pair) && pair.length === 2)));
    return true;
  }

  function forget() {
    savedAt = 0;
    setEntries(new Map());
  }

  async function readAll() {
    const since = Date.now();
    const { items } = await it.readPlaylist(WATCH_LATER);
    savedAt = Date.now();
    setEntries(new Map(items.map((item) => [item.setVideoId, item.videoId])));
    save();
    log(`Read ${items.length} Watch later videos for the thumbnail marks in ${((savedAt - since) / 1000).toFixed(1)} s.`);
  }

  // Reads Watch later again. Another tab already doing so is enough.
  function refresh() {
    if (!it.isSignedIn()) {
      forget();
      return Promise.resolve();
    }
    refreshing ??= (async () => {
      try {
        const locks = root.navigator?.locks;
        if (!locks) await readAll();
        else await locks.request(REFRESH_LOCK, { ifAvailable: true }, (lock) => (lock ? readAll() : null));
      } catch (err) {
        log('Could not read Watch later for the thumbnail marks.', err);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function isStale() {
    return Date.now() - savedAt >= REFRESH_MS;
  }

  // Background tabs wait until they are looked at again.
  function refreshIfStale() {
    if (!it.isSignedIn()) {
      if (entries.size > 0) forget();
      return;
    }
    if (document.visibilityState === 'hidden') return;
    // Another tab may have read it since this one last looked.
    if (isStale()) load();
    if (isStale()) refresh();
  }

  // Moves entries the way YouTube does, so the order stays right: after a
  // named entry, to the top, or with ACTION_MOVE_VIDEO_BEFORE to the bottom.
  function applyMoves(map, moves) {
    let order = [...map.keys()];
    for (const action of moves) {
      if (!map.has(action.setVideoId)) continue;
      if (action.action === IT.moveBeforeAction) {
        order = [...order.filter((id) => id !== action.setVideoId), action.setVideoId];
      } else {
        const after = action[IT.predecessorField] ?? null;
        if (after === null || order.includes(after)) order = core.applyMove(order, { setVideoId: action.setVideoId, after });
      }
    }
    return new Map(order.map((id) => [id, map.get(id)]));
  }

  // Applies a confirmed edit of Watch later to the list.
  function applyEdit({ playlistId, actions, response }) {
    if (playlistId !== WATCH_LATER) return;
    let next = new Map(entries);
    let unknown = false;
    const moves = actions.filter((action) => action?.action === IT.moveAfterAction || action?.action === IT.moveBeforeAction);
    for (const action of actions) {
      if (action?.action === IT.addAction) {
        const videoId = action[IT.addedVideoField];
        if (typeof videoId !== 'string') continue;
        // Until a read names the new entry, its video id stands in for it.
        next.set(core.readAddedSetVideoId(response, videoId) ?? `new:${videoId}`, videoId);
      } else if (action?.action === IT.removeByVideoIdAction) {
        const videoId = action[IT.removedVideoField];
        for (const [setVideoId, id] of next) if (id === videoId) next.delete(setVideoId);
      } else if (action?.action === IT.removeAction) {
        if (!next.delete(action.setVideoId)) unknown = true;
      }
    }
    // A move naming an entry the list doesn't know can't be placed.
    for (const action of moves) {
      const after = action[IT.predecessorField];
      if (!next.has(action.setVideoId) || (after !== undefined && !next.has(after))) unknown = true;
    }
    if (moves.length > 0) next = applyMoves(next, moves);
    setEntries(next);
    save();
    // An edit naming an entry the list didn't know means it is out of date.
    if (unknown) refresh();
  }

  function has(videoId) {
    return videoIds.has(videoId);
  }

  function size() {
    return videoIds.size;
  }

  // Where a saved video sits: the setVideoId of the entry before it, null
  // when it is first, or undefined when that isn't known.
  function placeOf(videoId) {
    let before = null;
    for (const [setVideoId, id] of entries) {
      if (id === videoId) return before?.startsWith('new:') ? undefined : before;
      before = setVideoId;
    }
    return undefined;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function start() {
    if (started) return;
    started = true;
    if (!it.isSignedIn()) return;
    load();
    it.observeEdits(applyEdit);
    // Another tab read Watch later or saw an edit.
    root.addEventListener('storage', (event) => {
      if (event.key === CACHE_KEY) load();
    });
    document.addEventListener('visibilitychange', refreshIfStale);
    setInterval(refreshIfStale, CHECK_EVERY_MS);
    refreshIfStale();
  }

  ns.watchLater = { start, has, size, placeOf, subscribe, refresh };
})(globalThis);
