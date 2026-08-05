// tests/memory-bonus-line.test.js
// Covers issue #1117 acceptance criteria — the .memory-bonus-line style rule
// that #1104's markup (src/views/memory-new.ejs) consumes:
//   AC1/AC3 — /memories/new renders the payoff line with the class and its
//             approved text, and the served guest.css pins the .memory-bonus-line
//             block to the three approved declarations (font-size, color, margin).
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');
const { fetchThemeCssOverHttp } = require('./helpers/theme-css');

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
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, 'Guest ' + token)
    .lastInsertRowid;
}

describe('AC1/AC3: /memories/new renders the payoff line with the approved class and text', () => {
  test('GET /memories/new as a signed-in guest carries <p class="memory-bonus-line"> with the approved copy', async () => {
    resetTables();
    insertGuest('bonus-line-token');

    const agent = signInGuest(app, 'bonus-line-token');
    const res = await agent.get('/memories/new');

    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<p class="memory-bonus-line">+1 point for the first 2 memories of each day</p>'
    );
  });
});

describe('AC1/AC3: the served guest.css pins the .memory-bonus-line block to the three approved declarations', () => {
  test('the .memory-bonus-line rule declares font-size, color, and the negative-margin title pull exactly as approved', async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    const selector = '.memory-bonus-line {';
    const ruleStart = body.indexOf(selector);
    expect(ruleStart).toBeGreaterThan(-1);

    const ruleEnd = body.indexOf('}', ruleStart);
    expect(ruleEnd).toBeGreaterThan(ruleStart);
    const rule = body.slice(ruleStart, ruleEnd);

    expect(rule).toContain('font-size: var(--fs-small);');
    expect(rule).toContain('color: var(--green-700);');
    expect(rule).toContain('margin: calc(-1 * var(--space-2)) 0 var(--space-4);');

    // A representative-vs-inverted check: swapping the tight-pull margin for
    // an ordinary positive one is NOT what shipped — confirms this assertion
    // can actually fail on wrong output, not just on missing output.
    expect(rule).not.toContain('margin: var(--space-2) 0 var(--space-4);');
  });

  test('no selector in the served stylesheet set carries the retired "PHASE-1 FAKE" wording for this rule', async () => {
    const { body } = await fetchThemeCssOverHttp(app);

    const selector = '.memory-bonus-line {';
    const ruleStart = body.indexOf(selector);
    expect(ruleStart).toBeGreaterThan(-1);

    // The nearest preceding comment block is this rule's own component
    // comment (AC1: a real component comment, no "PHASE-1 FAKE" wording).
    const commentStart = body.lastIndexOf('/*', ruleStart);
    const commentEnd = body.indexOf('*/', commentStart);
    const comment = body.slice(commentStart, commentEnd);

    expect(comment).not.toContain('PHASE-1 FAKE');
    expect(comment).toContain('src/views/memory-new.ejs');
  });
});
