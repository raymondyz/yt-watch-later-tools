// Runs the real innertube.js and main.js against a simulated YouTube backend.
// This proves the run logic, not the InnerTube request shapes: those can only
// be confirmed against the live site (see the README).
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const core = require('../src/core.js');

const SRC = path.join(__dirname, '..', 'src');
const PAGE_SIZE = 3;
// Returned from onEdit or onRead: the request never answers until aborted.
const HANG = Symbol('hang');

function hang(signal) {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
  });
}

// Stands in for navigator.locks. Share one between two load() calls to
// simulate two tabs; give each its own to simulate a tab that was closed.
function createLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    }
  };
}

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function toPage(server, offset) {
  const contents = server.order.slice(offset, offset + PAGE_SIZE).map((setVideoId) => ({
    playlistVideoRenderer: {
      videoId: `v-${setVideoId}`,
      setVideoId,
      title: { runs: [{ text: `Title ${setVideoId}` }] }
    }
  }));
  const page = { contents };
  if (offset === 0 && server.displayed) {
    page.header = { playlistHeaderRenderer: { numVideosText: { simpleText: `${server.displayed} videos` } } };
  }
  if (offset + PAGE_SIZE < server.order.length) {
    const token = `offset:${offset + PAGE_SIZE}`;
    contents.push({
      continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } }
    });
  }
  return page;
}

function createServer(order) {
  const server = {
    order: order.slice(),
    edits: 0,
    reads: 0,
    headers: [],
    // Return a response to override the edit, or nothing to apply it normally.
    onEdit: () => {},
    onRead: () => {},
    apply(actions) {
      for (const action of actions) {
        const after = action.movedSetVideoIdPredecessor ?? null;
        server.order = core.applyMove(server.order, { setVideoId: action.setVideoId, after });
      }
    },
    async fetch(url, init) {
      server.headers.push(init.headers);
      const body = JSON.parse(init.body);
      if (url.includes('browse/edit_playlist')) {
        server.edits += 1;
        const override = await server.onEdit(server.edits, body);
        if (override === HANG) return hang(init.signal);
        if (override) return override;
        server.apply(body.actions);
        return json({ status: 'STATUS_SUCCEEDED' });
      }
      server.reads += 1;
      const override = await server.onRead(server.reads, body);
      if (override === HANG) return hang(init.signal);
      if (override) return override;
      const offset = body.continuation ? Number(body.continuation.split(':')[1]) : 0;
      return json(toPage(server, offset));
    }
  };
  return server;
}

function load(server, options = {}) {
  // Most tests check per-move behavior, so they send one move per request.
  // Pass `config: {}` to run with the real defaults.
  const {
    confirmAnswer = true,
    config = { batchSize: 1 },
    storageFull = false,
    storageSilent = false,
    storageLimit = Infinity,
    href,
    uiConfirm,
    locks = null,
    storage = new Map()
  } = options;
  if (Object.keys(config).length > 0) storage.set('wls:config', JSON.stringify(config));
  const views = [];
  const events = [];
  const warnings = [];
  const errors = [];
  let timers = 0;
  const unloadListeners = new Set();
  const documentListeners = new Map();
  const ytcfgData = { INNERTUBE_CONTEXT: { client: {} }, SESSION_INDEX: 0 };
  const url = new URL(href ?? 'https://www.youtube.com/');
  const sandbox = {
    console: { log() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
    crypto,
    TextEncoder,
    URLSearchParams,
    AbortController,
    AbortSignal,
    DOMException,
    clearTimeout,
    setTimeout: (fn) => {
      timers += 1;
      return setTimeout(fn, 0);
    },
    setInterval: () => 0,
    fetch: server.fetch,
    navigator: locks ? { locks } : {},
    confirm: () => confirmAnswer,
    location: url,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem(key, value) {
        const isBackup = key.startsWith('wls:backup:');
        if (isBackup && (storageFull || value.length > storageLimit)) throw new Error('quota');
        if (isBackup && storageSilent) return;
        storage.set(key, value);
      },
      removeItem: (key) => storage.delete(key)
    },
    document: {
      cookie: 'SAPISID=abc; __Secure-1PAPISID=def; __Secure-3PAPISID=ghi',
      title: 'My Mix - YouTube',
      addEventListener(type, listener) {
        documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
      },
      querySelector: () => ({ dispatchEvent: (event) => events.push(event) })
    },
    addEventListener(type, listener) {
      if (type === 'beforeunload') unloadListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'beforeunload') unloadListeners.delete(listener);
    },
    ytcfg: { get: (key) => ytcfgData[key], data_: ytcfgData }
  };
  const context = vm.createContext(sandbox);
  for (const file of ['core.js', 'innertube.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context);
  }
  // Stands in for ui.js and records everything main.js asks it to show.
  sandbox.__wlShuffle.ui = {
    mount(handlers) {
      sandbox.__wlShuffle.ui.handlers = handlers;
    },
    render: (state) => views.push(state)
  };
  if (uiConfirm) sandbox.__wlShuffle.ui.confirm = uiConfirm;
  vm.runInContext(fs.readFileSync(path.join(SRC, 'main.js'), 'utf8'), context);
  return {
    api: sandbox.__wlShuffle,
    views,
    events,
    warnings,
    errors,
    timers: () => timers,
    storage,
    unloadListeners,
    ytcfgData,
    lastView: () => views.at(-1),
    handlers: () => sandbox.__wlShuffle.ui.handlers,
    // Stands in for a YouTube navigation inside the single-page app.
    navigate(nextHref, title = 'My Mix - YouTube') {
      url.href = nextHref;
      sandbox.document.title = title;
      for (const listener of documentListeners.get('yt-navigate-finish') ?? []) listener();
    },
    backups: (id = 'WL') => JSON.parse(storage.get(`wls:backup:${id}`) ?? '[]')
  };
}

