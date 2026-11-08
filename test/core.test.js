const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const core = require('../src/core.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function seededRand(seed) {
  let state = seed;
  return (maxExclusive) => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state % maxExclusive;
  };
}

function ids(count) {
  return Array.from({ length: count }, (_, i) => `id${i}`);
}

function readFixture(name) {
  const file = path.join(FIXTURES, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

describe('shuffle', () => {
  it('returns a permutation of the input', () => {
    const input = ids(50);
    assert.deepEqual(core.shuffle(input).sort(), input.slice().sort());
  });

  it('does not mutate the input', () => {
    const input = ids(10);
    const copy = input.slice();
    core.shuffle(input);
    assert.deepEqual(input, copy);
  });

  it('is deterministic with a seeded rand', () => {
    const input = ids(20);
    assert.deepEqual(core.shuffle(input, seededRand(7)), core.shuffle(input, seededRand(7)));
    assert.notDeepEqual(core.shuffle(input, seededRand(7)), core.shuffle(input, seededRand(8)));
  });

  it('handles 0 and 1 items', () => {
    assert.deepEqual(core.shuffle([]), []);
    assert.deepEqual(core.shuffle(['only']), ['only']);
  });
});

describe('randomInt', () => {
  it('stays in range', () => {
    for (let i = 0; i < 1000; i++) {
      const value = core.randomInt(7);
      assert.ok(Number.isInteger(value) && value >= 0 && value < 7);
    }
  });
});

describe('applyMove', () => {
  it('moves to the top', () => {
    assert.deepEqual(core.applyMove(['a', 'b', 'c'], { setVideoId: 'c', after: null }), ['c', 'a', 'b']);
  });

  it('moves after a predecessor', () => {
    assert.deepEqual(core.applyMove(['a', 'b', 'c', 'd'], { setVideoId: 'a', after: 'c' }), ['b', 'c', 'a', 'd']);
  });

  it('is a no-op after the current predecessor', () => {
    assert.deepEqual(core.applyMove(['a', 'b', 'c'], { setVideoId: 'b', after: 'a' }), ['a', 'b', 'c']);
  });
});

describe('planMoves', () => {
  for (const size of [0, 1, 2, 10, 1000]) {
    it(`reaches the target for ${size} items`, () => {
      const rand = seededRand(size + 1);
      const current = core.shuffle(ids(size), rand);
      const target = core.shuffle(ids(size), rand);
      const moves = core.planMoves(current, target);
      assert.deepEqual(moves.reduce(core.applyMove, current), target);
    });
  }

  it('gives zero moves for identical arrays', () => {
    assert.deepEqual(core.planMoves(ids(20), ids(20)), []);
  });

  it('throws on mismatched id sets', () => {
    assert.throws(() => core.planMoves(['a', 'b'], ['a', 'c']));
    assert.throws(() => core.planMoves(['a', 'b'], ['a']));
    assert.throws(() => core.planMoves(['a', 'a'], ['a', 'b']));
    assert.throws(() => core.planMoves(['a', 'b'], ['a', 'a']));
  });
});

describe('toAction', () => {
  it('emits the predecessor when after is set', () => {
    assert.deepEqual(core.toAction({ setVideoId: 'a', after: 'b' }), {
      action: 'ACTION_MOVE_VIDEO_AFTER',
      setVideoId: 'a',
      movedSetVideoIdPredecessor: 'b'
    });
  });

  it('omits the predecessor when moving to the top', () => {
    assert.deepEqual(core.toAction({ setVideoId: 'a', after: null }), {
      action: 'ACTION_MOVE_VIDEO_AFTER',
      setVideoId: 'a'
    });
  });
});

describe('parsePlaylistPage', () => {
  const primaryPage = {
    contents: {
      playlistVideoListRenderer: {
        contents: [
          { playlistVideoRenderer: { videoId: 'v1', setVideoId: 's1', title: { runs: [{ text: 'One' }] } } },
          { playlistVideoRenderer: { videoId: 'v2', setVideoId: 's2', title: { simpleText: 'Two' } } },
          { playlistVideoRenderer: { videoId: 'v1', setVideoId: 's1', title: { runs: [{ text: 'Dup' }] } } },
          {
            continuationItemRenderer: {
              continuationEndpoint: { continuationCommand: { token: 'next-page' } }
            }
          }
        ]
      }
    }
  };

  it('reads the primary shape and dedupes by setVideoId', () => {
    assert.deepEqual(core.parsePlaylistPage(primaryPage), {
      items: [
        { setVideoId: 's1', videoId: 'v1', title: 'One' },
        { setVideoId: 's2', videoId: 'v2', title: 'Two' }
      ],
      continuation: 'next-page',
      unmovable: 0
    });
  });

  it('falls back to any object with videoId and setVideoId', () => {
    const page = {
      someNewRenderer: { entries: [{ videoId: 'v3', setVideoId: 's3', title: { simpleText: 'Three' } }] },
      unrelated: { videoId: 'not-an-item' }
    };
    assert.deepEqual(core.parsePlaylistPage(page), {
      items: [{ setVideoId: 's3', videoId: 'v3', title: 'Three' }],
      continuation: null,
      unmovable: 0
    });
  });

  it('prefers the primary shape when both are present', () => {
    const page = {
      a: { playlistVideoRenderer: { videoId: 'v1', setVideoId: 's1' } },
      b: { videoId: 'v2', setVideoId: 's2' }
    };
    assert.deepEqual(core.parsePlaylistPage(page).items.map((item) => item.setVideoId), ['s1']);
  });

  it('finds a token nested in a command list', () => {
    const page = {
      continuationItemRenderer: {
        continuationEndpoint: {
          commandExecutorCommand: { commands: [{ other: {} }, { continuationCommand: { token: 'nested' } }] }
        }
      }
    };
    assert.equal(core.parsePlaylistPage(page).continuation, 'nested');
  });

  it('falls back to the older continuation shape', () => {
    const page = { continuations: [{ nextContinuationData: { continuation: 'older' } }] };
    assert.equal(core.parsePlaylistPage(page).continuation, 'older');
  });

  // Mirrors a live anonymous response, November 2026.
  function lockup(contentId, extra = {}) {
    return {
      lockupViewModel: {
        contentId,
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: { lockupMetadataViewModel: { title: { content: `Title ${contentId}` } } },
        ...extra
      }
    };
  }

  function viewModelContinuation(token) {
    return {
      continuationItemViewModel: {
        trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
        continuationCommand: {
          innertubeCommand: { continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } }
        }
      }
    };
  }

  it('reports lockups without a setVideoId as unmovable', () => {
    const page = { contents: [lockup('v1'), lockup('v2')] };
    assert.deepEqual(core.parsePlaylistPage(page), { items: [], continuation: null, unmovable: 2 });
  });

  it('reads a lockup whose setVideoId is nested inside it', () => {
    const menu = { menu: { playlistEditEndpoint: { actions: [{ setVideoId: 's1' }] } } };
    const page = { contents: [lockup('v1', menu), lockup('v2')] };
    assert.deepEqual(core.parsePlaylistPage(page), {
      items: [{ setVideoId: 's1', videoId: 'v1', title: 'Title v1' }],
      continuation: null,
      unmovable: 1
    });
  });

  it('ignores lockups that are not videos', () => {
    const page = { contents: [lockup('p1', { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' })] };
    assert.equal(core.parsePlaylistPage(page).unmovable, 0);
  });

  it('finds the token in a continuation view model', () => {
    const page = { contents: [lockup('v1'), viewModelContinuation('list-token')] };
    assert.equal(core.parsePlaylistPage(page).continuation, 'list-token');
  });

  it('prefers the token next to the videos over a section-level one', () => {
    const list = { contents: [lockup('v1'), viewModelContinuation('list-token')] };
    const section = viewModelContinuation('section-token');
    assert.equal(core.parsePlaylistPage({ sections: [list, section] }).continuation, 'list-token');
    assert.equal(core.parsePlaylistPage({ sections: [section, list] }).continuation, 'list-token');
  });

  it('uses a token found anywhere when none sits next to the videos', () => {
    const page = { sections: [{ contents: [lockup('v1')] }, viewModelContinuation('section-token')] };
    assert.equal(core.parsePlaylistPage(page).continuation, 'section-token');
  });

  it('returns null when there is no token', () => {
    assert.equal(core.parsePlaylistPage({ contents: [] }).continuation, null);
  });

  const firstPage = readFixture('initial_data.json');
  const nextPage = readFixture('browse_continuation.response.json');

  it('parses captured pages', { skip: !firstPage && !nextPage && 'no captured fixtures' }, () => {
    for (const page of [firstPage, nextPage].filter(Boolean)) {
      const { items } = core.parsePlaylistPage(page);
      assert.ok(items.length > 0);
      assert.equal(new Set(items.map((item) => item.setVideoId)).size, items.length);
    }
    if (firstPage && nextPage) assert.ok(core.parsePlaylistPage(firstPage).continuation);
  });
});

describe('parseDisplayedCount', () => {
  it('reads the header count', () => {
    const page = { header: { playlistHeaderRenderer: { numVideosText: { runs: [{ text: '1,234' }, { text: ' videos' }] } } } };
    assert.equal(core.parseDisplayedCount(page), 1234);
  });

  it('reads the sidebar stats', () => {
    const page = { playlistSidebarPrimaryInfoRenderer: { stats: [{ simpleText: '87 videos' }, { simpleText: 'Updated today' }] } };
    assert.equal(core.parseDisplayedCount(page), 87);
  });

  it('gives up quietly', () => {
    assert.equal(core.parseDisplayedCount({ header: {} }), null);
    assert.equal(core.parseDisplayedCount({ numVideosText: { simpleText: 'No videos' } }), null);
  });
});

describe('isEditSuccess', () => {
  it('finds the success marker', () => {
    assert.equal(core.isEditSuccess({ status: 'STATUS_SUCCEEDED' }), true);
    assert.equal(core.isEditSuccess({ result: { status: 'STATUS_SUCCEEDED' } }), true);
  });

  it('treats anything else as a failure', () => {
    assert.equal(core.isEditSuccess({ status: 'STATUS_FAILED' }), false);
    assert.equal(core.isEditSuccess({}), false);
  });
});

describe('buildRestoreTarget', () => {
  it('puts new items first and drops items that are gone', () => {
    const current = ['new1', 'c', 'new2', 'a'];
    const backup = ['a', 'b', 'c'];
    assert.deepEqual(core.buildRestoreTarget(current, backup), ['new1', 'new2', 'a', 'c']);
  });

  it('always yields something planMoves accepts', () => {
    const current = ['x', 'a', 'b'];
    const target = core.buildRestoreTarget(current, ['b', 'b', 'gone', 'a']);
    assert.deepEqual(target, ['x', 'b', 'a']);
    assert.doesNotThrow(() => core.planMoves(current, target));
  });
});

describe('countOutOfPlace', () => {
  it('counts positions that differ', () => {
    assert.equal(core.countOutOfPlace(['a', 'b', 'c'], ['a', 'b', 'c']), 0);
    assert.equal(core.countOutOfPlace(['b', 'a', 'c'], ['a', 'b', 'c']), 2);
  });
});

describe('validateBackup', () => {
  it('accepts a well-formed backup', () => {
    const backup = { version: 1, createdAt: 'now', playlistId: 'WL', items: [{ setVideoId: 's1' }] };
    assert.doesNotThrow(() => core.validateBackup(backup));
  });

  it('rejects anything else', () => {
    assert.throws(() => core.validateBackup(null));
    assert.throws(() => core.validateBackup({ version: 2, playlistId: 'WL', items: [] }));
    assert.throws(() => core.validateBackup({ version: 1, items: [] }));
    assert.throws(() => core.validateBackup({ version: 1, playlistId: 'WL', items: [{}] }));
  });
});
