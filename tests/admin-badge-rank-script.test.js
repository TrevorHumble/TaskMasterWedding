// tests/admin-badge-rank-script.test.js
// Issue #892 — the Rank & Award results-view redesign's CLIENT-SIDE state
// machine: src/public/js/admin-badge-rank.js's editing/baseline/isDirty
// model, driven against the REAL server-rendered markup. Mirrors
// tests/feed-likers-script.test.js's jsdom-driven pattern (render the real
// page via a real GET, load it into a synthetic document, stub the browser
// APIs jsdom does not implement, require the real script fresh, dispatch
// real events) rather than tests/badge-moment-script.test.js's
// hand-built-fixture pattern — this page's own markup (data-photos/
// data-winners/data-released JSON attributes baked in by admin.js) is
// exactly the contract worth proving against, not a hand-typed stand-in.
//
// Covers:
//   - AC1: a released task opens on the Results view — of the three foot
//     buttons (editBtn/cancelEditBtn/releaseBtn), only editBtn has
//     hidden === false; the grid reads "Photos", and a tile's
//     data-lightbox-photo carries the real photo_path.
//   - AC2: the results wall renders lightbox triggers, never pick controls.
//   - AC3: Edit ranking flips to the editor with Cancel alone (no Release —
//     nothing has changed yet).
//   - AC3: unpicking a winner makes the ranking dirty and Release reappears.
//   - AC4: Cancel restores the picked set/order to the released baseline and
//     returns to the Results view.
//   - AC5: emptying every winner while dirty relabels Release
//     "Release — no winners" (still shown, since dirty vs. an original
//     2-winner baseline).
//   - AC7: Release appears on a never-released task's very first pick.
//   - PR review, major: the Results view renders the AWARD TRUTH (WINNERS),
//     not the visibility-filtered editor model — a winner whose photo is
//     later taken down still shows in Results; edit mode still excludes it
//     from picks (it has no grid tile to toggle).
//   - AC8: the `.rank-award-foot .btn[hidden] { display: none }` stylesheet
//     rule this whole hidden-button contract depends on (jsdom does no
//     layout, so this is the only proof the CSS side of AC1/AC8 actually
//     holds — see this page's own view/script comments on why `.btn`'s own
//     `display` rule otherwise beats `[hidden]`).
//
// REQUIRE ORDER: config / db / app are only ever required (transitively, via
// loadApp()) after loadApp() sets DATA_DIR / DB_PATH — see
// tests/helpers/testApp.js's own header comment.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let taskBadges;
let adminAgent;

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('rank-script-token-' + guestSeq, name).lastInsertRowid;
}

function makeTask(title) {
  return db.prepare('INSERT INTO tasks (title, description) VALUES (?, ?)').run(title, '')
    .lastInsertRowid;
}

let subSeq = 0;
/**
 * @param {number} guestId
 * @param {number} taskId
 * @returns {{id: number, photoPath: string, thumbPath: string}}
 */
function makeSubmission(guestId, taskId) {
  subSeq += 1;
  const photoPath = `rs${subSeq}.jpg`;
  const thumbPath = `rst${subSeq}.jpg`;
  const id = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, photoPath, thumbPath).lastInsertRowid;
  return { id, photoPath, thumbPath };
}

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  taskBadges = require('../src/services/task-badges');
  adminAgent = await makeAdminAgent(app);
});

/**
 * Render the real Rank & Award page for `taskId` via a real GET, load it
 * into a fresh jsdom document, install window/document/navigator as globals
 * (admin-badge-rank.js reads the bare `document` global, matching
 * tests/feed-likers-script.test.js's own installation technique), stub the
 * two browser APIs jsdom does not implement that this script calls
 * (`Element.prototype.scrollIntoView`, called by the Edit-ranking handler;
 * `HTMLDialogElement.prototype.showModal`/`close`, defensive — this page
 * renders no dialog of its own, but the shared header partial's markup
 * does, and jsdom throws if anything ever touches it unstubbed), then
 * require the real script fresh so its listeners bind to THIS document.
 *
 * @param {number} taskId
 * @returns {Promise<{doc: Document, restore: Function}>}
 */
async function loadRankPage(taskId) {
  const res = await adminAgent.get('/admin/tasks/' + taskId + '/rank');
  expect(res.status).toBe(200);

  const dom = new JSDOM(res.text, { url: 'http://localhost/admin/tasks/' + taskId + '/rank' });

  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.Element.prototype.scrollIntoView = function () {};

  const keys = ['window', 'document', 'navigator'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });

  delete require.cache[require.resolve('../src/public/js/admin-badge-rank.js')];
  require('../src/public/js/admin-badge-rank.js');

  return {
    doc: dom.window.document,
    restore: function () {
      keys.forEach((key) => {
        if (saved[key]) {
          Object.defineProperty(global, key, saved[key]);
        } else {
          delete global[key];
        }
      });
    },
  };
}