function ids(count) {
  return Array.from({ length: count }, (_, i) => `s${i}`);
}

function sorted(list) {
  return list.slice().sort();
}

// Arrays from the vm context have a different prototype, which strict
// deepEqual rejects, so copy them into this realm before comparing.
function setVideoIds(items) {
  return Array.from(items, (item) => item.setVideoId);
}

function targetIds(result) {
  return setVideoIds(result.target);
}

async function waitFor(condition) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('run', () => {
  it('shuffles the stored order to the target and keeps every video', async () => {
    const server = createServer(ids(20));
    const { api, lastView } = load(server);
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
    assert.deepEqual(sorted(server.order), sorted(ids(20)));
    assert.equal(lastView().phase, 'done');
    assert.match(lastView().status, /^Shuffled 20 videos\. Done\. Reload/);
  });

  it('reads every page', async () => {
    const server = createServer(ids(10));
    const { api } = load(server);
    assert.deepEqual(setVideoIds(await api.fetchPlaylist()), ids(10));
  });

  it('saves a backup of the original order before the first move', async () => {
    const server = createServer(ids(12));
    const { api, backups } = load(server);
    let backedUpFirst = false;
    server.onEdit = (count) => {
      if (count === 1) backedUpFirst = backups().length === 1;
    };
    await api.run();
    assert.equal(backedUpFirst, true);
    const [backup] = backups();
    assert.equal(backup.version, 1);
    assert.equal(backup.playlistId, 'WL');
    assert.deepEqual(backup.items.map((item) => item.setVideoId), ids(12));
    assert.deepEqual(backup.items[0], { setVideoId: 's0', videoId: 'v-s0', title: 'Title s0' });
  });

  it('keeps the newest backups and always the original order', async () => {
    const server = createServer(ids(6));
    const { api, backups } = load(server);
    const before = [];
    for (let i = 0; i < 5; i++) {
      before.push(server.order.slice());
      await api.run();
    }
    const kept = backups().map((backup) => backup.items.map((item) => item.setVideoId));
    assert.deepEqual(kept, [before[4], before[3], ids(6)]);
  });

  it('refuses to shuffle when the backup cannot be saved', async () => {
    const server = createServer(ids(6));
    const { api, lastView } = load(server, { storageFull: true });
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.equal(server.edits, 0);
    assert.match(lastView().status, /Could not save a backup, so nothing was changed/);
  });

  it('stops when there is nothing to shuffle', async () => {
    const server = createServer(ids(1));
    const { api, backups, lastView } = load(server);
    assert.equal((await api.run()).status, 'nothing');
    assert.equal(lastView().status, 'Nothing to shuffle');
    assert.equal(backups().length, 0);
    assert.equal(server.edits, 0);
  });

  it('changes nothing when the user declines', async () => {
    const server = createServer(ids(6));
    const { api, backups } = load(server, { confirmAnswer: false });
    assert.equal((await api.run()).status, 'declined');
    assert.equal(server.edits, 0);
    assert.equal(backups().length, 0);
  });

  it('allows one run at a time and warns before unload only while running', async () => {
    const server = createServer(ids(12));
    const { api, unloadListeners, errors } = load(server);
    let warnedWhileMoving = false;
    server.onEdit = () => {
      warnedWhileMoving = unloadListeners.size === 1;
    };
    const first = api.run();
    await assert.rejects(api.run(), /already running in this tab/);
    // Nothing has changed while the playlist is only being read.
    assert.equal(unloadListeners.size, 0);
    await first;
    assert.equal(warnedWhileMoving, true);
    assert.equal(unloadListeners.size, 0);
    assert.deepEqual(errors, []);
  });

  it('works on a playlist other than Watch Later', async () => {
    const server = createServer(ids(6));
    const { api, backups } = load(server);
    const browseIds = [];
    server.onRead = (_, body) => {
      if (body.browseId) browseIds.push(body.browseId);
    };
    server.onEdit = (_, body) => assert.equal(body.playlistId, 'PLtest');
    assert.equal((await api.run({ playlistId: 'PLtest' })).status, 'done');
    assert.equal(browseIds[0], 'VLPLtest');
    assert.equal(backups('PLtest').length, 1);
  });

  it('survives a video being added and one removed mid-run', async () => {
    const server = createServer(ids(12));
    const { api } = load(server);
    server.onEdit = (count) => {
      if (count !== 3) return;
      const gone = server.order.at(-1);
      server.order = ['added', ...server.order.filter((id) => id !== gone)];
      return json({}, 400);
    };
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
    assert.ok(server.order.includes('added'));
    assert.equal(server.order.length, 12);
  });
});

