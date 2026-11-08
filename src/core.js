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
    watchLaterId: 'WL',

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
    // Sent with no successor only, which moves a video to the bottom, as
    // YouTube Music's client does. The web client never sends it.
    moveBeforeAction: 'ACTION_MOVE_VIDEO_BEFORE',
    removeAction: 'ACTION_REMOVE_VIDEO',
    removeByVideoIdAction: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID',
    removedVideoField: 'removedVideoId',
    addAction: 'ACTION_ADD_VIDEO',
    addedVideoField: 'addedVideoId',
    addedResult: 'playlistEditVideoAddedResultData',
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

  // Shuffles, restores and the move buttons only ever move videos, and a move
  // cannot remove one. This refuses anything else before it is sent, so none
  // of them can delete a video. When `known` is given, every id an action
  // mentions must be in it. A move to the bottom names no other video.
  function assertMoveOnly(actions, known = null) {
    const fields = new Set(['action', 'setVideoId', INNERTUBE.predecessorField]);
    const isKnown = (id) => typeof id === 'string' && (known === null || known.has(id));
    const safe = Array.isArray(actions) && actions.length > 0 && actions.every((action) => {
      if (action?.action === INNERTUBE.moveBeforeAction) {
        return Object.keys(action).length === 2 && isKnown(action.setVideoId);
      }
      const after = action?.[INNERTUBE.predecessorField];
      return action?.action === INNERTUBE.moveAfterAction
        && Object.keys(action).every((key) => fields.has(key))
        && isKnown(action.setVideoId)
        && (after === undefined || (isKnown(after) && after !== action.setVideoId));
    });
    if (!safe) throw new Error('Refused to send a playlist edit that is not a plain move.');
  }

  // The Remove button's request: exactly one entry, picked by its setVideoId,
  // which belongs to that one entry alone, so it cannot take any other video.
  function assertSingleRemove(actions) {
    const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
    const safe = action?.action === INNERTUBE.removeAction
      && Object.keys(action).length === 2
      && typeof action.setVideoId === 'string'
      && action.setVideoId !== '';
    if (!safe) throw new Error('Refused to send a removal that is not exactly one video.');
  }

  // The thumbnail button's removal: one video out of Watch later, by its
  // video id, the way YouTube's own "Remove from Watch later" does it. Watch
  // later holds each video once, so this can only take that one video, and
  // it is refused for any other playlist, where a video can appear twice.
  function assertWatchLaterRemove(playlistId, actions) {
    const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
    const safe = playlistId === INNERTUBE.watchLaterId
      && action?.action === INNERTUBE.removeByVideoIdAction
      && Object.keys(action).length === 2
      && typeof action[INNERTUBE.removedVideoField] === 'string'
      && action[INNERTUBE.removedVideoField] !== '';
    if (!safe) throw new Error('Refused to send a removal that is not exactly one video from Watch later.');
  }

  // Undo's request: adds exactly one video back.
  function assertSingleAdd(actions) {
    const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
    const safe = action?.action === INNERTUBE.addAction
      && Object.keys(action).length === 2
      && typeof action[INNERTUBE.addedVideoField] === 'string'
      && action[INNERTUBE.addedVideoField] !== '';
    if (!safe) throw new Error('Refused to send an addition that is not exactly one video.');
  }

  // The new entry's setVideoId from an add's response, or null when the
  // response doesn't say.
  function readAddedSetVideoId(json, videoId) {
    let found = null;
    walk(json, (node) => {
      const result = node[INNERTUBE.addedResult];
      if (found !== null || typeof result?.setVideoId !== 'string') return;
      if (result.videoId === undefined || result.videoId === videoId) found = result.setVideoId;
    });
    return found;
  }

  // Backups are newest first. Past the limit the middle ones go, because the
  // oldest is the order from before the first shuffle and is always kept.
  function keepBackups(backups, limit) {
    const max = Math.max(2, limit);
    if (backups.length <= max) return backups;
    return [...backups.slice(0, max - 1), backups[backups.length - 1]];
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

  // The video a link on YouTube plays: /watch?v=ID or /shorts/ID, or null.
  // A link into `skipList` gives null, so that list's own rows are left out.
  function videoIdFromHref(href, skipList = null) {
    let url;
    try {
      url = new URL(href, INNERTUBE.origin);
    } catch (err) {
      return null;
    }
    if (url.origin !== INNERTUBE.origin) return null;
    if (url.pathname === '/watch') {
      if (skipList !== null && url.searchParams.get('list') === skipList) return null;
      return url.searchParams.get('v') || null;
    }
    return url.pathname.match(/^\/shorts\/([\w-]+)/)?.[1] ?? null;
  }

  function countOutOfPlace(current, target) {
    return target.filter((id, i) => current[i] !== id).length;
  }

  function validateBackup(backup) {
    const valid = backup?.version === 1
      && typeof backup.playlistId === 'string'
      && Array.isArray(backup.items)
      && backup.items.every((item) => typeof item?.setVideoId === 'string');
    if (!valid) throw new Error('Not a valid Watch Later Tools backup.');
  }

  const api = {
    INNERTUBE,
    randomInt,
    shuffle,
    applyMove,
    planMoves,
    assertMoveOnly,
    assertSingleRemove,
    assertWatchLaterRemove,
    assertSingleAdd,
    readAddedSetVideoId,
    keepBackups,
    toAction,
    parsePlaylistPage,
    parseDisplayedCount,
    isEditSuccess,
    buildRestoreTarget,
    videoIdFromHref,
    countOutOfPlace,
    validateBackup
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.__wlTools = root.__wlTools || {};
    root.__wlTools.core = api;
  }
})(globalThis);
