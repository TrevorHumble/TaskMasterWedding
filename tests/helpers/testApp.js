// tests/helpers/testApp.js
// Helpers for spinning up an isolated app instance during tests.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Load the app pointed at a fresh temp database.
 *
 * REQUIRE ORDER MATTERS: config.js and db.js both read DATA_DIR / DB_PATH at
 * first require time (module-level code runs immediately). The environment
 * variables MUST be set before any of those three modules are required —
 * including transitively (app.js requires config; db.js requires config).
 * Because Node caches modules, the only safe way to guarantee env is set first
 * is to set it here, before any require call that pulls in config or db.
 *
 * @returns {{ app: import('express').Application, db: import('better-sqlite3').Database }}
 */
function loadApp() {
  // 1. Create a unique temp dir for this test run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-test-'));

  // 2. Point the app at the temp dir BEFORE requiring config, db, or app.
  //    config.js reads these at module-level, so env must be set first.
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = path.join(dir, 'test.db');

  // 3. Now it is safe to require the modules (they will read the env vars above).
  const app = require('../../src/app');
  const { db } = require('../../src/db');

  return { app, db };
}

/**
 * Seed the database with the minimum data needed to assert behavioral tests:
 * one task, one guest, and one non-taken-down submission joining them.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ taskId: number, guestId: number, submissionId: number }}
 */
function seed(db) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Selfie with the cake').lastInsertRowid;

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('seedtoken', 'Seed Guest').lastInsertRowid;

  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, 'p.jpg', 't.jpg').lastInsertRowid;

  return { taskId, guestId, submissionId };
}

module.exports = { loadApp, seed };
