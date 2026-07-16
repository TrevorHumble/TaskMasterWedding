// tests/task-share-memory-gap.test.js
// Covers issue #471: `.task-share-memory` (src/views/tasks.ejs:102) had no
// corresponding rule in theme.css, so the "Share a memory" button sat flush
// against the last task row with no visible gap.
//
// jsdom (this repo's only DOM test dependency) does not implement CSS layout
// — a real rendered-gap assertion cannot run in this suite. Instead this
// test asserts on the parsed CSS source directly, the same ruleBlock()
// pattern tests/masthead-overflow.test.js and the AC6 block in
// tests/masthead-menu.test.js already use.
//
// REQUIRE ORDER MATTERS: config / db / app are required only via loadApp() —
// see tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

const THEME_PATH = path.join(__dirname, '../src/public/css/theme.css');

// Pull a top-level CSS rule block out of the stylesheet source by selector
// text, the same helper approach tests/masthead-overflow.test.js uses.
function ruleBlock(source, selector) {
  const start = source.indexOf(selector + ' {');
  if (start === -1) return null;
  const end = source.indexOf('}', start);
  return source.slice(start, end + 1);
}

// Resolve a `var(--space-N)` reference to its pixel value using the actual
// :root scale declared in theme.css, rather than hard-coding the mapping —
// so this test would fail if either the rule OR the scale changed in a way
// that broke the >= 16px requirement.
function spaceVarPx(themeSrc, varName) {
  const rootBlock = ruleBlock(themeSrc, ':root');
  const re = new RegExp('--' + varName + ':\\s*(\\d+)px');
  const match = re.exec(rootBlock);
  return match ? parseInt(match[1], 10) : null;
}

function seedOneTodoTask() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();

  db.prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)').run(
    'ac471-token',
    'Gap Guest'
  );
  db.prepare('INSERT INTO tasks (title, is_active) VALUES (?, 1)').run('Find the guestbook');
}

async function signedInAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

describe('AC471(1): .task-share-memory declares top spacing', () => {
  test('the rule exists and its margin-top resolves to >= 16px (var(--space-4))', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.task-share-memory');
    expect(block).not.toBeNull();

    const marginMatch = /margin-top:\s*var\(--(space-\d)\)/.exec(block);
    expect(marginMatch).not.toBeNull();

    const px = spaceVarPx(themeSrc, marginMatch[1]);
    expect(px).not.toBeNull();
    expect(px).toBeGreaterThanOrEqual(16);
  });
});

describe('AC471(2): the class still renders on the live button', () => {
  test('/tasks with a to-do task renders exactly one .task-share-memory button', async () => {
    seedOneTodoTask();
    const agent = await signedInAgent('ac471-token');

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const matches = res.text.match(/class="btn btn-secondary btn-block task-share-memory"/g) || [];
    expect(matches.length).toBe(1);
    expect(res.text).toMatch(
      /<a class="btn btn-secondary btn-block task-share-memory" href="\/memories\/new">Share a memory<\/a>/
    );
  });
});

describe('AC471(3): the allDone .tasks-memory-cta path is untouched', () => {
  test('.tasks-memory-cta keeps its original margin/padding/background, no added margin-top rule', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
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

  test('the allDone CTA button markup (tasks.ejs) is unchanged plain btn/btn-block, no task-share-memory class', async () => {
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM guests').run();
    // avatar_path is set so this guest is genuinely "all done": issue #409's
    // owner-redirected placement (second visual-loop edit, 2026-07-14) folds
    // the hardcoded profile-photo starter tile into the to-do/done split, so
    // a guest who hasn't set an avatar always has an outstanding to-do item
    // (the tile itself) and allDone (src/views/tasks.ejs) never fires.
    const guestId = db
      .prepare(
        'INSERT INTO guests (token, name, onboarded, avatar_path, avatar_point_awarded) VALUES (?, ?, 1, ?, 1)'
      )
      .run('ac471-alldone-token', 'Done Guest', 'has-avatar.jpg').lastInsertRowid;
    const taskId = db
      .prepare('INSERT INTO tasks (title, is_active) VALUES (?, 1)')
      .run('Cut the cake').lastInsertRowid;
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, 'p.jpg', 't.jpg');

    const agent = await signedInAgent('ac471-alldone-token');
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    expect(res.text).toMatch(/<a class="btn btn-block" href="\/memories\/new">Share a memory<\/a>/);
    // The allDone path's own button must never pick up the task-share-memory class.
    expect(res.text).not.toContain('task-share-memory');
  });
});