describe('requests', () => {
  it('sends a signed request for the active session', async () => {
    const server = createServer(ids(4));
    const { api, ytcfgData } = load(server);
    ytcfgData.SESSION_INDEX = 2;
    ytcfgData.DELEGATED_SESSION_ID = 'page-1';
    await api.fetchPlaylist();
    const [headers] = server.headers;
    assert.match(
      headers.Authorization,
      /^SAPISIDHASH \d+_[0-9a-f]{40} SAPISID1PHASH \d+_[0-9a-f]{40} SAPISID3PHASH \d+_[0-9a-f]{40}$/
    );
    assert.equal(headers['X-Goog-AuthUser'], '2');
    assert.equal(headers['X-Goog-PageId'], 'page-1');
    assert.equal(headers['X-Origin'], 'https://www.youtube.com');
  });

  it('signs USER_SESSION_ID the way YouTube does when the page has one', async () => {
    const server = createServer(ids(4));
    const { api, ytcfgData } = load(server);
    ytcfgData.USER_SESSION_ID = 'user-1';
    await api.fetchPlaylist();
    const parts = server.headers[0].Authorization.split(' ');
    assert.deepEqual(parts.filter((_, i) => i % 2 === 0), ['SAPISIDHASH', 'SAPISID1PHASH', 'SAPISID3PHASH']);
    const cookies = ['abc', 'def', 'ghi'];
    parts.filter((_, i) => i % 2 === 1).forEach((part, i) => {
      const [ts, hash, marker] = part.split('_');
      const signed = `user-1 ${ts} ${cookies[i]} https://www.youtube.com`;
      assert.equal(hash, createHash('sha1').update(signed).digest('hex'));
      assert.equal(marker, 'u');
    });
  });

  it('respects authParts and client header config', async () => {
    const server = createServer(ids(4));
    const config = { authParts: ['SAPISIDHASH'], sendClientHeaders: true };
    const { api, ytcfgData } = load(server, { config });
    ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME = 1;
    ytcfgData.INNERTUBE_CLIENT_VERSION = '2.0';
    await api.fetchPlaylist();
    const [headers] = server.headers;
    assert.match(headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
    assert.equal(headers['X-YouTube-Client-Name'], '1');
    assert.equal(headers['X-YouTube-Client-Version'], '2.0');
  });

  it('applies batched moves in order', async () => {
    const server = createServer(ids(20));
    const { api } = load(server, { config: { batchSize: 4 } });
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
    assert.ok(server.edits <= 5);
  });
});

describe('reading', () => {
  const lockups = (count) => ({
    contents: Array.from({ length: count }, (_, i) => ({
      lockupViewModel: { contentId: `v${i}`, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' }
    }))
  });

  function sectionToken(token) {
    return {
      continuationItemViewModel: {
        continuationCommand: { innertubeCommand: { continuationCommand: { token } } }
      }
    };
  }

  it('fails clearly when videos cannot be moved, without touching anything', async () => {
    const server = createServer(ids(4));
    const { api, lastView, backups } = load(server);
    server.onRead = () => json(lockups(5));
    await assert.rejects(api.fetchPlaylist(), /Found 5 videos.*setVideoId/);
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.match(lastView().status, /did not include the setVideoId/);
    assert.equal(server.edits, 0);
    assert.equal(backups().length, 0);
  });

  it('stops following a token that leads away from the playlist', async () => {
    const server = createServer(ids(4));
    const { api } = load(server);
    server.onRead = (count) => {
      if (count === 1) return json({ list: toPage({ order: ids(2) }, 0), section: sectionToken('feed:1') });
      return json({ recommendations: lockups(3), more: sectionToken(`feed:${count}`) });
    };
    assert.deepEqual(setVideoIds(await api.fetchPlaylist()), ['s0', 's1']);
    assert.equal(server.reads, 2);
  });
});

describe('batching', () => {
  it('sends 50 moves per request by default', async () => {
    const server = createServer(ids(120));
    const { api } = load(server, { config: {} });
    const sizes = [];
    server.onEdit = (_, body) => {
      sizes.push(body.actions.length);
    };
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
    assert.equal(sizes[0], 50);
    assert.ok(sizes.length <= 3, `sent ${sizes.length} requests`);
  });

  it('halves the batch when YouTube rejects one, then finishes', async () => {
    const server = createServer(ids(60));
    const { api } = load(server, { config: {} });
    const sizes = [];
    server.onEdit = (_, body) => {
      sizes.push(body.actions.length);
      return body.actions.length > 10 ? json({}, 400) : undefined;
    };
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
    assert.deepEqual(sizes.slice(0, 4), [50, 25, 12, 6]);
    assert.ok(sizes.slice(3).every((size) => size <= 6));
  });

  it('stops only when a single move keeps being rejected', async () => {
    const server = createServer(ids(60));
    const { api, lastView } = load(server, { config: {} });
    const sizes = [];
    server.onEdit = (_, body) => {
      sizes.push(body.actions.length);
      return json({}, 400);
    };
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.deepEqual(sizes, [50, 25, 12, 6, 3, 1, 1]);
    assert.match(lastView().status, /refused to reorder this playlist/);
    assert.deepEqual(sorted(server.order), sorted(ids(60)));
  });

  it('starts no timer when the delay is 0', async () => {
    const { api, timers } = load(createServer(ids(3)), { config: {} });
    const before = timers();
    await api.innertube.sleep(0);
    assert.equal(timers(), before);
  });
});

describe('hidden videos', () => {
  it('explains them in the question instead of logging a warning', async () => {
    const server = createServer(ids(8));
    server.displayed = 10;
    let asked = null;
    const { api, warnings } = load(server, {
      uiConfirm: async (request) => {
        asked = request;
        return false;
      }
    });
    await api.run();
    assert.equal(asked.warning, '2 of the 10 videos are hidden or unavailable, so YouTube does not list them. They will not be moved.');
    assert.deepEqual(warnings, []);
  });

  it('stays quiet when the counts match', async () => {
    const server = createServer(ids(8));
    server.displayed = 8;
    let asked = null;
    const { api } = load(server, {
      uiConfirm: async (request) => {
        asked = request;
        return false;
      }
    });
    await api.run();
    assert.equal(asked.warning, '');
  });
});

describe('error handling', () => {
  it('retries a transient failure without pausing', async () => {
    const server = createServer(ids(8));
    const { api, views } = load(server);
    server.onEdit = (count) => (count <= 2 ? json({}, 503) : undefined);
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
    assert.equal(views.some((view) => view.phase === 'paused'), false);
  });

  it('retries network errors', async () => {
    const server = createServer(ids(8));
    const { api } = load(server);
    server.onEdit = (count) => {
      if (count === 1) throw new TypeError('Failed to fetch');
    };
    assert.equal((await api.run()).status, 'done');
  });

  it('pauses after maxRetries, then re-reads and finishes on resume', async () => {
    const server = createServer(ids(10));
    const { api, lastView } = load(server);
    let failing = true;
    server.onEdit = (count) => (count > 3 && failing ? json({}, 429) : undefined);
    const pending = api.run();
    await waitFor(() => lastView().phase === 'paused');
    assert.match(lastView().status, /^Paused at 3 \/ \d+\./);
    assert.equal(lastView().visible, true);
    const readsBefore = server.reads;
    failing = false;
    api.resume();
    const result = await pending;
    assert.equal(result.status, 'done');
    assert.ok(server.reads > readsBefore);
    assert.deepEqual(server.order, targetIds(result));
  });

  it('can be cancelled while paused', async () => {
    const server = createServer(ids(10));
    const { api, lastView } = load(server);
    server.onEdit = () => json({}, 500);
    const pending = api.run();
    await waitFor(() => lastView().phase === 'paused');
    api.cancel();
    assert.equal((await pending).status, 'cancelled');
  });

  it('pauses when a read keeps failing', async () => {
    const server = createServer(ids(6));
    const { api, lastView } = load(server);
    let failing = true;
    server.onRead = () => (failing ? json({}, 500) : undefined);
    const pending = api.run();
    await waitFor(() => lastView().phase === 'paused');
    failing = false;
    api.resume();
    assert.equal((await pending).status, 'done');
  });

  it('rebuilds auth and retries once on 401', async () => {
    const server = createServer(ids(8));
    const { api } = load(server);
    server.onEdit = (count) => (count === 2 ? json({}, 401) : undefined);
    assert.equal((await api.run()).status, 'done');
  });

  it('stops and suggests ytAction when auth keeps failing', async () => {
    const server = createServer(ids(8));
    const { api, lastView } = load(server);
    server.onEdit = () => json({}, 403);
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.equal(server.edits, 2);
    assert.match(lastView().status, /ytAction/);
    assert.equal(lastView().statusKind, 'error');
  });

  it('re-reads and re-plans after a 400', async () => {
    const server = createServer(ids(10));
    const { api } = load(server);
    let readsAtRejection = 0;
    let readBeforeNextEdit = false;
    server.onEdit = (count) => {
      if (count === 5) readBeforeNextEdit = server.reads > readsAtRejection;
      if (count !== 4) return undefined;
      readsAtRejection = server.reads;
      return json({}, 400);
    };
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.equal(readBeforeNextEdit, true);
    assert.deepEqual(server.order, targetIds(result));
  });

  it('stops when a 400 repeats on the same move', async () => {
    const server = createServer(ids(10));
    const { api, lastView } = load(server);
    server.onEdit = (count) => (count >= 3 ? json({}, 400) : undefined);
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.equal(server.edits, 4);
    assert.match(lastView().status, /rejected the same move twice/);
    assert.deepEqual(sorted(server.order), sorted(ids(10)));
  });

  it('treats a 200 without the success marker as a rejection', async () => {
    const server = createServer(ids(10));
    const { api } = load(server);
    server.onEdit = () => json({ status: 'STATUS_FAILED' });
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.equal(server.edits, 2);
  });

  it('aborts when the account changes mid-run', async () => {
    const server = createServer(ids(10));
    const { api, ytcfgData, lastView } = load(server);
    server.onEdit = (count) => {
      if (count === 2) ytcfgData.SESSION_INDEX = 1;
    };
    const result = await api.run();
    assert.equal(result.status, 'failed');
    assert.equal(server.edits, 2);
    assert.match(lastView().status, /account changed/);
  });
});

describe('cancel', () => {
  it('stops between requests and loses nothing', async () => {
    const server = createServer(ids(12));
    const { api, lastView } = load(server);
    server.onEdit = (count) => {
      if (count === 4) api.cancel();
    };
    const result = await api.run();
    assert.equal(result.status, 'cancelled');
    assert.equal(server.edits, 4);
    assert.deepEqual(sorted(server.order), sorted(ids(12)));
    assert.match(lastView().status, /^Stopped at 4 \/ \d+/);
  });

  it('can be followed by a restore', async () => {
    const server = createServer(ids(12));
    const { api } = load(server);
    server.onEdit = (count) => {
      if (count === 4) api.cancel();
    };
    await api.run();
    server.onEdit = () => {};
    assert.equal((await api.restore()).status, 'done');
    assert.deepEqual(server.order, ids(12));
  });
});

describe('verify', () => {
  it('repairs a move that was silently dropped', async () => {
    const server = createServer(ids(12));
    const { api } = load(server);
    server.onEdit = (count) => (count === 3 ? json({ status: 'STATUS_SUCCEEDED' }) : undefined);
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
  });

  it('reports items out of place when repair fails, and can retry', async () => {
    const server = createServer(ids(12));
    const { api, lastView } = load(server, { href: 'https://www.youtube.com/playlist?list=WL' });
    let dropping = true;
    server.onEdit = () => (dropping ? json({ status: 'STATUS_SUCCEEDED' }) : undefined);
    const result = await api.run();
    assert.equal(result.status, 'partial');
    assert.ok(result.outOfPlace > 0);
    assert.match(lastView().status, /^Shuffled with \d+ items out of place/);
    assert.equal(lastView().canRetry, true);
    dropping = false;
    const retried = await api.resume();
    assert.equal(retried.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
  });
});

describe('restore', () => {
  it('puts the original order back without adding a backup', async () => {
    const server = createServer(ids(12));
    const { api, backups, lastView } = load(server);
    await api.run();
    assert.notDeepEqual(server.order, ids(12));
    const result = await api.restore();
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, ids(12));
    assert.equal(backups().length, 1);
    assert.match(lastView().status, /^Restored 12 videos/);
  });

  it('puts new videos first and ignores removed ones', async () => {
    const server = createServer(['a', 'b', 'c', 'd']);
    const { api } = load(server);
    await api.run();
    server.order = ['new', ...server.order.filter((id) => id !== 'c')];
    await api.restore();
    assert.deepEqual(server.order, ['new', 'a', 'b', 'd']);
  });

  it('skips the moves when the order already matches', async () => {
    const server = createServer(ids(6));
    const { api } = load(server, { confirmAnswer: true });
    await api.run();
    await api.restore();
    const edits = server.edits;
    await api.restore();
    assert.equal(server.edits, edits);
  });

  it('restores from a backup object', async () => {
    const server = createServer(['c', 'a', 'b']);
    const { api } = load(server);
    const backup = {
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      playlistId: 'PLtest',
      items: [{ setVideoId: 'a' }, { setVideoId: 'b' }, { setVideoId: 'c' }]
    };
    assert.equal((await api.restoreFromBackup(backup)).status, 'done');
    assert.deepEqual(server.order, ['a', 'b', 'c']);
  });

  it('rejects an invalid backup and a missing one', async () => {
    const { api } = load(createServer(ids(3)));
    await assert.rejects(api.restoreFromBackup({ nope: true }), /valid/);
    await assert.rejects(api.restore(), /No saved backup/);
  });
});

describe('ytAction transport', () => {
  it('dispatches edits through ytd-app and still reads with fetch', async () => {
    const server = createServer(ids(6));
    const { api, events } = load(server, { config: { transport: 'ytAction' } });
    // Stand in for YouTube's app receiving the event.
    const seen = [];
    const original = events.push.bind(events);
    events.push = (event) => {
      seen.push(event);
      server.apply(event.detail.args[1].playlistEditEndpoint.actions);
      return original(event);
    };
    const result = await api.run();
    assert.equal(result.status, 'done');
    assert.equal(server.edits, 0);
    assert.ok(seen.length > 0);
    assert.equal(seen[0].type, 'yt-action');
    assert.equal(seen[0].detail.actionName, 'yt-service-request');
    assert.deepEqual(server.order, targetIds(result));
  });
});

describe('page wiring', () => {
  const MIX = 'https://www.youtube.com/playlist?list=PLmix';

  it('shows on any playlist page and while running, and hides elsewhere', async () => {
    const onPlaylist = load(createServer(ids(3)), { href: MIX });
    assert.equal(onPlaylist.lastView().visible, true);
    assert.equal(onPlaylist.lastView().playlistLabel, 'My Mix');

    const server = createServer(ids(6));
    const elsewhere = load(server);
    assert.equal(elsewhere.lastView().visible, false);
    let shownDuringRun = false;
    server.onEdit = () => {
      shownDuringRun = elsewhere.lastView().visible;
    };
    await elsewhere.api.run({ playlistId: 'PLother' });
    assert.equal(shownDuringRun, true);
    assert.equal(elsewhere.lastView().visible, false);
  });

  it('names Watch Later, the open playlist, and other playlists by id', async () => {
    const server = createServer(ids(3));
    const { api, navigate, lastView, views } = load(server, { href: MIX });
    await api.run({ playlistId: 'PLelsewhere' });
    assert.ok(views.some((view) => view.phase === 'reading' && view.playlistLabel === 'PLelsewhere'));
    navigate('https://www.youtube.com/playlist?list=WL', 'Watch later - YouTube');
    assert.equal(lastView().playlistLabel, 'Watch later');
    navigate(MIX, '(3) My Mix - YouTube');
    assert.equal(lastView().playlistLabel, 'My Mix');
  });

  it('shuffles the open playlist from the panel', async () => {
    const server = createServer(ids(12));
    const { handlers, lastView } = load(server, { href: MIX });
    const edited = new Set();
    server.onEdit = (_, body) => {
      edited.add(body.playlistId);
    };
    await handlers().onShuffle();
    assert.equal(lastView().phase, 'done');
    assert.deepEqual([...edited], ['PLmix']);
  });

  it('lists the open playlist\'s backups, newest first', async () => {
    const server = createServer(ids(6));
    const { api, lastView, backups } = load(server, { href: MIX });
    assert.equal(lastView().backups.length, 0);
    await api.run({ playlistId: 'PLmix' });
    server.order.pop();
    await api.run({ playlistId: 'PLmix' });
    const listed = lastView().backups;
    assert.equal(listed.length, 2);
    assert.equal(listed[0].count, 5);
    assert.equal(listed[1].count, 6);
    assert.equal(listed[0].label, new Date(backups('PLmix')[0].createdAt).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'medium'
    }));
  });

  it('restores the chosen backup from the panel after confirming', async () => {
    const server = createServer(ids(8));
    const asked = [];
    const { api, handlers, lastView } = load(server, {
      href: MIX,
      uiConfirm: async (request) => {
        asked.push(request);
        return true;
      }
    });
    await api.run({ playlistId: 'PLmix' });
    await api.run({ playlistId: 'PLmix' });
    const result = await handlers().onRestore(lastView().backups[1].id);
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, ids(8));
    assert.equal(asked.at(-1).confirmLabel, 'Restore order');
    assert.match(asked.at(-1).message, /"My Mix" back in the order saved on/);
  });

  it('does not restore when the confirmation is declined', async () => {
    const server = createServer(ids(8));
    const answers = [true, false];
    const { api, handlers, lastView } = load(server, { href: MIX, uiConfirm: async () => answers.shift() });
    await api.run({ playlistId: 'PLmix' });
    const shuffled = server.order.slice();
    const edits = server.edits;
    assert.equal((await handlers().onRestore(lastView().backups[0].id)).status, 'declined');
    assert.equal(server.edits, edits);
    assert.deepEqual(server.order, shuffled);
  });

  it('asks the panel to confirm and lets Stop dismiss the question', async () => {
    const server = createServer(ids(5));
    let asked = null;
    const { api, backups } = load(server, {
      href: MIX,
      uiConfirm: (request, signal) => new Promise((resolve) => {
        asked = request;
        signal.addEventListener('abort', () => resolve(false));
      })
    });
    const pending = api.run({ playlistId: 'PLmix' });
    await waitFor(() => asked !== null);
    assert.equal(asked.title, 'Shuffle the order of "My Mix"?');
    assert.match(asked.message, /permanently rearranges its 5 videos/);
    assert.match(asked.message, /This is not shuffle play/);
    assert.equal(asked.confirmLabel, 'Shuffle 5 videos');
    api.cancel();
    assert.equal((await pending).status, 'declined');
    assert.equal(server.edits, 0);
    assert.equal(backups('PLmix').length, 0);
  });

  it('clears a finished run\'s message when another playlist opens', async () => {
    const server = createServer(ids(6));
    const { api, navigate, lastView } = load(server, { href: MIX });
    await api.run({ playlistId: 'PLmix' });
    assert.equal(lastView().phase, 'done');
    navigate('https://www.youtube.com/playlist?list=PLnext', 'Next - YouTube');
    assert.equal(lastView().phase, 'idle');
    assert.equal(lastView().status, '');
    assert.equal(lastView().backups.length, 0);
  });

  it('offers retry only on the playlist that needs it', async () => {
    const server = createServer(ids(12));
    const { api, navigate, lastView } = load(server, { href: MIX });
    server.onEdit = () => json({ status: 'STATUS_SUCCEEDED' });
    await api.run({ playlistId: 'PLmix' });
    assert.equal(lastView().canRetry, true);
    navigate('https://www.youtube.com/playlist?list=PLnext', 'Next - YouTube');
    assert.equal(lastView().canRetry, false);
  });
});

