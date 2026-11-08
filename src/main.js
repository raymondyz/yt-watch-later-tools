// Wiring: runs, cancel, restore, the Remove buttons, navigation detection, and
// the console API.
//
// Safety rules this file keeps:
// - Shuffles and restores only ever send moves (checked in
//   innertube.editPlaylist), so they can never remove a video. Stopping at
//   any point leaves every video in the playlist.
// - The only removal is the Remove button's: one entry per click, picked by
//   a setVideoId from the extension's own read, never guessed. Undo adds the
//   video back. The move-to-top and move-to-bottom buttons only send moves.
// - Nothing changes until a backup has been saved and read back.
// - One run at a time across every YouTube tab (Web Locks).
// - A run that starts changing a playlist is recorded until it finishes, so a
//   closed tab or a crash is reported the next time the playlist is opened.
(function (root) {
  const ns = root.__wlTools;
  const { core, innertube: it } = ns;
  const { CONFIG } = it;

  // Storage keys keep the extension's original "wls" prefix, so backups saved
  // before it was renamed stay readable.
  const BACKUP_PREFIX = 'wls:backup:';
  const JOURNAL_PREFIX = 'wls:active:';
  const RUN_LOCK = 'wls:run';
  const WATCH_LATER = 'WL';
  // Mixes and the play queue: lists YouTube makes up, which can't be edited.
  const NOT_EDITABLE = ['RD', 'TLPQ'];
  // YouTube can take a moment to reflect the last move in a fresh read.
  const SETTLE_MS = 1000;
  // Stops a run whose moves keep being refused for changing reasons.
  const MAX_REJECTIONS = 20;

  class CancelledError extends Error {
    constructor() {
      super('Cancelled.');
      this.name = 'CancelledError';
    }
  }

  // Expected situations, such as a second click. Shown in the panel but not
  // logged, because Chrome lists logged errors on the extension's Errors page.
  class UserError extends Error {}

  let running = false;
  let activeJob = null;
  let retryable = null;
  let busyElsewhere = false;
  let restoreQuestion = null;

  const view = { phase: 'idle', done: 0, total: 0, status: '', statusKind: 'info', playlistLabel: '' };

  function log(...args) {
    if (CONFIG.debug) console.log('[wlt]', ...args);
  }

  // For the debug log's timings.
  function seconds(since) {
    return `${((Date.now() - since) / 1000).toFixed(1)} s`;
  }

  // The playlist whose page is open, or null on any other page.
  function currentPlaylistId() {
    const { pathname, search } = root.location;
    if (pathname !== '/playlist') return null;
    return new URLSearchParams(search).get('list') || null;
  }

  function playlistLabel(playlistId) {
    if (playlistId === WATCH_LATER) return 'Watch later';
    if (playlistId !== currentPlaylistId()) return playlistId;
    const match = document.title.match(/^(?:\(\d+\)\s*)?(.+?)\s+-\s+YouTube$/);
    return match ? match[1] : playlistId;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  }

  function readStored(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (err) {
      return null;
    }
  }

  function loadBackups(playlistId) {
    const backups = readStored(BACKUP_PREFIX + playlistId);
    return Array.isArray(backups) ? backups : [];
  }

  function loadJournal(playlistId) {
    const journal = readStored(JOURNAL_PREFIX + playlistId);
    return typeof journal?.startedAt === 'string' ? journal : null;
  }

  function writeJournal(playlistId, kind) {
    try {
      localStorage.setItem(JOURNAL_PREFIX + playlistId, JSON.stringify({ kind, startedAt: new Date().toISOString() }));
    } catch (err) {
      log('Could not record the run.', err);
    }
  }

  function clearJournal(playlistId) {
    try {
      localStorage.removeItem(JOURNAL_PREFIX + playlistId);
    } catch (err) {
      log('Could not clear the run record.', err);
    }
  }

  function describeBackups(playlistId) {
    const backups = loadBackups(playlistId);
    return backups.map((backup, index) => ({
      id: backup.createdAt,
      label: formatDate(backup.createdAt),
      count: Array.isArray(backup.items) ? backup.items.length : 0,
      note: index === 0 ? 'latest' : index === backups.length - 1 ? 'oldest' : ''
    }));
  }

  // A run on this playlist started changing it and never finished, for
  // example because its tab was closed. Not shown right after a run in this
  // tab ends, because the status line already says what happened.
  function describeInterrupted(playlistId) {
    const journal = loadJournal(playlistId);
    if (!journal || busyElsewhere || view.phase !== 'idle') return null;
    const what = journal.kind === 'restore' ? 'restore' : 'shuffle';
    return {
      title: `Last ${what} didn't finish`,
      message: `A ${what} of this playlist started ${formatDate(journal.startedAt)} didn't finish, `
        + 'so its order may be partly changed. No videos were lost. To put it back, restore a '
        + 'backup below, or shuffle again.'
    };
  }

  function refreshView() {
    const pagePlaylist = currentPlaylistId();
    const idle = !running && pagePlaylist !== null;
    ns.ui?.render({
      ...view,
      visible: running || pagePlaylist !== null,
      playlistId: pagePlaylist,
      playlistLabel: running ? view.playlistLabel : (pagePlaylist && playlistLabel(pagePlaylist)) || '',
      backups: idle ? describeBackups(pagePlaylist) : [],
      interrupted: idle ? describeInterrupted(pagePlaylist) : null,
      busyElsewhere: idle && busyElsewhere,
      canRetry: idle && retryable?.playlistId === pagePlaylist
    });
  }

  function update(patch) {
    Object.assign(view, { statusKind: 'info' }, patch);
    log(view.status);
    refreshView();
  }

  function showProgress(job) {
    update({
      phase: 'running',
      done: job.done,
      total: job.total,
      status: `Moving ${job.done} / ${job.total}`
    });
  }

  function isSaved(backup) {
    const [saved] = loadBackups(backup.playlistId);
    return saved?.createdAt === backup.createdAt && saved.items?.length === backup.items.length;
  }

  // Nothing changes until the backup has been written and read back. If
  // storage is short, the middle backups go first; the oldest always stays.
  function saveBackup(playlistId, items) {
    const saved = loadBackups(playlistId);
    // Backups are picked by their time, so no two may share one.
    const taken = new Set(saved.map((entry) => entry.createdAt));
    let time = Date.now();
    while (taken.has(new Date(time).toISOString())) time += 1;
    const backup = { version: 1, createdAt: new Date(time).toISOString(), playlistId, items };
    const all = [backup, ...saved];
    for (const backups of [core.keepBackups(all, CONFIG.backupsToKeep), core.keepBackups(all, 2)]) {
      try {
        localStorage.setItem(BACKUP_PREFIX + playlistId, JSON.stringify(backups));
        if (isSaved(backup)) return;
      } catch (err) {
        log('Could not save the backup.', err);
      }
    }
    throw new Error('Could not save a backup, so nothing was changed. Browser storage for '
      + 'youtube.com may be full or blocked.');
  }

  function createJob(playlistId) {
    const session = it.readSession();
    const abort = new AbortController();
    const job = {
      playlistId,
      label: playlistLabel(playlistId),
      batchSize: Math.max(1, Math.floor(CONFIG.batchSize) || 1),
      abort,
      signal: abort.signal,
      target: [],
      byId: new Map(),
      done: 0,
      total: 0,
      rejections: 0,
      // How many times moves were planned, and how far into the target the
      // first accepted request reached. Both decide whether a quick check is
      // enough.
      passes: 0,
      reach: null,
      requests: 0,
      changing: false,
      resume: null,
      guard() {
        if (abort.signal.aborted) throw new CancelledError();
        const now = it.readSession();
        if (now.index !== session.index || now.pageId !== session.pageId) {
          throw new Error('The account changed during the run, so it was stopped.');
        }
      }
    };
    return job;
  }

  async function pause(job, err) {
    log('Pausing.', err);
    update({
      phase: 'paused',
      status: `Paused at ${job.done} / ${job.total}. ${err.message}`,
      statusKind: 'warn'
    });
    await new Promise((resolve) => {
      job.resume = resolve;
      job.signal.addEventListener('abort', resolve, { once: true });
    });
    job.resume = null;
    job.guard();
    // Leave the paused state at once, so a second click on Resume does nothing.
    update({ phase: 'reading', status: 'Reading the playlist again...' });
  }

  // Always a full fresh read: planning from a stale list causes HTTP 400s.
  async function readFresh(job) {
    while (true) {
      try {
        const since = Date.now();
        const list = await it.readPlaylist(job.playlistId, job);
        job.byId = new Map(list.items.map((item) => [item.setVideoId, item]));
        log(`Read ${list.items.length} videos in ${seconds(since)}.`);
        return list;
      } catch (err) {
        if (!it.isTransient(err)) throw err;
        await pause(job, err);
      }
    }
  }

  async function freshIds(job) {
    const { items } = await readFresh(job);
    return items.map((item) => item.setVideoId);
  }

  function moveKey(move) {
    return `${move.setVideoId}>${move.after}`;
  }

  // A rejected batch is retried at half the size. A single move rejected
  // twice in a row stops the run, and so does an endless run of rejections.
  function handleRejection(job, batch, lastRejected, err) {
    job.rejections += 1;
    if (job.rejections > MAX_REJECTIONS) throw new Error('YouTube kept refusing the moves, so the run stopped.');
    if (batch.length > 1) {
      job.batchSize = Math.max(1, Math.floor(batch.length / 2));
      log(`Batch of ${batch.length} rejected, retrying with ${job.batchSize}.`, err);
      return { rejected: null };
    }
    const key = moveKey(batch[0]);
    if (key === lastRejected) {
      throw new Error(job.done === 0
        ? 'YouTube refused to reorder this playlist. Some playlists, such as Liked videos, cannot be reordered.'
        : `YouTube rejected the same move twice (${key}). ${err.message}`);
    }
    log('Move rejected, planning again.', err);
    return { rejected: key };
  }

  // Sends moves in batches, one request at a time. Returns null when all were
  // sent, or { rejected } when the caller should re-read the list and plan again.
  async function sendMoves(job, moves, lastRejected) {
    const size = job.batchSize;
    let rejected = lastRejected;
    for (let i = 0; i < moves.length; i += size) {
      const batch = moves.slice(i, i + size);
      const actions = batch.map(core.toAction);
      try {
        await it.withRetries(
          () => it.editPlaylist(job.playlistId, actions, { signal: job.signal, known: job.byId }),
          job
        );
      } catch (err) {
        if (it.isRejection(err)) return handleRejection(job, batch, rejected, err);
        if (!it.isTransient(err)) throw err;
        await pause(job, err);
        return { rejected };
      }
      rejected = null;
      if (job.reach === null) job.reach = job.target.indexOf(batch.at(-1).setVideoId) + 1;
      job.requests += 1;
      job.done += batch.length;
      showProgress(job);
      await it.sleep(it.requestGap(), job.signal);
      job.guard();
    }
    return null;
  }

  async function executeMoves(job, startOrder) {
    let order = startOrder;
    let rejected = null;
    while (true) {
      job.passes += 1;
      job.target = core.buildRestoreTarget(order, job.target);
      const moves = core.planMoves(order, job.target);
      job.total = job.done + moves.length;
      showProgress(job);
      const outcome = await sendMoves(job, moves, rejected);
      if (outcome === null) return;
      rejected = outcome.rejected;
      order = await freshIds(job);
    }
  }

  async function countMisplaced(job) {
    update({ phase: 'verifying', status: 'Verifying the new order...' });
    await it.sleep(SETTLE_MS, job.signal);
    const order = await freshIds(job);
    job.target = core.buildRestoreTarget(order, job.target);
    return { order, misplaced: core.countOutOfPlace(order, job.target) };
  }

  // After a shuffle that went through in one pass, reading back the start of
  // the playlist, as far as the first request reached, is enough. Anything
  // that breaks every request, such as YouTube ignoring moves or taking only
  // part of a request, also breaks the first one, whose moves all land in that
  // range. Moves for later positions never touch the start, so this read needs
  // no settle wait. A difference, or a read that fails, falls back to the full
  // check.
  async function quickCheckPasses(job) {
    if (job.passes !== 1 || CONFIG.transport !== 'fetch') return false;
    update({ phase: 'verifying', status: 'Verifying the new order...' });
    const reach = Math.max(1, job.reach ?? 0);
    let list;
    try {
      list = await it.readPlaylist(job.playlistId, { guard: job.guard, signal: job.signal, maxItems: reach });
    } catch (err) {
      if (!it.isTransient(err)) throw err;
      log('Quick check could not read the playlist, checking all of it.', err);
      return false;
    }
    const ids = list.items.map((item) => item.setVideoId);
    const enough = list.complete ? ids.length === job.target.length : ids.length >= reach;
    const passed = enough && ids.every((id, i) => id === job.target[i]);
    log(passed
      ? `Quick check passed: the first ${ids.length} videos match.`
      : 'Quick check found a difference, checking all of it.');
    return passed;
  }

  // Restores, and runs that had to plan again, always get the full check.
  async function verify(job, { quick = false } = {}) {
    if (quick && await quickCheckPasses(job)) return 0;
    const first = await countMisplaced(job);
    if (first.misplaced === 0) return 0;
    log(`${first.misplaced} items out of place, running one repair pass.`);
    await executeMoves(job, first.order);
    return (await countMisplaced(job)).misplaced;
  }

  function finish(job, verb, misplaced) {
    clearJournal(job.playlistId);
    const count = job.target.length;
    const target = job.target.map((id) => job.byId.get(id));
    if (misplaced === 0) {
      update({
        phase: 'done',
        status: `${verb} ${count} videos. Done. Reload to see the new order.`
      });
      return { status: 'done', target };
    }
    retryable = { playlistId: job.playlistId, target: job.target, verb };
    update({
      phase: 'partial',
      status: `${verb} with ${misplaced} items out of place.`,
      statusKind: 'warn'
    });
    return { status: 'partial', outOfPlace: misplaced, target };
  }

  function warnBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = '';
  }

  // From here until the run ends, the playlist may differ from its backup.
  function startChanging(job, kind) {
    job.changing = true;
    writeJournal(job.playlistId, kind);
    root.addEventListener('beforeunload', warnBeforeUnload);
  }

  async function drive(job, order, target, verb, { quick = false } = {}) {
    job.target = target;
    startChanging(job, verb === 'Restored' ? 'restore' : 'shuffle');
    const movingSince = Date.now();
    await executeMoves(job, order);
    log(`Sent ${job.done} moves in ${job.requests} requests, ${seconds(movingSince)}.`);
    const checkingSince = Date.now();
    const misplaced = await verify(job, { quick });
    log(`Checked the order in ${seconds(checkingSince)}.`);
    log('Target order:', job.target.map((id) => job.byId.get(id)?.title ?? id));
    return finish(job, verb, misplaced);
  }

  function describeFailure(err) {
    if (!it.isAuthFailure(err)) return err.message;
    return `YouTube refused the request (HTTP ${err.status}) even with a fresh auth header. `
      + `Try the ytAction transport: set localStorage '${it.CONFIG_KEY}' to `
      + '{"transport":"ytAction"} and reload.';
  }

  function endWithError(err, job) {
    const partly = ' No videos were lost, but the order may be partly changed. Restore a backup to put it back.';
    if (err instanceof CancelledError) {
      update({
        phase: 'cancelled',
        status: job.changing ? `Stopped at ${job.done} / ${job.total}.${partly}` : 'Stopped. Nothing was changed.'
      });
      return { status: 'cancelled' };
    }
    if (!(err instanceof UserError)) console.error('[wlt]', err);
    const status = describeFailure(err) + (job.changing ? partly : '');
    update({ phase: 'failed', status, statusKind: 'error' });
    return { status: 'failed', error: status };
  }

  // Web Locks are shared by every youtube.com tab and released when a tab
  // closes or crashes, so a dead tab never blocks the next run.
  function withRunLock(task) {
    const locks = root.navigator?.locks;
    if (!locks) return task();
    return locks.request(RUN_LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) {
        throw new UserError('Another YouTube tab is shuffling or restoring a playlist. Try again when it finishes.');
      }
      return task();
    });
  }

  async function exclusive(playlistId, body) {
    if (running) throw new UserError('A shuffle or restore is already running in this tab.');
    running = true;
    retryable = null;
    let job = null;
    try {
      return await withRunLock(async () => {
        job = createJob(playlistId);
        activeJob = job;
        update({
          phase: 'reading',
          done: 0,
          total: 0,
          status: 'Reading the playlist...',
          playlistLabel: job.label
        });
        return await body(job);
      });
    } catch (err) {
      return endWithError(err, job ?? { done: 0, total: 0, changing: false });
    } finally {
      running = false;
      activeJob = null;
      root.removeEventListener('beforeunload', warnBeforeUnload);
      refreshView();
    }
  }

  function countWarning(fetched, displayed) {
    if (displayed === null || displayed <= fetched) return '';
    return `${displayed - fetched} of the ${displayed} videos are hidden or unavailable, so YouTube `
      + 'does not list them. They will not be moved.';
  }

  // Asks in the panel when the UI is loaded, and with the browser's dialog otherwise.
  function askConfirm(request, signal) {
    if (ns.ui?.confirm) return ns.ui.confirm(request, signal);
    const text = [request.title, request.message, request.warning].filter(Boolean).join('\n\n');
    return Promise.resolve(root.confirm(text));
  }

  function run({ playlistId = WATCH_LATER } = {}) {
    return exclusive(playlistId, async (job) => {
      const { items, displayedCount } = await readFresh(job);
      if (items.length < 2) {
        update({ phase: 'idle', status: 'Nothing to shuffle' });
        return { status: 'nothing' };
      }
      // Shown in the question rather than logged: Chrome lists console
      // warnings from extensions on its Errors page.
      const warning = countWarning(items.length, displayedCount);
      update({ phase: 'confirm', status: '' });
      const confirmed = await askConfirm({
        title: `Shuffle the order of "${job.label}"?`,
        message: `This permanently rearranges its ${items.length} videos into a random order and `
          + 'saves it on YouTube, so the new order shows on all your devices. This is not shuffle '
          + 'play. A backup of the current order is saved first, so you can restore it.',
        warning,
        confirmLabel: `Shuffle ${items.length} videos`
      }, job.signal);
      if (!confirmed) {
        update({ phase: 'idle', status: '' });
        return { status: 'declined' };
      }
      job.guard();
      saveBackup(job.playlistId, items);
      const ids = items.map((item) => item.setVideoId);
      // A shuffle's exact order matters less than its speed, so it gets the
      // quick check.
      return drive(job, ids, core.shuffle(ids), 'Shuffled', { quick: true });
    });
  }

  async function restoreFromBackup(backup) {
    core.validateBackup(backup);
    return exclusive(backup.playlistId, async (job) => {
      const order = await freshIds(job);
      const saved = backup.items.map((item) => item.setVideoId);
      return drive(job, order, core.buildRestoreTarget(order, saved), 'Restored');
    });
  }

  async function restore({ playlistId = WATCH_LATER } = {}) {
    const [latest] = loadBackups(playlistId);
    if (!latest) throw new Error(`No saved backup for ${playlistId}.`);
    return restoreFromBackup(latest);
  }

  function retry({ playlistId, target, verb }) {
    return exclusive(playlistId, async (job) => drive(job, await freshIds(job), target, verb));
  }

  function cancel() {
    activeJob?.abort.abort();
  }

  // Continues a paused run, or retries one that ended with items out of place.
  // During a run that is not paused there is nothing to do, so repeated
  // clicks are ignored.
  function resume() {
    if (activeJob) return activeJob.resume?.();
    if (retryable) return retry(retryable);
    throw new UserError('Nothing to resume.');
  }

  async function fetchPlaylist(playlistId = WATCH_LATER) {
    return (await it.readPlaylist(playlistId)).items;
  }

  // Restoring from the panel asks first: it is one click away and does not
  // back up the current order. Backups are found by id, not position, so a
  // backup saved meanwhile by another tab cannot shift which one is used.
  async function restoreFromPanel(backupId) {
    const playlistId = currentPlaylistId();
    const backup = loadBackups(playlistId).find((entry) => entry.createdAt === backupId);
    if (!backup) throw new UserError('That backup is no longer available.');
    restoreQuestion?.abort();
    const question = new AbortController();
    restoreQuestion = question;
    try {
      const confirmed = await askConfirm({
        title: 'Restore this saved order?',
        message: `This puts the videos in "${playlistLabel(playlistId)}" back in the order saved on `
          + `${formatDate(backup.createdAt)}, on YouTube and all your devices. Videos added since then `
          + 'go to the top. The current order is not backed up first.',
        confirmLabel: 'Restore order'
      }, question.signal);
      return confirmed ? restoreFromBackup(backup) : { status: 'declined' };
    } finally {
      if (restoreQuestion === question) restoreQuestion = null;
    }
  }

  // The Remove button on each video. A row only knows its video id, from its
  // link; the setVideoId that picks the playlist entry comes from reading the
  // playlist. Watch later holds each video once, so its first page is enough
  // for the videos on it. Any other playlist is read in full first, so a
  // video that is in it twice is refused instead of guessed.
  // `removed` and `added` are this tab's own changes, applied over every read,
  // so a read that was under way during a change can't undo it. setVideoIds
  // are never reused, so a removed one can never come back as another video.
  function createEntries(playlistId) {
    return {
      playlistId,
      byVideo: new Map(),
      removed: new Set(),
      added: new Map(),
      complete: false,
      reading: null,
      abort: new AbortController()
    };
  }

  let entries = createEntries(null);

  function addEntry(store, videoId, setVideoId) {
    const found = store.byVideo.get(videoId) ?? new Set();
    found.add(setVideoId);
    store.byVideo.set(videoId, found);
  }

  // Joins a read already under way when it reads at least as much.
  function readEntries(store, full) {
    if (store.reading && (store.reading.full || !full)) return store.reading.promise;
    const reading = { full, promise: null };
    reading.promise = (async () => {
      try {
        const list = await it.readPlaylist(store.playlistId, {
          signal: store.abort.signal,
          maxItems: full ? Infinity : 1
        });
        if (full) store.byVideo = new Map();
        for (const item of list.items) addEntry(store, item.videoId, item.setVideoId);
        for (const [setVideoId, videoId] of store.added) addEntry(store, videoId, setVideoId);
        for (const found of store.byVideo.values()) {
          for (const setVideoId of store.removed) found.delete(setVideoId);
        }
        store.complete = store.complete || list.complete;
        return list;
      } finally {
        if (store.reading === reading) store.reading = null;
      }
    })();
    store.reading = reading;
    return reading.promise;
  }

  function entriesFor(playlistId) {
    if (entries.playlistId !== playlistId) throw new UserError('The page changed. Reload it and try again.');
    return entries;
  }

  function isTrusted(store, videoId) {
    return Boolean(store.byVideo.get(videoId)?.size) && (store.complete || store.playlistId === WATCH_LATER);
  }

  async function findEntry(store, videoId) {
    if (!isTrusted(store, videoId)) await readEntries(store, true);
    const found = [...(store.byVideo.get(videoId) ?? [])];
    if (found.length === 0) {
      throw new UserError('This video is no longer in the playlist. Reload the page to see the current list.');
    }
    if (found.length > 1) {
      throw new UserError('This video is in the playlist more than once, so it is not clear which one to '
        + 'remove. Use YouTube\'s menu for this one.');
    }
    return found[0];
  }

  // Shown next to the row, so it says what happened in plain words.
  function rowError(err, failed) {
    if (err instanceof UserError) return err;
    console.error('[wlt]', err);
    if (it.isAuthFailure(err) || (it.isRejection(err) && err.status)) {
      return new Error(`${failed} YouTube refused it (HTTP ${err.status}). Reload the page and try again.`);
    }
    if (it.isRejection(err)) return new Error(`${failed} ${err.message}`);
    return new Error(`${failed} ${err.message}. Try again.`);
  }

  // Called when the pointer or focus reaches a Remove button, so the read a
  // click needs is usually done by the time it comes.
  function prepareRemove({ playlistId, videoId }) {
    if (entries.playlistId !== playlistId || isTrusted(entries, videoId)) return;
    readEntries(entries, true).catch((err) => log('Could not read the playlist ahead of a removal.', err));
  }

  async function removeVideo({ playlistId, videoId }) {
    try {
      const store = entriesFor(playlistId);
      const setVideoId = await findEntry(store, videoId);
      await it.removeFromPlaylist(playlistId, setVideoId, { signal: store.abort.signal });
      store.removed.add(setVideoId);
      store.byVideo.get(videoId)?.delete(setVideoId);
      log(`Removed ${videoId} (${setVideoId}) from ${playlistId}.`);
    } catch (err) {
      throw rowError(err, 'Not removed.');
    }
  }

  // Moves an entry to just after the video `afterVideoId` (null for the top).
  async function placeAfter(store, playlistId, setVideoId, afterVideoId) {
    const after = afterVideoId ? await findEntry(store, afterVideoId) : null;
    const known = new Set([setVideoId, after].filter(Boolean));
    const actions = [core.toAction({ setVideoId, after })];
    await it.withRetries(
      () => it.editPlaylist(playlistId, actions, { signal: store.abort.signal, known }),
      { signal: store.abort.signal }
    );
  }

  // Adds the video back, then moves it after the video that was above it:
  // `afterVideoId` null means the top, and undefined means the old place is
  // not known. Returns { placed: false } when it is back but somewhere else.
  async function undoRemove({ playlistId, videoId, afterVideoId }) {
    let store;
    let added;
    try {
      store = entriesFor(playlistId);
      added = await it.addToPlaylist(playlistId, videoId, { signal: store.abort.signal });
    } catch (err) {
      throw rowError(err, 'Not added back.');
    }
    try {
      if (added !== null) {
        store.added.set(added, videoId);
        addEntry(store, videoId, added);
      }
      if (afterVideoId === undefined) return { placed: false };
      const setVideoId = added ?? await findEntry(store, videoId);
      await placeAfter(store, playlistId, setVideoId, afterVideoId);
      log(`Added ${videoId} back after ${afterVideoId ?? 'nothing (top)'}.`);
      return { placed: true };
    } catch (err) {
      log('Added back, but could not move it to its old place.', err);
      return { placed: false };
    }
  }

  // Whether YouTube takes a move to the bottom that names no other video:
  // null until known, then true or false until the page reloads.
  let bottomInOneStep = null;

  // The slow but certain way: read the whole playlist and move the video
  // after whatever is last now.
  async function moveAfterLast(store, playlistId, setVideoId) {
    const { items } = await it.readPlaylist(playlistId, { signal: store.abort.signal });
    const last = items.at(-1)?.setVideoId;
    if (!last || last === setVideoId) return;
    const actions = [core.toAction({ setVideoId, after: last })];
    await it.withRetries(
      () => it.editPlaylist(playlistId, actions, { signal: store.abort.signal, known: new Set([setVideoId, last]) }),
      { signal: store.abort.signal }
    );
  }

  async function moveToBottom(store, playlistId, setVideoId) {
    if (bottomInOneStep !== false) {
      const actions = [{ action: core.INNERTUBE.moveBeforeAction, setVideoId }];
      try {
        await it.withRetries(
          () => it.editPlaylist(playlistId, actions, { signal: store.abort.signal, known: new Set([setVideoId]) }),
          { signal: store.abort.signal }
        );
        bottomInOneStep = true;
        return;
      } catch (err) {
        if (!it.isRejection(err) || bottomInOneStep === true) throw err;
        log('YouTube refused a one-step move to the bottom, so moving after the last video instead.', err);
      }
    }
    await moveAfterLast(store, playlistId, setVideoId);
    // Only now is it clear the refusal was about the one-step move itself.
    bottomInOneStep = false;
  }

  // The move buttons: `to` is 'top' or 'bottom'.
  async function moveVideo({ playlistId, videoId, to }) {
    try {
      const store = entriesFor(playlistId);
      const setVideoId = await findEntry(store, videoId);
      if (to === 'top') await placeAfter(store, playlistId, setVideoId, null);
      else await moveToBottom(store, playlistId, setVideoId);
      log(`Moved ${videoId} to the ${to} of ${playlistId}.`);
    } catch (err) {
      throw rowError(err, 'Not moved.');
    }
  }

  // The playlist whose videos this page lists: a playlist page, or a video
  // playing from a playlist, with the playlist in the panel beside it. Mixes
  // and the queue can't be edited, so they are skipped without a request.
  function listedPlaylistId() {
    const { pathname, search } = root.location;
    if (pathname !== '/playlist' && pathname !== '/watch') return null;
    const playlistId = new URLSearchParams(search).get('list');
    if (!playlistId || NOT_EDITABLE.some((prefix) => playlistId.startsWith(prefix))) return null;
    return playlistId;
  }

  // Remove buttons show only where the first page of the playlist came with
  // setVideoIds, which YouTube includes only for playlists you can edit.
  async function watchRemovals() {
    const playlistId = listedPlaylistId();
    if (playlistId === entries.playlistId) return;
    entries.abort.abort();
    const store = createEntries(playlistId);
    entries = store;
    ns.rows?.show({ playlistId, removable: false });
    if (!playlistId) return;
    let removable = false;
    try {
      removable = (await readEntries(store, false)).items.length > 0;
    } catch (err) {
      log('No Remove buttons on this playlist:', err.message);
    }
    if (entries !== store) return;
    const label = playlistId === WATCH_LATER ? 'Watch later' : 'this playlist';
    ns.rows?.show({ playlistId, removable, label });
  }

  function dismissInterrupted() {
    const playlistId = currentPlaylistId();
    if (playlistId) clearJournal(playlistId);
    refreshView();
  }

  function reportClickError(err) {
    if (!(err instanceof UserError)) console.error('[wlt]', err);
    update({ status: err.message, statusKind: 'error' });
  }

  async function checkOtherTabs() {
    const locks = root.navigator?.locks;
    if (!locks?.query) return;
    try {
      const { held = [] } = await locks.query();
      const next = !running && held.some((lock) => lock.name === RUN_LOCK);
      if (next !== busyElsewhere) {
        busyElsewhere = next;
        refreshView();
      }
    } catch (err) {
      log('Could not check other tabs.', err);
    }
  }

  function watchPage() {
    const pageKey = () => `${root.location.href}\n${document.title}`;
    let lastKey = pageKey();
    let lastPlaylist = currentPlaylistId();
    const onNavigate = () => {
      lastKey = pageKey();
      const playlistId = currentPlaylistId();
      // A finished run's message, and an open restore question, belong to
      // their playlist, not the next one.
      if (!running && playlistId !== lastPlaylist) {
        retryable = null;
        restoreQuestion?.abort();
        Object.assign(view, { phase: 'idle', done: 0, total: 0, status: '', statusKind: 'info' });
      }
      lastPlaylist = playlistId;
      refreshView();
      checkOtherTabs();
      watchRemovals();
    };
    document.addEventListener('yt-navigate-finish', onNavigate);
    root.addEventListener('popstate', onNavigate);
    // Another tab saved a backup or finished a run.
    root.addEventListener('storage', (event) => {
      if (event.key === null || event.key.startsWith('wls:')) refreshView();
    });
    setInterval(() => {
      if (pageKey() !== lastKey) onNavigate();
      else checkOtherTabs();
    }, 1000);
  }

  Object.assign(ns, {
    fetchPlaylist,
    run,
    restore,
    restoreFromBackup,
    cancel,
    resume,
    config: CONFIG
  });

  ns.ui?.mount({
    onShuffle: () => {
      const playlistId = currentPlaylistId();
      return playlistId ? run({ playlistId }).catch(reportClickError) : Promise.resolve();
    },
    onRestore: (backupId) => restoreFromPanel(backupId).catch(reportClickError),
    onStop: cancel,
    onResume: () => Promise.resolve().then(resume).catch(reportClickError),
    onDismiss: dismissInterrupted,
    onReload: () => root.location.reload()
  });

  ns.rows?.mount({
    onPrepare: prepareRemove,
    onRemove: removeVideo,
    onUndo: undoRemove,
    onMove: moveVideo
  });

  watchPage();
  refreshView();
  checkOtherTabs();
  watchRemovals();
})(globalThis);
