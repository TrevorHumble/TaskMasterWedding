// tests/task-share-memory-gap.test.js
// Originally covered issue #471: `.task-share-memory` had no corresponding
// rule in theme.css, so the "Share a memory" button sat flush against the
// last task row with no visible gap.
//
// jsdom (this repo's only DOM test dependency) does not implement CSS layout
// — a real rendered-gap assertion cannot run in this suite. Instead this
// test asserts on the parsed CSS source directly, the same ruleBlock()
// pattern tests/masthead-overflow.test.js and the AC6 block in
// tests/masthead-menu.test.js already use.
//
// Issue #1002 (owner call, 2026-08-01) retired the row-based placement
// entirely: "Share a memory" is now a quiet `btn-secondary` button in its
// own `section.tasks-share-cta`, sitting between the `.task-filters` chips
// and the task list. The describe blocks below assert THAT contract — the
// standalone button, its position, and that no row-based placement remains
// anywhere on the page — rather than the row-gap concern #471 originally
// raised.
//
// REQUIRE ORDER MATTERS: config / db / app are required only via loadApp() —
// see tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');
const { readThemeCss } = require('./helpers/theme-css');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

// Pull a top-level CSS rule block out of the stylesheet source by selector
// text, the same helper approach tests/masthead-overflow.test.js uses.
function ruleBlock(source, selector) {
  const start = source.indexOf(selector + ' {');
  if (start === -1) return null;
  const end = source.indexOf('}', start);
  return source.slice(start, end + 1);
}

function seedOneTodoTask() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();

  db.prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)').run(
    'ac471-token',
    'Gap Guest'
  );
  db.prepare('INSERT INTO tasks (title) VALUES (?)').run('Find the guestbook');
}

async function signedInAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

describe('.task-share-memory CSS rule stays gone (retired by #656, superseded by #1002)', () => {
  test('no .task-share-memory rule remains in theme.css', () => {
    // Issue #969: theme.css split into slices -- read via the shared helper.
    const themeSrc = readThemeCss();
    expect(ruleBlock(themeSrc, '.task-share-memory')).toBeNull();
  });
});

describe('#1002: Share a memory is a quiet button under the filter chips, not a to-do row', () => {
  test('/tasks with a to-do task renders section.tasks-share-cta after .task-filters and before .task-list', async () => {
    seedOneTodoTask();
    const agent = await signedInAgent('ac471-token');

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    // The exact owner-approved anchor (AC1): no points text; the caption is
    // now the sibling .tasks-share-hint line asserted by this issue's own test.
    expect(res.text).toContain(
      '<a class="btn btn-secondary btn-block" href="/memories/new">Share a memory</a>'
    );
    expect(res.text).toContain('<section class="tasks-share-cta">');

    // Position: filters, then the CTA, then the list (AC1's "after ...
    // before" ordering, checked via indexOf like the rest of this suite).
    const filtersIdx = res.text.indexOf('class="task-filters"');
    const ctaIdx = res.text.indexOf('class="tasks-share-cta"');
    const listIdx = res.text.indexOf('class="task-list"');
    expect(filtersIdx).toBeGreaterThan(-1);
    expect(ctaIdx).toBeGreaterThan(filtersIdx);
    expect(listIdx).toBeGreaterThan(ctaIdx);
  });

  test('no task-row block contains "Share a memory", and /memories/new appears exactly once (AC2)', async () => {
    seedOneTodoTask();
    const agent = await signedInAgent('ac471-token');

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const rows = res.text.split('<li class="task-row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(function (row) {
      expect(row).not.toContain('Share a memory');
    });

    const memoriesNewMatches = res.text.match(/\/memories\/new/g) || [];
    expect(memoriesNewMatches.length).toBe(1);
  });
});

describe('#1088: the Share a memory button carries a muted task-free hint line', () => {
  test('the hint <p> sits immediately after the button anchor, adjacent with only whitespace between (AC1)', async () => {
    seedOneTodoTask();
    const agent = await signedInAgent('ac471-token');

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    expect(res.text).toMatch(
      /<a class="btn btn-secondary btn-block" href="\/memories\/new">Share a memory<\/a>\s*<p class="tasks-share-hint">Share a photo at any time, no task required<\/p>/
    );
  });

  test('.tasks-share-hint declares the approved muted-caption tokens, with no raw length or hard-coded colour (AC2)', () => {
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.tasks-share-hint');
    expect(block).not.toBeNull();

    expect(block).toMatch(/margin:\s*var\(--space-1\)\s+0\s+0;/);
    expect(block).toMatch(/text-align:\s*center;/);
    expect(block).toMatch(/font-size:\s*var\(--fs-eyebrow\);/);
    expect(block).toMatch(/line-height:\s*1\.3;/);
    expect(block).toMatch(/color:\s*var\(--color-text-muted\);/);
    expect(block).not.toMatch(/\d+(px|rem)/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe('AC3: the allDone .tasks-memory-cta path is untouched, and .tasks-share-cta does not also render', () => {
  test('.tasks-memory-cta keeps its original margin/padding/background, no added margin-top rule', () => {
    // Issue #969: theme.css split into slices -- read via the shared helper.
    const themeSrc = readThemeCss();
    const block = ruleBlock(themeSrc, '.tasks-memory-cta');
    expect(block).not.toBeNull();

    // Original shorthand `margin` (top/right/bottom/left via space-4/0/space-6/0)
    // is unchanged — no separate `margin-top` was introduced onto this rule.
    expect(block).toMatch(/margin:\s*var\(--space-4\)\s+0\s+var\(--space-6\);/);
    expect(block).not.toMatch(/margin-top:/);
    expect(block).toMatch(/padding:\s*var\(--space-4\);/);
    expect(block).toMatch(/background:\s*var\(--green-50\);/);
    expect(block).toMatch(/border-radius:\s*var\(--radius-input\);/);
    expect(block).toMatch(/text-align:\s*center;/);
  });

  test("finished-every-task guest gets the card's own share link, not the chips-CTA, and /memories/new appears exactly once (AC3)", async () => {
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM guests').run();
    // avatar_path is set so this guest is genuinely "all done": issue #409's
    // owner-redirected placement (second visual-loop edit, 2026-07-14) folds
    // the hardcoded profile-photo starter tile into the to-do/done split, so
    // a guest who hasn't set an avatar always has an outstanding to-do item
    // (the tile itself) and allDone (src/views/tasks.ejs) never fires.
    const guestId = db
      .prepare('INSERT INTO guests (token, name, onboarded, avatar_path) VALUES (?, ?, 1, ?)')
      .run('ac471-alldone-token', 'Done Guest', 'has-avatar.jpg').lastInsertRowid;
    const taskId = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Cut the cake').lastInsertRowid;
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, 'p.jpg', 't.jpg');

    const agent = await signedInAgent('ac471-alldone-token');
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    expect(res.text).toMatch(/<a class="btn btn-block" href="\/memories\/new">Share a memory<\/a>/);
    // The chips CTA is absent — the finished-card button is the page's ONLY
    // Share a memory link (AC3).
    expect(res.text).not.toContain('class="tasks-share-cta"');
    expect(res.text).not.toContain('task-share-memory');
    expect(res.text).not.toContain('class="tasks-share-hint"');

    const memoriesNewMatches = res.text.match(/\/memories\/new/g) || [];
    expect(memoriesNewMatches.length).toBe(1);
  });
});