const WL_PAGE = 'https://www.youtube.com/playlist?list=WL';
const OTHER_PAGE = 'https://www.youtube.com/playlist?list=PLother';

function seededRand(seed) {
  let state = seed;
  return (maxExclusive) => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state % maxExclusive;
  };
}

describe('safety: no video is ever lost', () => {
  it('refuses any edit that is not a plain move before it reaches YouTube', async () => {
    for (const transport of ['fetch', 'ytAction']) {
      const server = createServer(ids(3));
      const { api, events } = load(server, { config: { transport } });
      const attempts = [
        [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 's1' }],
        [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: 'v-s1' }],
        [{ action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId: 's1', removedVideoId: 'v-s1' }],
        [{ action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId: 's1', movedSetVideoIdPredecessor: 's1' }],
        []
      ];
      for (const actions of attempts) {
        await assert.rejects(api.innertube.editPlaylist('WL', actions), /not a plain move/);
      }
      assert.equal(server.edits, 0);
      assert.equal(events.length, 0);
    }
  });

  it('keeps every video when stopped after any number of moves', async () => {
    for (let stopAt = 1; stopAt <= 12; stopAt++) {
      const server = createServer(ids(12));
      const { api } = load(server);
      server.onEdit = (count) => {
        if (count === stopAt) api.cancel();
      };
      await api.run();
      assert.deepEqual(sorted(server.order), sorted(ids(12)), `stopped at ${stopAt}`);
    }
  });

  it('keeps every video when everything goes wrong at random', async () => {
    // CHAOS_SEEDS=1000 node --test test/ runs a longer search.
    for (let seed = 1; seed <= Number(process.env.CHAOS_SEEDS ?? 30); seed++) {
      const rand = seededRand(seed);
      const server = createServer(ids(40));
      const { api, lastView } = load(server, { config: { batchSize: 1 + rand(20), maxRetries: rand(2) } });
      const added = [];
      server.onEdit = (_, body) => {
        const roll = rand(10);
        if (roll === 0) return json({}, 400);
        if (roll === 1) return json({}, 503);
        if (roll === 2) return json({ status: 'STATUS_FAILED' });
        if (roll === 3) {
          server.apply(body.actions.slice(0, Math.ceil(body.actions.length / 2)));
          return json({}, 500);
        }
        if (roll === 4) throw new TypeError('Failed to fetch');
        if (roll === 5 && added.length < 3) {
          const id = `new-${added.length}`;
          added.push(id);
          server.order.splice(rand(server.order.length), 0, id);
        }
        return undefined;
      };
      const pending = api.run();
      const resumer = setInterval(() => {
        if (lastView().phase === 'paused') api.resume();
      }, 1);
      const result = await pending;
      clearInterval(resumer);
      assert.ok(['done', 'partial', 'failed'].includes(result.status), `seed ${seed}: ${result.status}`);
      assert.deepEqual(sorted(server.order), sorted([...ids(40), ...added]), `seed ${seed}`);
    }
  });
});

