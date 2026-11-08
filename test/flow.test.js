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
  if (offset + PAGE_SIZE < server.order.length) {
    const token = `offset:${offset + PAGE_SIZE}`;
    contents.push({
      continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } }
    });
  }
  return { contents };
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
        const override = server.onEdit(server.edits, body);
        if (override) return override;
        server.apply(body.actions);
        return json({ status: 'STATUS_SUCCEEDED' });
      }
      server.reads += 1;
      const override = server.onRead(server.reads, body);
      if (override) return override;
      const offset = body.continuation ? Number(body.continuation.split(':')[1]) : 0;
      return json(toPage(server, offset));
    }
  };
  return server;
}

function load(server, { confirmAnswer = true, config = {}, storageFull = false, href } = {}) {
  const storage = new Map();
  if (Object.keys(config).length > 0) storage.set('wls:config', JSON.stringify(config));
  const views = [];
  const events = [];
  const unloadListeners = new Set();
  const ytcfgData = { INNERTUBE_CONTEXT: { client: {} }, SESSION_INDEX: 0 };
  const url = new URL(href ?? 'https://www.youtube.com/');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    crypto,
    TextEncoder,
    URLSearchParams,
    AbortController,
    clearTimeout,
    setTimeout: (fn) => setTimeout(fn, 0),
    setInterval: () => 0,
    fetch: server.fetch,
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
        if (storageFull && key.startsWith('wls:backup:')) throw new Error('quota');
        storage.set(key, value);
      }
    },
    document: {
      cookie: 'SAPISID=abc; __Secure-1PAPISID=def; __Secure-3PAPISID=ghi',
      addEventListener() {},
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
  vm.runInContext(fs.readFileSync(path.join(SRC, 'main.js'), 'utf8'), context);
  return {
    api: sandbox.__wlShuffle,
    views,
    events,
    storage,
    unloadListeners,
    ytcfgData,
    lastView: () => views.at(-1),
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
    const server = createServer(ids(6));
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
    assert.deepEqual(backup.items.map((item) => item.setVideoId), ids(6));
    assert.deepEqual(backup.items[0], { setVideoId: 's0', videoId: 'v-s0', title: 'Title s0' });
  });

  it('keeps only the most recent backups, newest first', async () => {
    const server = createServer(ids(6));
    const { api, backups } = load(server);
    for (let i = 0; i < 4; i++) await api.run();
    assert.equal(backups().length, 3);
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
    const server = createServer(ids(6));
    const { api, unloadListeners } = load(server);
    const first = api.run();
    await assert.rejects(api.run(), /already in progress/);
    assert.equal(unloadListeners.size, 1);
    await first;
    assert.equal(unloadListeners.size, 0);
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
    assert.match(lastView().status, /^Cancelled at 4 \/ \d+/);
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
    const { api, lastView } = load(server);
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

describe('visibility', () => {
  it('shows on Watch Later and while running, and hides elsewhere', async () => {
    const onWatchLater = load(createServer(ids(3)), {
      href: 'https://www.youtube.com/playlist?list=WL'
    });
    assert.equal(onWatchLater.lastView().visible, true);

    const server = createServer(ids(6));
    const elsewhere = load(server);
    assert.equal(elsewhere.lastView().visible, false);
    let shownDuringRun = false;
    server.onEdit = () => {
      shownDuringRun = elsewhere.lastView().visible;
    };
    await elsewhere.api.run();
    assert.equal(shownDuringRun, true);
    assert.equal(elsewhere.lastView().visible, false);
  });

  it('offers restore only when a Watch Later backup exists', async () => {
    const server = createServer(ids(6));
    const { api, lastView } = load(server);
    assert.equal(lastView().canRestore, false);
    await api.run();
    assert.equal(lastView().canRestore, true);
  });
});
