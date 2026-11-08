// Pure logic: shuffling, move planning, response parsing. No DOM, no fetch.
(function (root) {
  // Every undocumented YouTube name lives here, so a YouTube change is a
  // one-place fix. It sits in core.js rather than innertube.js because core.js
  // loads first and must also run under Node, and it needs these names itself.
  const INNERTUBE = Object.freeze({
    origin: 'https://www.youtube.com',
    apiBase: '/youtubei/v1/',
    browsePath: 'browse',
    editPlaylistPath: 'browse/edit_playlist',
    browseIdPrefix: 'VL',

    contextKey: 'INNERTUBE_CONTEXT',
    sessionIndexKey: 'SESSION_INDEX',
    delegatedSessionKey: 'DELEGATED_SESSION_ID',
    userSessionKey: 'USER_SESSION_ID',
    clientNameKey: 'INNERTUBE_CONTEXT_CLIENT_NAME',
    clientVersionKey: 'INNERTUBE_CLIENT_VERSION',

    sapisidCookie: 'SAPISID',
    sapisid1pCookie: '__Secure-1PAPISID',
    sapisid3pCookie: '__Secure-3PAPISID',

    moveAfterAction: 'ACTION_MOVE_VIDEO_AFTER',
    predecessorField: 'movedSetVideoIdPredecessor',
    successStatus: 'STATUS_SUCCEEDED',

    videoRenderer: 'playlistVideoRenderer',
    lockupRenderer: 'lockupViewModel',
    lockupVideoType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    continuationRenderers: Object.freeze(['continuationItemRenderer', 'continuationItemViewModel']),
    continuationCommand: 'continuationCommand',
    legacyContinuation: 'nextContinuationData',
    countText: 'numVideosText',
    countStatsRenderer: 'playlistSidebarPrimaryInfoRenderer',

    appElement: 'ytd-app',
    actionEvent: 'yt-action',
    serviceRequestAction: 'yt-service-request',
    editEndpoint: 'playlistEditEndpoint'
  });

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

  function applyMove(order, move) {
    const next = order.filter((id) => id !== move.setVideoId);
    const index = move.after === null ? 0 : next.indexOf(move.after) + 1;
    next.splice(index, 0, move.setVideoId);
    return next;
  }

  function assertSameIds(current, target) {
    const currentIds = new Set(current);
    const sameIds = current.length === target.length
      && currentIds.size === current.length
      && new Set(target).size === target.length
      && target.every((id) => currentIds.has(id));
    if (!sameIds) throw new Error('planMoves: current and target must contain the same ids.');
  }

  function planMoves(current, target) {
    assertSameIds(current, target);
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
    const action = { action: INNERTUBE.moveAfterAction, setVideoId: move.setVideoId };
    if (move.after !== null) action[INNERTUBE.predecessorField] = move.after;
    return action;
  }

  function walk(node, visit) {
    if (node === null || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) walk(value, visit);
  }

  function readTitle(video) {
    return video.title?.runs?.[0]?.text ?? video.title?.simpleText ?? '';
  }

  function toItems(videos) {
    const bySetVideoId = new Map();
    for (const video of videos) {
      if (typeof video.setVideoId !== 'string' || typeof video.videoId !== 'string') continue;
      if (bySetVideoId.has(video.setVideoId)) continue;
      bySetVideoId.set(video.setVideoId, {
        setVideoId: video.setVideoId,
        videoId: video.videoId,
        title: readTitle(video)
      });
    }
    return [...bySetVideoId.values()];
  }

  // A lockup keeps its video id in contentId. Read-only pages leave setVideoId
  // out entirely, so look for it anywhere inside and report null if it is gone.
  function fromLockup(lockup) {
    let setVideoId = null;
    walk(lockup, (node) => {
      if (setVideoId === null && typeof node.setVideoId === 'string') setVideoId = node.setVideoId;
    });
    const title = lockup.metadata?.lockupMetadataViewModel?.title?.content;
    return { videoId: lockup.contentId, setVideoId, title: { simpleText: title } };
  }

  function collectVideos(json) {
    const rendered = [];
    const lockups = [];
    const bare = [];
    walk(json, (node) => {
      if (node[INNERTUBE.videoRenderer]) rendered.push(node[INNERTUBE.videoRenderer]);
      const lockup = node[INNERTUBE.lockupRenderer];
      if (lockup?.contentType === INNERTUBE.lockupVideoType) lockups.push(fromLockup(lockup));
      if (typeof node.videoId === 'string' && typeof node.setVideoId === 'string') bare.push(node);
    });
    return { rendered, lockups, bare };
  }

  function isVideoEntry(entry) {
    return Boolean(entry?.[INNERTUBE.videoRenderer] || entry?.[INNERTUBE.lockupRenderer]);
  }

  // Walking the whole entry finds the token however deeply it is nested.
  function readContinuationToken(node) {
    let token = null;
    for (const key of INNERTUBE.continuationRenderers) {
      walk(node?.[key], (inner) => {
        const candidate = inner[INNERTUBE.continuationCommand]?.token;
        if (token === null && typeof candidate === 'string') token = candidate;
      });
    }
    return token;
  }

  // Pages can also carry section-level tokens that load content other than the
  // playlist, so a token sitting next to the videos always wins.
  function findContinuation(json) {
    let listToken = null;
    let anyToken = null;
    let legacyToken = null;
    walk(json, (node) => {
      if (Array.isArray(node) && node.some(isVideoEntry)) {
        for (const entry of node) listToken = listToken ?? readContinuationToken(entry);
      }
      anyToken = anyToken ?? readContinuationToken(node);
      const legacy = node[INNERTUBE.legacyContinuation]?.continuation;
      if (legacyToken === null && typeof legacy === 'string') legacyToken = legacy;
    });
    return listToken ?? anyToken ?? legacyToken;
  }

  // `unmovable` counts videos that were found but came without a setVideoId.
  function parsePlaylistPage(json) {
    const { rendered, lockups, bare } = collectVideos(json);
    const items = [rendered, lockups, bare].map(toItems).find((list) => list.length > 0) ?? [];
    const unmovable = lockups.filter((lockup) => lockup.setVideoId === null).length;
    return { items, continuation: findContinuation(json), unmovable };
  }

  function readText(value) {
    if (typeof value?.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value?.runs)) return value.runs.map((run) => run.text ?? '').join('');
    return '';
  }

  function toCount(text) {
    const digits = text.replace(/\D/g, '');
    return digits === '' ? null : Number(digits);
  }

  // Best effort: returns null when no count can be found.
  function parseDisplayedCount(json) {
    let count = null;
    walk(json, (node) => {
      if (count !== null) return;
      const stats = node[INNERTUBE.countStatsRenderer]?.stats;
      const text = readText(node[INNERTUBE.countText]) || readText(stats?.[0]);
      if (text !== '') count = toCount(text);
    });
    return count;
  }

  function isEditSuccess(json) {
    let succeeded = false;
    walk(json, (node) => {
      if (node.status === INNERTUBE.successStatus) succeeded = true;
    });
    return succeeded;
  }

  // Unknown ids go first in their current relative order, then the wanted ids
  // that are still present. Ids that are gone are dropped. Restore uses this
  // to build its target, and a run uses it to survive playlist edits made
  // while it is in progress.
  function buildRestoreTarget(current, wanted) {
    const present = new Set(current);
    const wantedIds = new Set(wanted);
    return [
      ...current.filter((id) => !wantedIds.has(id)),
      ...[...wantedIds].filter((id) => present.has(id))
    ];
  }

  function countOutOfPlace(current, target) {
    return target.filter((id, i) => current[i] !== id).length;
  }

  function validateBackup(backup) {
    const valid = backup?.version === 1
      && typeof backup.playlistId === 'string'
      && Array.isArray(backup.items)
      && backup.items.every((item) => typeof item?.setVideoId === 'string');
    if (!valid) throw new Error('Not a valid Watch Later Shuffle backup.');
  }

  const api = {
    INNERTUBE,
    randomInt,
    shuffle,
    applyMove,
    planMoves,
    toAction,
    parsePlaylistPage,
    parseDisplayedCount,
    isEditSuccess,
    buildRestoreTarget,
    countOutOfPlace,
    validateBackup
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.__wlShuffle = root.__wlShuffle || {};
    root.__wlShuffle.core = api;
  }
})(globalThis);