describe('safety: several tabs', () => {
  it('lets only one tab change playlists at a time', async () => {
    const locks = createLocks();
    const storage = new Map();
    const server = createServer(ids(10));
    const first = load(server, { locks, storage, href: WL_PAGE });
    const second = load(server, { locks, storage, href: WL_PAGE });
    let secondResult = null;
    server.onEdit = async (count) => {
      if (count === 1) secondResult = await second.api.run();
    };
    assert.equal((await first.api.run()).status, 'done');
    assert.equal(secondResult.status, 'failed');
    assert.match(second.lastView().status, /Another YouTube tab is shuffling/);
    assert.equal(first.backups().length, 1);
    assert.deepEqual(second.errors, []);
    server.onEdit = () => {};
    assert.equal((await second.api.run()).status, 'done');
  });

  it('shows that another tab is busy instead of a false "didn\'t finish" notice', async () => {
    const locks = createLocks();
    const storage = new Map();
    const server = createServer(ids(12));
    const first = load(server, { locks, storage, href: WL_PAGE });
    const second = load(server, { locks, storage, href: WL_PAGE });
    let seen = null;
    server.onEdit = async (count) => {
      if (count !== 1) return;
      second.navigate(WL_PAGE, 'Watch later - YouTube');
      await waitFor(() => second.lastView().busyElsewhere === true);
      seen = second.lastView();
    };
    await first.api.run();
    assert.equal(seen.busyElsewhere, true);
    assert.equal(seen.interrupted, null);
    second.navigate(WL_PAGE, 'Watch later - YouTube');
    await waitFor(() => second.lastView().busyElsewhere === false);
  });

  it('restores the backup that was clicked, even if another tab saved one since', async () => {
    const storage = new Map();
    const server = createServer(ids(8));
    const here = load(server, { storage, href: WL_PAGE });
    await here.api.run();
    const clicked = here.lastView().backups[0].id;
    const other = load(server, { storage, href: WL_PAGE });
    await other.api.run();
    assert.notEqual(other.lastView().backups[0].id, clicked);
    await here.handlers().onRestore(clicked);
    assert.deepEqual(server.order, ids(8));
  });
});

