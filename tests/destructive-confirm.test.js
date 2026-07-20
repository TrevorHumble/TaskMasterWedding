// tests/destructive-confirm.test.js
// Locks in the data-confirm attribute on the three destructive admin forms so a
// template edit that drops the attribute fails immediately.
//
// Covered acceptance criteria (issue #59):
//   AC-1  guest delete form carries data-confirm and method="post"
//   AC-2  photo takedown form carries data-confirm and method="post"
//   AC-3  task delete form carries data-confirm and method="post"
//
// REQUIRE ORDER: config / db are required only AFTER loadApp() sets DATA_DIR /
// DB_PATH env vars (same rule as task-deletion.test.js).
'use strict';

const path = require('path');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

// ---------------------------------------------------------------------------
// Extract the first <form> block whose action attribute matches actionPattern.
// Returns the raw HTML string of the opening <form ...> tag (everything up to
// and including the closing ">") or null if not found.
// ---------------------------------------------------------------------------
function extractFormTag(html, actionPattern) {
  // Match a <form ... action="...pattern..." ...> opening tag (single line).
  // The action value may appear before or after other attributes, so we scan
  // the whole tag rather than assuming attribute order.
  const formTagRe = /<form\b[^>]*>/gi;
  let match;
  while ((match = formTagRe.exec(html)) !== null) {
    const tag = match[0];
    if (actionPattern.test(tag)) {
      return tag;
    }
  }
  return null;
}

let app;
let db;
let adminAgent;

// IDs assigned during seeding so assertions can target real rows.
let guestId;
let taskId;
let submissionId;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;

  adminAgent = await makeAdminAgent(app);

  // Seed one guest, one task, and one live (non-taken-down) submission so the
  // destructive forms actually render on each page.
  taskId = db
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Confirm-test task').lastInsertRowid;

  guestId = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('confirmtoken', 'Confirm Guest').lastInsertRowid;

  // The feed's kebab menu only renders the takedown form for submissions
  // with taken_down = 0, so keep it live.
  submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, path.join('confirm.jpg'), path.join('confirm.jpg.jpg')).lastInsertRowid;
});

// ---------------------------------------------------------------------------
// AC-1: guest delete form
// ---------------------------------------------------------------------------
it('AC-1: guest delete form has data-confirm and method="post"', async () => {
  const res = await adminAgent.get('/admin/guests');
  expect(res.status).toBe(200);

  // Target the form whose action ends with /<guestId>/delete, not any other
  // form on the page (e.g. bulk-create also carries data-confirm).
  const deleteActionRe = new RegExp(`action="/admin/guests/${guestId}/delete"`, 'i');
  const tag = extractFormTag(res.text, deleteActionRe);

  expect(tag).not.toBeNull();
  expect(tag).toMatch(/data-confirm=/i);
  expect(tag).toMatch(/method="post"/i);
});

// ---------------------------------------------------------------------------
// AC-2: photo takedown form
//
// Issue #684 (2026-07-20 owner-approved redesign) moved takedown/restore OUT
// of the shared give-a-badge dialog (now award-only) and into a per-photo
// kebab (⋯) menu on the feed card — a real static <form action="/admin/
// photos/<id>/takedown"> for that exact submission, not a dialog whose
// action is rewritten by client-side JS. Confirm this real form.
// ---------------------------------------------------------------------------
it('AC-2: the photo\'s kebab takedown form has data-confirm and method="post"', async () => {
  const res = await adminAgent.get('/admin/photos');
  expect(res.status).toBe(200);

  const takedownActionRe = new RegExp(`action="/admin/photos/${submissionId}/takedown"`, 'i');
  const tag = extractFormTag(res.text, takedownActionRe);

  expect(tag).not.toBeNull();
  expect(tag).toMatch(/data-confirm=/i);
  expect(tag).toMatch(/method="post"/i);
});

// ---------------------------------------------------------------------------
// AC-3: task delete form
// ---------------------------------------------------------------------------
it('AC-3: task delete form has data-confirm and method="post"', async () => {
  const res = await adminAgent.get('/admin/tasks');
  expect(res.status).toBe(200);

  // Target the form whose action ends with /<taskId>/delete, not reorder or
  // edit or active forms on the same page.
  const deleteActionRe = new RegExp(`action="/admin/tasks/${taskId}/delete"`, 'i');
  const tag = extractFormTag(res.text, deleteActionRe);

  expect(tag).not.toBeNull();
  expect(tag).toMatch(/data-confirm=/i);
  expect(tag).toMatch(/method="post"/i);
});
