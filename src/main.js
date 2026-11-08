// Wiring: runs, cancel, restore, navigation detection, and the console API.
(function (root) {
  const ns = root.__wlShuffle;
  const { core, innertube: it } = ns;
  const { CONFIG } = it;

  const BACKUP_PREFIX = 'wls:backup:';
  const WATCH_LATER = 'WL';
  // YouTube can take a moment to reflect the last move in a fresh read.
  const SETTLE_MS = 1000;

  class CancelledError extends Error {
    constructor() {
      super('Cancelled.');
      this.name = 'CancelledError';
    }
  }

  let running = false;
  let activeJob = null;
  let retryable = null;

  const view = { phase: 'idle', done: 0, total: 0, status: '', statusKind: 'info', playlistLabel: '' };

  function log(...args) {
    if (CONFIG.debug) console.log('[wls]', ...args);
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
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function loadBackups(playlistId) {
    try {
      const backups = JSON.parse(localStorage.getItem(BACKUP_PREFIX + playlistId));
      return Array.isArray(backups) ? backups : [];
    } catch (err) {
      return [];
    }
  }

  function describeBackups(playlistId) {
    return loadBackups(playlistId).map((backup) => ({
      label: formatDate(backup.createdAt),
      count: Array.isArray(backup.items) ? backup.items.length : 0
    }));
  }

  function refreshView() {
    const pagePlaylist = currentPlaylistId();
    const idle = !running && pagePlaylist !== null;
    ns.ui?.render({
      ...view,
      visible: running || pagePlaylist !== null,
      playlistLabel: running ? view.playlistLabel : (pagePlaylist && playlistLabel(pagePlaylist)) || '',
      backups: idle ? describeBackups(pagePlaylist) : [],
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

  // A shuffle never starts without a backup, so a failure here stops the run.
  function saveBackup(playlistId, items) {
    const backup = { version: 1, createdAt: new Date().toISOString(), playlistId, items };
    try {
      const backups = [backup, ...loadBackups(playlistId)].slice(0, CONFIG.backupsToKeep);
      localStorage.setItem(BACKUP_PREFIX + playlistId, JSON.stringify(backups));
    } catch (err) {
      throw new Error('Could not save a backup, so nothing was changed. Browser storage for '
        + 'youtube.com may be full.', { cause: err });
    }
  }

  function createJob(playlistId) {
    const session = it.readSession();
    const abort = new AbortController();
    const job = {
      playlistId,
      label: playlistLabel(playlistId),
      abort,
      signal: abort.signal,
      target: [],
      byId: new Map(),
      done: 0,
      total: 0,
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
    console.warn('[wls] Pausing.', err);
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
  }

  // Always a full fresh read: planning from a stale list causes HTTP 400s.
  async function readFresh(job) {
    while (true) {
      try {
        const list = await it.readPlaylist(job.playlistId, job);
        job.byId = new Map(list.items.map((item) => [item.setVideoId, item]));
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

  // Sends moves one request at a time. Returns null when all were sent, or
  // { rejected } when the caller should re-read the list and plan again.
  async function sendMoves(job, moves, lastRejected) {
    const size = Math.max(1, CONFIG.batchSize);
    let rejected = lastRejected;
    for (let i = 0; i < moves.length; i += size) {
      const batch = moves.slice(i, i + size);
      const key = moveKey(batch[0]);
      try {
        await it.withRetries(() => it.editPlaylist(job.playlistId, batch.map(core.toAction)), job);
      } catch (err) {
        if (it.isRejection(err)) {
          if (key === rejected) throw new Error(`YouTube rejected the same move twice (${key}). ${err.message}`);
          console.warn('[wls] Move rejected, planning again.', err);
          return { rejected: key };
        }
        if (!it.isTransient(err)) throw err;
        await pause(job, err);
        return { rejected };
      }
      rejected = null;
      job.done += batch.length;
      showProgress(job);
      await it.sleep(CONFIG.delayMs, job.signal);
      job.guard();
    }
    return null;
  }

  async function executeMoves(job, startOrder) {
    let order = startOrder;
    let rejected = null;
    while (true) {
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

  async function verify(job) {
    const first = await countMisplaced(job);
    if (first.misplaced === 0) return 0;
    log(`${first.misplaced} items out of place, running one repair pass.`);
    await executeMoves(job, first.order);
    return (await countMisplaced(job)).misplaced;
  }

  function finish(job, verb, misplaced) {
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

  async function drive(job, order, target, verb) {
    job.target = target;
    await executeMoves(job, order);
    const misplaced = await verify(job);
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
    if (err instanceof CancelledError) {
      update({
        phase: 'cancelled',
        status: `Stopped at ${job.done} / ${job.total}. No videos were lost, but the order is only `
          + 'partly changed. Restore the latest backup to undo it.'
      });
      return { status: 'cancelled' };
    }
    console.error('[wls]', err);
    const status = describeFailure(err);
    update({ phase: 'failed', status, statusKind: 'error' });
    return { status: 'failed', error: status };
  }

  function warnBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = '';
  }

  async function exclusive(playlistId, body) {
    if (running) throw new Error('A run is already in progress.');
    running = true;
    retryable = null;
    root.addEventListener('beforeunload', warnBeforeUnload);
    try {
      activeJob = createJob(playlistId);
      update({
        phase: 'reading',
        done: 0,
        total: 0,
        status: 'Reading the playlist...',
        playlistLabel: activeJob.label
      });
      return await body(activeJob);
    } catch (err) {
      return endWithError(err, activeJob ?? { done: 0, total: 0 });
    } finally {
      running = false;
      activeJob = null;
      root.removeEventListener('beforeunload', warnBeforeUnload);
      refreshView();
    }
  }

  function countWarning(fetched, displayed) {
    if (displayed === null || displayed === fetched) return '';
    return `YouTube shows ${displayed} videos but only ${fetched} could be read. `
      + 'This is normal when some videos are hidden or unavailable.';
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
      const warning = countWarning(items.length, displayedCount);
      if (warning) console.warn(`[wls] ${warning}`);
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
      saveBackup(job.playlistId, items);
      const ids = items.map((item) => item.setVideoId);
      return drive(job, ids, core.shuffle(ids), 'Shuffled');
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
  function resume() {
    if (activeJob?.resume) return activeJob.resume();
    if (retryable) return retry(retryable);
    throw new Error('Nothing to resume.');
  }

  async function fetchPlaylist(playlistId = WATCH_LATER) {
    return (await it.readPlaylist(playlistId)).items;
  }

  // Restoring from the panel asks first: it is one click away and does not
  // back up the current order.
  async function restoreFromPanel(index) {
    const playlistId = currentPlaylistId();
    const backup = loadBackups(playlistId)[index];
    if (!backup) throw new Error('That backup is no longer available.');
    const confirmed = await askConfirm({
      title: 'Restore this saved order?',
      message: `This puts the videos in "${playlistLabel(playlistId)}" back in the order saved on `
        + `${formatDate(backup.createdAt)}, on YouTube and all your devices. Videos added since then `
        + 'go to the top. The current order is not backed up first.',
      confirmLabel: 'Restore order'
    });
    return confirmed ? restoreFromBackup(backup) : { status: 'declined' };
  }

  function reportClickError(err) {
    console.error('[wls]', err);
    update({ status: err.message, statusKind: 'error' });
  }

  function watchNavigation() {
    const pageKey = () => `${root.location.href}\n${document.title}`;
    let lastKey = pageKey();
    let lastPlaylist = currentPlaylistId();
    const onNavigate = () => {
      lastKey = pageKey();
      const playlistId = currentPlaylistId();
      // A finished run's message belongs to its playlist, not the next one.
      if (!running && playlistId !== lastPlaylist) {
        retryable = null;
        Object.assign(view, { phase: 'idle', done: 0, total: 0, status: '', statusKind: 'info' });
      }
      lastPlaylist = playlistId;
      refreshView();
    };
    document.addEventListener('yt-navigate-finish', onNavigate);
    root.addEventListener('popstate', onNavigate);
    setInterval(() => {
      if (pageKey() !== lastKey) onNavigate();
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
    onRestore: (index) => restoreFromPanel(index).catch(reportClickError),
    onStop: cancel,
    onResume: () => Promise.resolve().then(resume).catch(reportClickError),
    onReload: () => root.location.reload()
  });

  watchNavigation();
  refreshView();
})(globalThis);