describe('safety: interrupted runs', () => {
  it('reports a run whose tab closed partway, when the playlist opens again', async () => {
    const storage = new Map();
    const server = createServer(ids(10));
    const closed = load(server, { storage, href: WL_PAGE });
    server.onEdit = (count) => (count === 3 ? HANG : undefined);
    const pending = closed.api.run();
    await waitFor(() => server.edits === 3);
    // A fresh page with the same storage and no lock held: the old tab is gone.
    const reopened = load(server, { storage, href: WL_PAGE });
    const notice = reopened.lastView().interrupted;
    assert.equal(notice.title, 'Last shuffle didn\'t finish');
    assert.match(notice.message, /No videos were lost/);
    assert.equal(reopened.lastView().backups.length, 1);
    assert.deepEqual(sorted(server.order), sorted(ids(10)));
    reopened.handlers().onDismiss();
    assert.equal(reopened.lastView().interrupted, null);
    closed.api.cancel();
    await pending;
  });

  it('keeps the notice after Stop without repeating the Stop message, and clears it once a run finishes', async () => {
    const server = createServer(ids(10));
    const env = load(server, { href: WL_PAGE });
    server.onEdit = (count) => {
      if (count === 3) env.api.cancel();
    };
    await env.api.run();
    assert.equal(env.lastView().phase, 'cancelled');
    assert.match(env.lastView().status, /^Stopped at 3 \/ \d+\. No videos were lost/);
    assert.equal(env.lastView().interrupted, null);
    env.navigate(OTHER_PAGE, 'Other - YouTube');
    env.navigate(WL_PAGE, 'Watch later - YouTube');
    assert.equal(env.lastView().interrupted.title, 'Last shuffle didn\'t finish');
    server.onEdit = () => {};
    await env.api.run();
    env.navigate(OTHER_PAGE, 'Other - YouTube');
    env.navigate(WL_PAGE, 'Watch later - YouTube');
    assert.equal(env.lastView().interrupted, null);
  });

  it('records nothing when stopped before anything changed', async () => {
    const server = createServer(ids(6));
    const env = load(server, { href: WL_PAGE });
    server.onRead = () => {
      env.api.cancel();
    };
    assert.equal((await env.api.run()).status, 'cancelled');
    assert.equal(env.lastView().status, 'Stopped. Nothing was changed.');
    assert.equal([...env.storage.keys()].some((key) => key.startsWith('wls:active:')), false);
  });

  it('warns before closing the tab only while the playlist is changing', async () => {
    const server = createServer(ids(6));
    let warnedAtQuestion = null;
    const env = load(server, {
      href: WL_PAGE,
      uiConfirm: async () => {
        warnedAtQuestion = env.unloadListeners.size;
        return true;
      }
    });
    await env.api.run();
    assert.equal(warnedAtQuestion, 0);
    assert.equal(env.unloadListeners.size, 0);
  });
});

