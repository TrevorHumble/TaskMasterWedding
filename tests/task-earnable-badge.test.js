// tests/task-earnable-badge.test.js
// Issue #486: the guest task list shows each task's earnable badge — the
// badge art (custom or default, via issue #483's resolveTaskBadge) plus
// "Best photos earn [name] + bonus points" copy (issue #682/#652's owner-
// approved prize framing superseded the original "plus extra points"
// wording), with no fixed point number attached to that copy. Follows
// tests/tasks-page.test.js's loadApp()/signInGuest seeding conventions.
//
// Issue #926 AC5/AC6 redesign: the badge art moved from a small caption-line
// icon to a 52px leading element (`.task-badge-lead`, `alt=''`) at the row's
// left edge, and the earn-pitch copy is now THREE spans, not two --
// `.task-earnable-lead` ("Best photos earn"), `.task-earnable-name` (the
// badge name, the only one that may shrink/ellipsize), `.task-earnable-tail`
// ("+ bonus points") -- as a direct child of `.task-link`. The assertions
// below target that structure so a regression back to the old two-span
// shape, or the old small caption-line art, fails loudly rather than being
// silently unfalsifiable (the old `<span class="task-earnable-copy">TEXT</span>`
// regex this file used to run never matches the current nested-span markup,
// so it would have matched zero blocks and failed for the WRONG reason).
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let taskBadges;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  taskBadges = require('../src/services/task-badges');
});

const TOKEN = 'earnable-badge-token';

// One customized task (a distinct badge name + uploaded art) and one plain
// task left on the default ribbon — AC1 and AC2's givens side by side.
function seedField() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM badges').run();

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(TOKEN, 'Badge Guest').lastInsertRowid;

  const customTaskId = db
    .prepare(`INSERT INTO tasks (title, description, sort_order) VALUES (?, ?, ?)`)
    .run('Golden move task', 'Strike the golden pose', 1).lastInsertRowid;
  taskBadges.setTaskBadge(customTaskId, {
    name: 'Golden Move',
    artPath: '/uploads/golden-move.jpg',
  });

  const plainTaskId = db
    .prepare(`INSERT INTO tasks (title, description, sort_order) VALUES (?, ?, ?)`)
    .run('Plain task', 'Nothing customized here', 2).lastInsertRowid;

  return { guestId, customTaskId, plainTaskId };
}

async function signedInTasks() {
  const agent = require('supertest').agent(app);
  signInGuest(app, TOKEN, agent);
  const res = await agent.get('/tasks');
  expect(res.status).toBe(200);
  return res;
}

describe('earnable badge on task list (#486)', () => {
  let guestId;
  let customTaskId;
  let plainTaskId;

  beforeAll(() => {
    const seeded = seedField();
    guestId = seeded.guestId;
    customTaskId = seeded.customTaskId;
    plainTaskId = seeded.plainTaskId;
  });

  test('AC1: a task with a custom badge leads with its art and carries the three-span earn-pitch naming it', async () => {
    const res = await signedInTasks();

    const rowStart = res.text.indexOf(`/tasks/${customTaskId}`);
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    expect(row).toContain('task-badge-lead');
    expect(row).toContain('/uploads/golden-move.jpg');
    // The three spans' CLOSING `>` is written on the next line by the EJS
    // source's whitespace-elision trick (no space before the next tag), so
    // the literal byte sequence is `</span` + newline/indent + `>` rather
    // than an unbroken `</span>` — match up to (not through) that `>`.
    expect(row).toMatch(/<span class="task-earnable-lead">Best photos earn<\/span/);
    expect(row).toMatch(/<span class="task-earnable-name">Golden Move<\/span/);
    expect(row).toMatch(/<span class="task-earnable-tail">\+ bonus points<\/span/);
  });

  test('AC2: a task with no custom badge leads with the default-ribbon art and the same earn-pitch shape', async () => {
    const res = await signedInTasks();

    const rowStart = res.text.indexOf(`/tasks/${plainTaskId}`);
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    const defaultBadge = taskBadges.resolveTaskBadge(plainTaskId);
    expect(defaultBadge.art_path).toBe(taskBadges.DEFAULT_RIBBON_ART_PATH);
    expect(row).toContain('task-badge-lead');
    expect(row).toContain(taskBadges.DEFAULT_RIBBON_ART_PATH);
    expect(row).toMatch(/<span class="task-earnable-tail">\+ bonus points<\/span/);
  });

  test('AC3: the earnable-badge copy carries no fixed per-task point number', async () => {
    const res = await signedInTasks();

    // The only VARIABLE part of the earn-pitch line is the badge name --
    // task-earnable-lead/-tail are fixed strings with no digits by
    // construction. Confirm every rendered name is digit-free (the "+1 pt"
    // chevron reward lives in a sibling span, task-points, untouched by this
    // change, so scoping to just the name avoids trivially failing against
    // that pre-existing, unrelated element) and confirm the fixed lead/tail
    // text renders literally, so a per-task number could not have been
    // spliced into either fixed span instead.
    const nameMatches = [...res.text.matchAll(/<span class="task-earnable-name">([^<]*)<\/span/g)];
    expect(nameMatches.length).toBeGreaterThanOrEqual(2);
    for (const match of nameMatches) {
      expect(match[1]).not.toMatch(/\d/);
    }
    const leadMatches = res.text.match(/<span class="task-earnable-lead">Best photos earn<\/span/g);
    const tailMatches = res.text.match(/<span class="task-earnable-tail">\+ bonus points<\/span/g);
    expect((leadMatches || []).length).toBeGreaterThanOrEqual(2);
    expect((tailMatches || []).length).toBeGreaterThanOrEqual(2);
  });

  test('AC4: the earnable badge art uses the shared fixed-size .badge-art frame, not a raw sized img', async () => {
    const res = await signedInTasks();

    const rowStart = res.text.indexOf(`/tasks/${customTaskId}`);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    expect(row).toMatch(/<img class="badge-art"[^>]*src="\/uploads\/golden-move\.jpg"/);
    // Decorative beside the named earn-pitch text (issue #926 AC5): alt=''.
    expect(row).toMatch(/<img class="badge-art"[^>]*alt=""/);
  });

  test('issue #926 AC6: the DONE view keeps the same earn-pitch shape but leads with the guest photo thumbnail, not badge art', async () => {
    db.prepare('DELETE FROM submissions').run();
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
    ).run(guestId, customTaskId);

    const agent = require('supertest').agent(app);
    signInGuest(app, TOKEN, agent);
    const res = await agent.get('/tasks?view=done');
    expect(res.status).toBe(200);

    const rowStart = res.text.indexOf(`/tasks/${customTaskId}`);
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = res.text.indexOf('</li>', rowStart);
    const row = res.text.slice(rowStart, rowEnd);

    // Photo thumbnail leads, not the 52px badge art.
    expect(row).toContain('task-thumb-wrap');
    expect(row).not.toContain('task-badge-lead');
    // Same one-line earn-pitch shape as the to-do row.
    expect(row).toMatch(/<span class="task-earnable-lead">Best photos earn<\/span/);
    expect(row).toMatch(/<span class="task-earnable-name">Golden Move<\/span/);
    expect(row).toMatch(/<span class="task-earnable-tail">\+ bonus points<\/span/);
  });
});
