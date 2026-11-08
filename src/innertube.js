// YouTube access: page config, auth header, and request wrappers.
(function (root) {
  const ns = root.__wlTools;
  const { core } = ns;
  const IT = core.INNERTUBE;

  // Keeps the original "wls" prefix so settings survive the rename.
  const CONFIG_KEY = 'wls:config';

  const DEFAULT_CONFIG = {
    delayMs: 0,
    batchSize: 50,
    maxRetries: 3,
    requestTimeoutMs: 30000,
    transport: 'fetch',
    authParts: ['SAPISIDHASH', 'SAPISID1PHASH', 'SAPISID3PHASH'],
    sendClientHeaders: false,
    backupsToKeep: 3,
    debug: false
  };

  // Allowed range for each number. backupsToKeep is at least 2 so the
  // original order is never rotated out.
  const NUMBER_LIMITS = {
    delayMs: [0, 60000],
    batchSize: [1, 500],
    maxRetries: [0, 10],
    requestTimeoutMs: [1000, 300000],
    backupsToKeep: [2, 20]
  };

  // Settings come from localStorage, which anyone can edit, so every value is
  // checked and a bad one falls back to its default.
  function sanitizeConfig(raw) {
    const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
    for (const [key, [min, max]] of Object.entries(NUMBER_LIMITS)) {
      const value = Number(config[key]);
      config[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : DEFAULT_CONFIG[key];
    }
    if (!['fetch', 'ytAction'].includes(config.transport)) config.transport = DEFAULT_CONFIG.transport;
    if (!Array.isArray(config.authParts)) config.authParts = DEFAULT_CONFIG.authParts;
    config.sendClientHeaders = config.sendClientHeaders === true;
    config.debug = config.debug === true;
    return config;
  }

  function loadConfig() {
    let text = null;
    try {
      text = localStorage.getItem(CONFIG_KEY);
    } catch (err) {
      // Storage is blocked: run with the defaults.
    }
    try {
      return sanitizeConfig(JSON.parse(text));
    } catch (err) {
      console.warn(`[wlt] Ignoring invalid ${CONFIG_KEY}.`, err);
      return sanitizeConfig(null);
    }
  }

  const CONFIG = loadConfig();

  class HttpError extends Error {
    constructor(status, body) {
      super(`HTTP ${status}`);
      this.name = 'HttpError';
      this.status = status;
      this.body = body;
    }
  }

  class NetworkError extends Error {
    constructor(message) {
      super(`Network error: ${message}`);
      this.name = 'NetworkError';
    }
  }

  class EditRejectedError extends Error {
    constructor(message = 'YouTube did not confirm the move.') {
      super(message);
      this.name = 'EditRejectedError';
    }
  }

  function isTransient(err) {
    if (err instanceof NetworkError) return true;
    return err instanceof HttpError && (err.status >= 500 || err.status === 429);
  }

  function isAuthFailure(err) {
    return err instanceof HttpError && (err.status === 401 || err.status === 403);
  }

  function isRejection(err) {
    return err instanceof EditRejectedError || (err instanceof HttpError && err.status === 400);
  }

  // No delay means no timer at all: Chrome throttles timers in background tabs.
  function sleep(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish);
    });
  }

  // The fallback transport gets no answer to wait for, so its requests are
  // spaced out instead.
  function requestGap() {
    return CONFIG.transport === 'ytAction' ? Math.max(CONFIG.delayMs, 1000) : CONFIG.delayMs;
  }

  function cfg(key) {
    const { ytcfg } = root;
    if (!ytcfg) throw new Error('ytcfg is not available. Is this a youtube.com page?');
    return ytcfg.get?.(key) ?? ytcfg.data_?.[key];
  }

  function readSession() {
    return {
      index: String(cfg(IT.sessionIndexKey) ?? '0'),
      pageId: cfg(IT.delegatedSessionKey) ?? null
    };
  }

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
    const ts = Math.floor(Date.now() / 1000);
    // YouTube's client also signs USER_SESSION_ID when the page has one, and
    // marks those hashes with a _u suffix.
    const userSession = cfg(IT.userSessionKey);
    const signedPrefix = userSession ? `${userSession} ` : '';
    const suffix = userSession ? '_u' : '';
    const sources = [
      ['SAPISIDHASH', readCookie(IT.sapisidCookie) ?? readCookie(IT.sapisid3pCookie)],
      ['SAPISID1PHASH', readCookie(IT.sapisid1pCookie)],
      ['SAPISID3PHASH', readCookie(IT.sapisid3pCookie)]
    ];
    const parts = [];
    for (const [label, value] of sources) {
      if (!value) continue;
      if (!CONFIG.authParts.includes(label)) continue;
      const hash = await sha1Hex(`${signedPrefix}${ts} ${value} ${IT.origin}`);
      parts.push(`${label} ${ts}_${hash}${suffix}`);
    }
    if (parts.length === 0) throw new Error('You need to be signed in to YouTube to do this.');
    return parts.join(' ');
  }

  async function buildHeaders() {
    const session = readSession();
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': await buildAuthHeader(),
      'X-Goog-AuthUser': session.index,
      'X-Origin': IT.origin
    };
    if (session.pageId) headers['X-Goog-PageId'] = session.pageId;
    if (CONFIG.sendClientHeaders) {
      headers['X-YouTube-Client-Name'] = String(cfg(IT.clientNameKey));
      headers['X-YouTube-Client-Version'] = String(cfg(IT.clientVersionKey));
    }
    return headers;
  }

  // Every request gives up after requestTimeoutMs, and also ends as soon as
  // `signal` aborts, so Stop never waits on a request that hangs.
  function requestSignal(signal) {
    const timeout = AbortSignal.timeout?.(CONFIG.requestTimeoutMs);
    if (!signal || !timeout) return signal ?? timeout;
    return AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async function innertubePost(path, body, signal) {
    const request = {
      method: 'POST',
      credentials: 'same-origin',
      headers: await buildHeaders(),
      body: JSON.stringify({ context: cfg(IT.contextKey), ...body }),
      signal: requestSignal(signal)
    };
    try {
      const res = await fetch(`${IT.apiBase}${path}?prettyPrint=false`, request);
      if (!res.ok) throw new HttpError(res.status, await res.text());
      return await res.json();
    } catch (err) {
      if (err instanceof HttpError || signal?.aborted) throw err;
      const timedOut = err?.name === 'TimeoutError';
      throw new NetworkError(timedOut ? `no answer within ${CONFIG.requestTimeoutMs / 1000} s` : err.message);
    }
  }

  // Retries network errors, 5xx and 429 with backoff, and 401/403 once (each
  // attempt rebuilds the auth header). Anything else is the caller's to handle.
  // `guard` runs before every attempt and may throw to stop the run. Pass
  // `retryTransient: false` for a request that must not be sent twice.
  async function withRetries(send, { guard = () => {}, signal, retryTransient = true } = {}) {
    let failures = 0;
    let authRetried = false;
    while (true) {
      guard();
      try {
        return await send();
      } catch (err) {
        if (signal?.aborted) {
          guard();
          throw err;
        }
        if (isAuthFailure(err) && !authRetried) {
          authRetried = true;
          continue;
        }
        if (!retryTransient || !isTransient(err) || failures >= CONFIG.maxRetries) throw err;
        await sleep(1000 * 2 ** failures, signal);
        failures += 1;
      }
    }
  }

  // Reads page after page; each page's token comes from the one before, so
  // pages cannot be fetched in parallel. With `maxItems` it stops once it has
  // that many, and `complete` says whether it reached the end.
  async function readPlaylist(playlistId, options = {}) {
    const items = new Map();
    const seenTokens = new Set();
    const limit = options.maxItems ?? Infinity;
    let body = { browseId: IT.browseIdPrefix + playlistId };
    let displayedCount = null;
    let unmovable = 0;
    let complete = false;
    while (true) {
      const json = await withRetries(() => innertubePost(IT.browsePath, body, options.signal), options);
      const page = core.parsePlaylistPage(json);
      const isFirstPage = seenTokens.size === 0;
      const sizeBefore = items.size;
      if (isFirstPage) displayedCount = core.parseDisplayedCount(json);
      unmovable += page.unmovable;
      for (const item of page.items) {
        if (!items.has(item.setVideoId)) items.set(item.setVideoId, item);
      }
      // A page with nothing new means the token led away from the playlist.
      const stalled = !isFirstPage && items.size === sizeBefore;
      complete = stalled || page.continuation === null || seenTokens.has(page.continuation);
      if (complete || items.size >= limit) break;
      seenTokens.add(page.continuation);
      body = { continuation: page.continuation };
      await sleep(CONFIG.delayMs, options.signal);
    }
    if (items.size === 0 && unmovable > 0) {
      throw new Error(`Found ${unmovable} videos, but YouTube did not include the setVideoId `
        + 'needed to move them. That is expected on a playlist you cannot edit. On your own '
        + 'playlist it means the response format changed: see the README.');
    }
    return { items: [...items.values()], displayedCount, complete };
  }

  function sendViaYtAction(playlistId, actions) {
    const app = document.querySelector(IT.appElement);
    if (!app) throw new Error(`${IT.appElement} not found`);
    const command = {
      commandMetadata: {
        webCommandMetadata: { sendPost: true, apiUrl: `${IT.apiBase}${IT.editPlaylistPath}` }
      },
      [IT.editEndpoint]: { playlistId, actions }
    };
    app.dispatchEvent(new CustomEvent(IT.actionEvent, {
      detail: {
        actionName: IT.serviceRequestAction,
        returnValue: [],
        args: [{ data: {} }, command],
        optionalAction: false
      }
    }));
  }

  // How shuffles and restores change a playlist. Both transports go through
  // the move-only check first, so neither can ever remove a video.
  async function editPlaylist(playlistId, actions, { signal, known = null } = {}) {
    core.assertMoveOnly(actions, known);
    if (CONFIG.transport === 'ytAction') {
      sendViaYtAction(playlistId, actions);
      return;
    }
    const json = await innertubePost(IT.editPlaylistPath, { playlistId, actions }, signal);
    if (!core.isEditSuccess(json)) throw new EditRejectedError();
  }

  // The only removal the extension sends, for the Remove button: one entry,
  // by its setVideoId. Retrying is safe, because a second try can only find
  // that same entry gone. Always uses fetch, since the answer matters.
  async function removeFromPlaylist(playlistId, setVideoId, { signal } = {}) {
    const actions = [{ action: IT.removeAction, setVideoId }];
    core.assertSingleRemove(actions);
    const json = await withRetries(
      () => innertubePost(IT.editPlaylistPath, { playlistId, actions }, signal),
      { signal }
    );
    if (!core.isEditSuccess(json)) throw new EditRejectedError('YouTube did not confirm the removal.');
  }

  // Undo's request. Sent once: if an answer is lost, a retry could add the
  // video twice. Returns the new entry's setVideoId, or null if not given.
  async function addToPlaylist(playlistId, videoId, { signal } = {}) {
    const actions = [{ action: IT.addAction, [IT.addedVideoField]: videoId }];
    core.assertSingleAdd(actions);
    const json = await withRetries(
      () => innertubePost(IT.editPlaylistPath, { playlistId, actions }, signal),
      { signal, retryTransient: false }
    );
    if (!core.isEditSuccess(json)) throw new EditRejectedError('YouTube did not confirm adding the video back.');
    return core.readAddedSetVideoId(json, videoId);
  }

  ns.innertube = {
    CONFIG,
    CONFIG_KEY,
    isTransient,
    isAuthFailure,
    isRejection,
    sleep,
    requestGap,
    readSession,
    withRetries,
    readPlaylist,
    editPlaylist,
    removeFromPlaylist,
    addToPlaylist
  };
})(globalThis);