function footState(doc) {
  return {
    editHidden: doc.getElementById('editBtn').hidden,
    cancelHidden: doc.getElementById('cancelEditBtn').hidden,
    releaseHidden: doc.getElementById('releaseBtn').hidden,
  };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true }));
}

it(
  'AC1/AC3/AC4/AC5: results view shows only Edit; Edit->Cancel alone; unpicking dirties and ' +
    'relabels Release; Cancel restores the released baseline',
  async () => {
    const taskId = makeTask('Script Test Task');
    const guestA = makeGuest('Script Test Guest A');
    const guestB = makeGuest('Script Test Guest B');
    const { id: subA, photoPath: photoA } = makeSubmission(guestA, taskId);
    const { id: subB } = makeSubmission(guestB, taskId);
    taskBadges.releaseRanking(taskId, [subA, subB]);

    const { doc, restore } = await loadRankPage(taskId);
    try {
      // --- AC1: Results view on load -------------------------------------
      expect(doc.getElementById('rankCardTitle').textContent).toBe('Results');
      expect(doc.getElementById('pickTitle').textContent).toBe('Photos');
      expect(doc.getElementById('awardedPill').hidden).toBe(false);
      // Of the three foot buttons, ONLY editBtn has hidden === false.
      expect(footState(doc)).toEqual({
        editHidden: false,
        cancelHidden: true,
        releaseHidden: true,
      });
      // The results wall renders lightbox triggers, never pick controls,
      // and the trigger's photo attribute is the real photo_path (the
      // full-resolution original lightbox.js prefixes with /uploads/ on
      // open) — never the thumbnail.
      const lightboxTiles = doc.querySelectorAll('#pickGrid .js-lightbox');
      expect(lightboxTiles.length).toBe(2);
      expect(doc.querySelectorAll('#pickGrid .pick-tile:not(.js-lightbox)').length).toBe(0);
      // Grid order is not asserted (the route sorts PHOTOS by created_at/id,
      // not by placement) — only that SOME tile carries the real photo_path,
      // not a thumb_path or a placeholder.
      const photoATile = Array.prototype.find.call(
        lightboxTiles,
        (t) => t.getAttribute('data-lightbox-photo') === photoA
      );
      expect(photoATile).toBeTruthy();

      // --- AC3: Edit ranking -> Cancel alone, nothing changed yet --------
      click(doc.getElementById('editBtn'));
      expect(doc.getElementById('rankCardTitle').textContent).toBe('Ranking');
      expect(doc.getElementById('pickTitle').textContent).toBe('Choose winners');
      expect(footState(doc)).toEqual({
        editHidden: true,
        cancelHidden: false,
        releaseHidden: true, // not dirty yet
      });
      // Edit mode's grid is pick tiles, not lightbox triggers.
      expect(doc.querySelectorAll('#pickGrid .js-lightbox').length).toBe(0);
      expect(doc.querySelectorAll('#pickGrid .pick-tile').length).toBe(2);

      // --- AC3: unpick one winner -> dirty -> Release reappears ----------
      const tiles = doc.querySelectorAll('#pickGrid .pick-tile');
      // subA is 1st place (is-first) — unpick it, leaving one winner.
      const firstTile = Array.prototype.find.call(tiles, (t) => t.classList.contains('is-first'));
      expect(firstTile).toBeTruthy();
      click(firstTile);

      expect(doc.getElementById('releaseBtn').hidden).toBe(false);
      expect(doc.getElementById('releaseBtn').textContent).toBe('Release badge & points');
      expect(doc.getElementById('cancelEditBtn').hidden).toBe(false);

      // --- AC5: unpick the LAST winner too -> empty but still dirty ------
      const remainingTile = doc.querySelector('#pickGrid .pick-tile.is-picked');
      expect(remainingTile).toBeTruthy();
      click(remainingTile);

      expect(doc.querySelectorAll('#pickGrid .pick-tile.is-picked').length).toBe(0);
      expect(doc.getElementById('releaseBtn').hidden).toBe(false); // still dirty (0 != baseline 2)
      expect(doc.getElementById('releaseBtn').textContent).toBe('Release — no winners');
      expect(doc.getElementById('rankEmpty').hidden).toBe(false);
      expect(doc.getElementById('rankEmpty').textContent).toBe(
        'Pick a photo above to start ranking.'
      );

      // --- AC4: Cancel restores the released baseline --------------------
      click(doc.getElementById('cancelEditBtn'));

      expect(doc.getElementById('rankCardTitle').textContent).toBe('Results');
      expect(footState(doc)).toEqual({
        editHidden: false,
        cancelHidden: true,
        releaseHidden: true,
      });
      const restoredRows = doc.querySelectorAll('#rankList .rank-winner');
      expect(restoredRows.length).toBe(2);
      // Order restored too: subA (1st) still leads.
      expect(restoredRows[0].getAttribute('data-id')).toBe(String(subA));
      expect(restoredRows[1].getAttribute('data-id')).toBe(String(subB));
    } finally {
      restore();
    }
  }
);

