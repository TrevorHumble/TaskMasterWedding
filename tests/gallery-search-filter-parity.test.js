// tests/gallery-search-filter-parity.test.js
// Covers issue #935 acceptance criteria — feed.grouped()'s server-side ?q=
// filter must apply the same any-word-prefix rule the live client-side
// filter uses (src/public/js/filter.js's nameMatchesQuery), for BOTH
// grouped kinds (person and task). Calls src/services/feed.js directly (no
// HTTP), same pattern as tests/feed.test.js.
//
//   AC1 — "av fe" matches "Ava Fernandez" (any-word-prefix, both query words)
//   AC2 — "ern" no longer matches "Fernandez" (today's substring rule would
//         match; any-word-prefix requires a WORD-START match, so it must not)
//   AC3 — task heading "Dessert table dash": "ess" doesn't match, "des" does
//         — proves the By-task grouped view takes the same shared rule
//   AC4 — empty/whitespace q returns the unfiltered set of groups
//   Parity — feed.js requires the exact same exported function the client
//         loads, not a copy (standards: single-owner rule)
//
// REQUIRE ORDER: config / db / feed are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH (see tests/helpers/testApp.js). Do not hoist requires
// above the loadApp() call.
'use strict';

const { loadApp } = require('./helpers/testApp');

let db;
let feed;

let taskDessertId; // "Dessert table dash"
let taskOtherId; // "First dance" — control group, should never match "des"/"ess"
let guestAvaId; // "Ava Fernandez"
let guestOtherId; // "Priya Patel" — control group

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;
  feed = require('../src/services/feed');

  guestAvaId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('search-parity-ava', 'Ava Fernandez').lastInsertRowid;
  guestOtherId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('search-parity-priya', 'Priya Patel').lastInsertRowid;

  taskDessertId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Dessert table dash').lastInsertRowid;
  taskOtherId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('First dance').lastInsertRowid;

  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, 'sp-a.jpg', 'sp-at.jpg', 0, '2024-06-01 10:00:00')`
  ).run(guestAvaId, taskDessertId);

  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, 'sp-b.jpg', 'sp-bt.jpg', 0, '2024-06-01 11:00:00')`
  ).run(guestOtherId, taskOtherId);
});

describe('AC1: "av fe" matches "Ava Fernandez" under any-word-prefix', () => {
  it("grouped('user') includes Ava Fernandez's group", () => {
    const groups = feed.grouped('user', null, 'av fe');
    const headings = groups.map((g) => g.heading);
    expect(headings).toContain('Ava Fernandez');
    expect(headings).not.toContain('Priya Patel');
  });
});

describe('AC2: "ern" no longer matches "Fernandez" (substring rule is retired)', () => {
  it("grouped('user') excludes Ava Fernandez's group for q='ern'", () => {
    const groups = feed.grouped('user', null, 'ern');
    const headings = groups.map((g) => g.heading);
    // Under the old substring rule this WOULD match ("Fernandez".includes("ern")).
    // Under any-word-prefix it must not: no word in "Ava Fernandez" starts with "ern".
    expect(headings).not.toContain('Ava Fernandez');
  });
});

describe('AC3: By-task grouped view takes the same shared rule', () => {
  it('q="ess" does not match "Dessert table dash" (no word starts with "ess")', () => {
    const groups = feed.grouped('task', null, 'ess');
    const headings = groups.map((g) => g.heading);
    expect(headings).not.toContain('Dessert table dash');
  });

  it('q="des" matches "Dessert table dash" ("Dessert" starts with "des")', () => {
    const groups = feed.grouped('task', null, 'des');
    const headings = groups.map((g) => g.heading);
    expect(headings).toContain('Dessert table dash');
    expect(headings).not.toContain('First dance');
  });
});

describe('AC4: empty/whitespace q is the unfiltered gallery', () => {
  it('q=undefined returns every group', () => {
    const groups = feed.grouped('user', null);
    const headings = groups.map((g) => g.heading);
    expect(headings).toContain('Ava Fernandez');
    expect(headings).toContain('Priya Patel');
  });

  it('q="" returns every group', () => {
    const groups = feed.grouped('user', null, '');
    const headings = groups.map((g) => g.heading);
    expect(headings).toContain('Ava Fernandez');
    expect(headings).toContain('Priya Patel');
  });

  it('q="   " (whitespace only) returns every group', () => {
    const groups = feed.grouped('task', null, '   ');
    const headings = groups.map((g) => g.heading);
    expect(headings).toContain('Dessert table dash');
    expect(headings).toContain('First dance');
  });
});

// A real single-ownership assertion (proving feed.grouped() actually CALLS
// the shared nameMatchesQuery export, not a copy) lives in
// tests/gallery-search-single-owner.test.js, isolated in its own file
// because it needs vi.mock('../src/public/js/filter', ...), which vitest
// hoists to the top of its file — mixing that with these unmocked AC1-AC4
// tests in the same file would mock nameMatchesQuery for all of them.