describe('safety: backups', () => {
  it('refuses to start when the backup does not read back', async () => {
    const server = createServer(ids(6));
    const { api, lastView } = load(server, { storageSilent: true });
    assert.equal((await api.run()).status, 'failed');
    assert.equal(server.edits, 0);
    assert.match(lastView().status, /Could not save a backup, so nothing was changed/);
  });

  it('drops middle backups, never the original, when storage runs short', async () => {
    const storage = new Map();
    const server = createServer(ids(30));
    const roomy = load(server, { storage });
    for (let i = 0; i < 3; i++) await roomy.api.run();
    const limit = storage.get('wls:backup:WL').length - 1;
    const tight = load(server, { storage, storageLimit: limit });
    const before = server.order.slice();
    assert.equal((await tight.api.run()).status, 'done');
    const kept = tight.backups().map((backup) => backup.items.map((item) => item.setVideoId));
    assert.deepEqual(kept, [before, ids(30)]);
  });

  it('ignores nonsense settings instead of running without a backup', async () => {
    const server = createServer(ids(8));
    const config = {
      batchSize: 'lots',
      maxRetries: 'x',
      backupsToKeep: 0,
      transport: 'carrier pigeon',
      authParts: 'all',
      delayMs: -5,
      requestTimeoutMs: 1
    };
    const { api, backups } = load(server, { config });
    assert.equal(api.config.batchSize, 50);
    assert.equal(api.config.maxRetries, 3);
    assert.equal(api.config.backupsToKeep, 2);
    assert.equal(api.config.transport, 'fetch');
    assert.equal(api.config.authParts.length, 3);
    assert.equal(api.config.delayMs, 0);
    assert.equal(api.config.requestTimeoutMs, 1000);
    assert.equal((await api.run()).status, 'done');
    assert.equal(backups().length, 1);
  });
});

