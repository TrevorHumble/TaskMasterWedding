// src/db/connection.js
// Single owner of the `db` handle (issue #969 AC2): the only src/db/
// internal with a module-load side effect (mkdir the data dir, open the
// database, apply pragmas). Every other internal acquires the handle
// through its own `db` parameter, passed in by the entry (src/db.js) — never
// a module-load `const { db } = require('./connection')` binding in an
// internal, which would pin a prior boot's handle inside a cached module
// (the class-4 test hazard: a second boot that evicts the entry and this
// file re-opens a fresh handle here, but a stale internal capture would keep
// querying the FIRST boot's now-stale connection).
'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../../config');

// Make sure the data directory exists before we try to open the DB file.
// (Section 01-setup also does this on boot, but we do it here too so that
//  running scripts/seed.js or this file directly never fails on a fresh clone.)
fs.mkdirSync(config.DATA_DIR, { recursive: true });

// Open the single SQLite database file (created automatically if missing).
const db = new Database(config.DB_PATH);

// Pragmas: safety + speed settings, applied every time the DB is opened.
// WAL = Write-Ahead Logging: better read/write concurrency and durability.
db.pragma('journal_mode = WAL');
// Foreign keys are OFF by default in SQLite; turn them ON so the
// REFERENCES ... ON DELETE CASCADE constraints below are enforced.
db.pragma('foreign_keys = ON');

module.exports = { db };