it('a never-released task opens straight in the editor with no Edit/Cancel buttons, and Release appears on the first pick', async () => {
  const taskId = makeTask('Script Test Never Released Task');
  const guestId = makeGuest('Script Test Never Released Guest');
  makeSubmission(guestId, taskId);

  const { doc, restore } = await loadRankPage(taskId);
  try {
    expect(doc.getElementById('rankCardTitle').textContent).toBe('Ranking');
    expect(doc.getElementById('awardedPill').hidden).toBe(true);
    expect(footState(doc)).toEqual({
      editHidden: true,
      cancelHidden: true, // never released -> nothing to cancel back to
      releaseHidden: true, // nothing picked yet
    });

    // AC7: the first pick on a never-released task is itself a "change"
    // from the empty baseline — Release appears immediately, no Edit step
    // needed (there was never a Results view to leave).
    const tile = doc.querySelector('#pickGrid .pick-tile');
    expect(tile).toBeTruthy();
    click(tile);

    expect(doc.getElementById('releaseBtn').hidden).toBe(false);
    expect(doc.getElementById('releaseBtn').textContent).toBe('Release badge & points');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// PR review, major: the Results view must render the AWARD TRUTH (WINNERS),
// not `picked` (seeded from WINNERS ∩ currently-visible photos) — a winner
// whose photo is taken down AFTER release still holds the badge/points
// (task-badges.js's currentRanking() LEFT JOINs submissions with no
// taken_down filter; its own doc comment: "the award row survives a
// takedown"). Before this fix, a single taken-down winner among several made
// the whole Results view read "No winners." while the guest still held the
// badge. Entering edit mode is the opposite case on purpose: a re-rank can
// only ever act on visible photos, so the taken-down winner has no grid tile
// and is correctly excluded from `picked`.
// ---------------------------------------------------------------------------
it('Results view lists a taken-down winner alongside the visible one; edit mode picks only the visible one', async () => {
  const taskId = makeTask('Script Test Takedown Task');
  const guestA = makeGuest('Script Test Takedown Guest A');
  const guestB = makeGuest('Script Test Takedown Guest B');
  const { id: subA } = makeSubmission(guestA, taskId);
  const { id: subB } = makeSubmission(guestB, taskId);
  taskBadges.releaseRanking(taskId, [subA, subB]);

  // subB's photo is taken down AFTER release.
  db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(subB);

  const { doc, restore } = await loadRankPage(taskId);
  try {
    // Results view: BOTH winner rows still render, in their released order.
    const resultRows = doc.querySelectorAll('#rankList .rank-winner');
    expect(resultRows.length).toBe(2);
    expect(Array.prototype.map.call(resultRows, (li) => li.getAttribute('data-id'))).toEqual([
      String(subA),
      String(subB),
    ]);
    expect(doc.getElementById('rankEmpty').hidden).toBe(true);

    // Edit mode: only the VISIBLE winner has a grid tile; the taken-down one
    // is excluded from `picked` entirely (releaseRanking would refuse
    // re-releasing an invisible id).
    click(doc.getElementById('editBtn'));
    expect(doc.querySelectorAll('#pickGrid .pick-tile').length).toBe(1);
    const editRows = doc.querySelectorAll('#rankList .rank-winner');
    expect(editRows.length).toBe(1);
    expect(editRows[0].getAttribute('data-id')).toBe(String(subA));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// AC8/CSS guardrail: the `.rank-award-foot .btn[hidden]` rule this whole
// hidden-button contract depends on. Same pull-a-rule-block-by-selector
// technique as tests/leaderboard-overflow.test.js's own CSS guardrail —
// jsdom does no layout, so this is the only proof available that a
// JS-hidden foot button actually paints hidden (root cause 1 of issue #892:
// `.btn`'s own `display` rule otherwise beats the UA's `[hidden]` rule).
// ---------------------------------------------------------------------------
describe('AC8: the .rank-award-foot .btn[hidden] guard exists in theme.css', () => {
  const THEME_PATH = path.join(__dirname, '../src/public/css/theme.css');

  function ruleBlock(source, selector) {
    const start = source.indexOf(selector + ' {');
    if (start === -1) return null;
    const end = source.indexOf('}', start);
    return source.slice(start, end + 1);
  }

  it('.rank-award-foot .btn[hidden] sets display: none', () => {
    const themeSrc = fs.readFileSync(THEME_PATH, 'utf8');
    const block = ruleBlock(themeSrc, '.rank-award-foot .btn[hidden]');
    expect(block).not.toBeNull();
    expect(block).toMatch(/display:\s*none/);
  });
});
