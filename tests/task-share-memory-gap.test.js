// tests/task-share-memory-gap.test.js
// Covers issue #471 acceptance criteria — visible separation between the
// task list and the "Share a memory" button on /tasks:
//   AC1 — theme.css declares a .task-share-memory rule with a margin-top
//         on the page's spacing scale (structural file-content check)
//   AC2 — /tasks for a guest with at least one to-do task renders exactly
//         one element with the full class list intact (behavioral check,
//         guards against the rule going stale against renamed markup)
//
// REQUIRE ORDER MATTERS: config / db / app are required only via loadApp() —
// see tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

function resetTables() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM guests').run();
}

function insertGuest(token) {
  return db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Guest ' + token).lastInsertRowid;
}

async function signedInAgent(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token);
  return agent;
}

const THEME_PATH = path.join(__dirname, '../src/public/css/theme.css');

describe('AC1: .task-share-memory declares top spacing in theme.css', () => {
  test('the rule exists and sets margin-top on the spacing scale (>= --space-4)', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const rule = themeSrc.match(/\.task-share-memory\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    // margin-top must come from the spacing scale, at least --space-4 (16px).
    const marginTop = rule[1].match(/margin-top:\s*var\(--space-(\d+)\)/);
    expect(marginTop).not.toBeNull();
    expect(parseInt(marginTop[1], 10)).toBeGreaterThanOrEqual(4);
  });
});

describe('AC2: the class still renders on the live /tasks button', () => {
  test('a guest with a to-do task gets exactly one fully-classed button', async () => {
    resetTables();
    const token = 'gap-token';
    insertGuest(token);
    // At least one incomplete task so the page takes the !allDone branch
    // (the allDone path renders .tasks-memory-cta instead of this button).
    db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)').run('Selfie with the cake');
    const agent = await signedInAgent(token);

    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);

    const matches = res.text.match(/class="btn btn-secondary btn-block task-share-memory"/g) || [];
    expect(matches).toHaveLength(1);
  });
});