describe('safety: requests that never answer', () => {
  it('Stop ends a run even while a request hangs', async () => {
    const server = createServer(ids(8));
    const { api, lastView } = load(server);
    server.onEdit = (count) => (count === 2 ? HANG : undefined);
    const pending = api.run();
    await waitFor(() => server.edits === 2);
    api.cancel();
    assert.equal((await pending).status, 'cancelled');
    assert.match(lastView().status, /^Stopped at 1 \//);
    assert.deepEqual(sorted(server.order), sorted(ids(8)));
  });

  it('gives up on a hung request, pauses, and finishes on resume', async () => {
    const server = createServer(ids(8));
    const { api, lastView } = load(server, { config: { batchSize: 1, maxRetries: 0, requestTimeoutMs: 1000 } });
    server.onEdit = (count) => (count === 2 ? HANG : undefined);
    const pending = api.run();
    await waitFor(() => lastView().phase === 'paused');
    assert.match(lastView().status, /no answer within 1 s/);
    api.resume();
    const result = await pending;
    assert.equal(result.status, 'done');
    assert.deepEqual(server.order, targetIds(result));
  });
});

describe('safety: impatient users', () => {
  it('starts one run however many times Shuffle is clicked', async () => {
    const server = createServer(ids(10));
    const { handlers, backups, lastView, errors } = load(server, { href: WL_PAGE, config: {} });
    await Promise.all(Array.from({ length: 5 }, () => handlers().onShuffle()));
    assert.equal(backups().length, 1);
    assert.equal(server.edits, 1);
    assert.equal(lastView().phase, 'done');
    assert.deepEqual(errors, []);
  });

  it('restores once however many times Restore is clicked', async () => {
    const server = createServer(ids(10));
    const { api, handlers, lastView, errors } = load(server, { href: WL_PAGE, config: {} });
    await api.run();
    const id = lastView().backups[0].id;
    const edits = server.edits;
    await Promise.all(Array.from({ length: 5 }, () => handlers().onRestore(id)));
    assert.deepEqual(server.order, ids(10));
    assert.equal(server.edits, edits + 1);
    assert.deepEqual(errors, []);
  });

  it('drops an open restore question when another playlist opens', async () => {
    const server = createServer(ids(6));
    let asked = 0;
    const env = load(server, {
      href: WL_PAGE,
      uiConfirm: (request, signal) => {
        asked += 1;
        if (asked === 1) return Promise.resolve(true);
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(false)));
      }
    });
    await env.api.run();
    const shuffled = server.order.slice();
    const pending = env.handlers().onRestore(env.lastView().backups[0].id);
    await waitFor(() => asked === 2);
    env.navigate(OTHER_PAGE, 'Other - YouTube');
    assert.equal((await pending).status, 'declined');
    assert.deepEqual(server.order, shuffled);
  });

  it('stops a run whose moves keep being refused', async () => {
    const server = createServer(ids(30));
    const { api, lastView } = load(server);
    // Pathological: every move is applied but reported as rejected.
    server.onEdit = (_, body) => {
      server.apply(body.actions);
      return json({}, 400);
    };
    assert.equal((await api.run()).status, 'failed');
    assert.match(lastView().status, /kept refusing the moves/);
    assert.equal(server.edits, 21);
    assert.deepEqual(sorted(server.order), sorted(ids(30)));
  });

  it('spaces out fallback requests, which get no answer to wait for', () => {
    const { api } = load(createServer(ids(3)), { config: { transport: 'ytAction' } });
    assert.ok(api.innertube.requestGap() >= 1000);
  });
});

describe('safety: impatient users, continued', () => {
  it('ignores a second Resume click', async () => {
    const server = createServer(ids(8));
    const { api, lastView, errors } = load(server);
    let failing = true;
    server.onEdit = (count) => (count > 2 && failing ? json({}, 503) : undefined);
    const pending = api.run();
    await waitFor(() => lastView().phase === 'paused');
    failing = false;
    api.resume();
    assert.equal(lastView().phase, 'paused');
    await Promise.resolve();
    assert.notEqual(lastView().phase, 'paused');
    assert.doesNotThrow(() => api.resume());
    assert.equal((await pending).status, 'done');
    assert.deepEqual(errors, []);
  });
});
