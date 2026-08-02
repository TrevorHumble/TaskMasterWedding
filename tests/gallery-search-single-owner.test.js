// tests/gallery-search-single-owner.test.js
// Issue #935's real single-ownership proof: feed.grouped()'s ?q= filter must
// actually CALL src/public/js/filter.js's nameMatchesQuery, not carry an
// inlined copy of the same logic. tests/gallery-search-filter-parity.test.js
// only proves behavioral agreement (both rules happen to return the same
// answer) — that test cannot fail if feed.js quietly inlined its own copy of
// the any-word-prefix rule.
//
// NOT vi.mock: this whole codebase requires modules with plain CJS require(),
// and vi.mock's interception only covers vitest's own import/transform graph
// — verified by hand here (it silently no-ops on a require()'d CJS module,
// leaving feed.js holding the real function with no error or warning). So
// this file fakes the shared export the primitive way instead: require the
// filter module first (populating Node's module cache with its exports
// object), monkey-patch nameMatchesQuery on THAT SAME object, then require
// feed.js. feed.js does `const { nameMatchesQuery } = require(...)` — that
// destructure reads whatever is on the object at feed.js's OWN require time,
// so patching before feed.js first loads is load-bearing order, not
// stylistic; patching after would bind feed.js to the original function
// forever (destructuring copies the reference, it doesn't alias the property).
// Restored in afterAll so no other test file in the same worker sees the
// stub.
//
// Isolated in its own file so a stray import order elsewhere can't load
// feed.js (and thus destructure the real nameMatchesQuery) before this file's
// beforeAll patches it.
//
// REQUIRE ORDER: config / db / feed are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH (see tests/helpers/testApp.js). Do not hoist requires
// above the loadApp() call.
'use strict';

const { loadApp } = require('./helpers/testApp');

let db;
let feed;
let filterModule;
let originalNameMatchesQuery;
let stub;

let guestId;

beforeAll(() => {
  // Patch BEFORE feed.js is first required — and loadApp() itself boots the
  // app, which requires src/routes/community.js, which requires feed.js, so
  // the patch must land before loadApp() runs, not after (see file header).
  // filter.js is a pure function module with no DATA_DIR/DB_PATH dependency,
  // so requiring it ahead of loadApp() is safe unlike config/db/feed.
  filterModule = require('../src/public/js/filter');
  originalNameMatchesQuery = filterModule.nameMatchesQuery;
  stub = vi.fn(() => false);
  filterModule.nameMatchesQuery = stub;

  const loaded = loadApp();
  db = loaded.db;

  feed = require('../src/services/feed');

  guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('search-single-owner-guest', 'Single Owner Guest').lastInsertRowid;

  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, NULL, 'so-a.jpg', 'so-at.jpg', 0, '2024-06-01 10:00:00')`
  ).run(guestId);
});

afterAll(() => {
  if (filterModule) {
    filterModule.nameMatchesQuery = originalNameMatchesQuery;
  }
});

describe('feed.grouped() is the single owner: it calls the shared nameMatchesQuery, not a copy', () => {
  it('returns [] when the shared filter stub always answers false', () => {
    stub.mockClear();
    const groups = feed.grouped('user', null, 'some query');
    expect(groups).toEqual([]);
  });

  it('actually invoked the shared filter (proves it is on the call path)', () => {
    stub.mockClear();
    feed.grouped('user', null, 'some query');
    expect(stub).toHaveBeenCalled();
    expect(stub).toHaveBeenCalledWith('Single Owner Guest', 'some query');
  });
});
