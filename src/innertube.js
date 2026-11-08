// YouTube access: page config, auth header, and request wrappers.
(function (root) {
  const ns = root.__wlShuffle;
  const { core } = ns;
  const IT = core.INNERTUBE;

  const CONFIG_KEY = 'wls:config';

  const DEFAULT_CONFIG = {
    delayMs: 150,
    batchSize: 1,
    maxRetries: 3,
    transport: 'fetch',
    authParts: ['SAPISIDHASH', 'SAPISID1PHASH', 'SAPISID3PHASH'],
    sendClientHeaders: false,
    backupsToKeep: 3,
    debug: false
  };

  function loadConfig() {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONFIG_KEY)) };
    } catch (err) {
      console.warn(`[wls] Ignoring invalid ${CONFIG_KEY}.`, err);
      return { ...DEFAULT_CONFIG };
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
    constructor() {
      super('YouTube did not confirm the move.');
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

  function sleep(ms, signal) {
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
    if (parts.length === 0) throw new Error('No SAPISID cookie found. Are you signed in?');
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

  async function innertubePost(path, body) {
    const request = {
      method: 'POST',
      credentials: 'same-origin',
      headers: await buildHeaders(),
      body: JSON.stringify({ context: cfg(IT.contextKey), ...body })
    };
    try {
      const res = await fetch(`${IT.apiBase}${path}?prettyPrint=false`, request);
      if (!res.ok) throw new HttpError(res.status, await res.text());
      return await res.json();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new NetworkError(err.message);
    }
  }

  // Retries network errors, 5xx and 429 with backoff, and 401/403 once (each
  // attempt rebuilds the auth header). Anything else is the caller's to handle.
  // `guard` runs before every attempt and may throw to stop the run.
  async function withRetries(send, { guard = () => {}, signal } = {}) {
    let failures = 0;
    let authRetried = false;
    while (true) {
      guard();
      try {
        return await send();
      } catch (err) {
        if (isAuthFailure(err) && !authRetried) {
          authRetried = true;
          continue;
        }
        if (!isTransient(err) || failures >= CONFIG.maxRetries) throw err;
        await sleep(1000 * 2 ** failures, signal);
        failures += 1;
      }
    }
  }

  async function readPlaylist(playlistId, options = {}) {
    const items = new Map();
    const seenTokens = new Set();
    let body = { browseId: IT.browseIdPrefix + playlistId };
    let displayedCount = null;
    let unmovable = 0;
    while (true) {
      const json = await withRetries(() => innertubePost(IT.browsePath, body), options);
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
      if (stalled || page.continuation === null || seenTokens.has(page.continuation)) break;
      seenTokens.add(page.continuation);
      body = { continuation: page.continuation };
      await sleep(CONFIG.delayMs, options.signal);
    }
    if (items.size === 0 && unmovable > 0) {
      throw new Error(`Found ${unmovable} videos, but YouTube did not include the setVideoId `
        + 'needed to move them. That is expected on a playlist you cannot edit. On your own '
        + 'playlist it means the response format changed: see the README.');
    }
    return { items: [...items.values()], displayedCount };
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

  async function editPlaylist(playlistId, actions) {
    if (CONFIG.transport === 'ytAction') {
      sendViaYtAction(playlistId, actions);
      return;
    }
    const json = await innertubePost(IT.editPlaylistPath, { playlistId, actions });
    if (!core.isEditSuccess(json)) throw new EditRejectedError();
  }

  ns.innertube = {
    CONFIG,
    CONFIG_KEY,
    isTransient,
    isAuthFailure,
    isRejection,
    sleep,
    readSession,
    withRetries,
    readPlaylist,
    editPlaylist
  };
})(globalThis);
