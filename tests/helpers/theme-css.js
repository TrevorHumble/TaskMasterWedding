// tests/helpers/theme-css.js
// Issue #969: theme.css was split into contiguous, order-preserving slices
// under src/public/css/ (base.css, guest.css, feed.css, admin.css,
// admin-tasks.css today -- see DESIGN.md). This helper is the ONE place that reads them back
// as a single concatenated text, for the class-1 test files that used to
// read theme.css directly off disk and scan the whole thing.
//
// Sheet ORDER is derived by parsing src/views/partials/head.ejs's own
// <link rel="stylesheet" href="/css/*.css"> tags, in document order --
// head.ejs (the view the app actually serves) is the one owner of that
// order, so this helper (and the class-2 HTTP-fetch tests, which iterate
// this same exported list) can never drift from what a browser actually
// loads.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const HEAD_EJS_PATH = path.join(__dirname, '..', '..', 'src', 'views', 'partials', 'head.ejs');
const CSS_DIR = path.join(__dirname, '..', '..', 'src', 'public', 'css');

const LINK_RE = /<link rel="stylesheet" href="\/css\/([^"]+\.css)">/g;
// Total-occurrence counter for the fail-closed cross-check below -- deliberately
// a SEPARATE, simpler pattern from LINK_RE (no href-capture group, no /css/
// path anchor) so a stylesheet <link> this helper's own href-shaped regex
// fails to parse (e.g. a future attribute reordering, or an href pointing
// somewhere other than /css/*.css) still counts toward the total and trips
// the mismatch guard, instead of both patterns sharing the same blind spot.
const STYLESHEET_LINK_COUNT_RE = /<link rel="stylesheet"/g;

/**
 * The theme stylesheet filenames, in the exact order head.ejs links them --
 * parsed fresh on every call, so a head.ejs edit is picked up with no
 * separate step.
 *
 * Fails closed (PR review fix) rather than silently narrowing the
 * concatenation: cross-checks the count this function's own href-parsing
 * regex found against a second, independent count of every
 * `<link rel="stylesheet"` tag in head.ejs, and throws on a mismatch. A
 * partial parse (e.g. a future non-theme stylesheet link, or an href that
 * doesn't match the expected /css/*.css shape) would otherwise return a
 * SHORT list with no error, and every consumer of this list (readThemeCss's
 * concatenation, fetchThemeCssOverHttp's per-sheet fetch, the whole-sheet
 * class-2 guards) would then silently check less than the real theme
 * stylesheet set.
 * @returns {string[]} e.g. ['base.css', 'guest.css', 'feed.css', 'admin.css', 'admin-tasks.css']
 */
function themeSheetNames() {
  const headSource = fs.readFileSync(HEAD_EJS_PATH, 'utf8');
  const names = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(headSource))) {
    names.push(m[1]);
  }
  if (names.length === 0) {
    throw new Error('theme-css.js: found no theme stylesheet <link> tags in ' + HEAD_EJS_PATH);
  }
  const totalStylesheetLinks = (headSource.match(STYLESHEET_LINK_COUNT_RE) || []).length;
  if (names.length !== totalStylesheetLinks) {
    throw new Error(
      `theme-css.js: parsed ${names.length} theme stylesheet <link> href(s) but ` +
        `${HEAD_EJS_PATH} carries ${totalStylesheetLinks} <link rel="stylesheet"> tag(s) ` +
        `total -- refusing to return a possibly-partial sheet list.`
    );
  }
  return names;
}

/**
 * The full theme stylesheet, concatenated in head.ejs's own link order --
 * reproduces the pre-#969 theme.css's text exactly (the split is contiguous
 * and order-preserving, verified byte-identical to bd70cff's theme.css at
 * split time), so every existing whole-stylesheet scan keeps working over
 * the same total text.
 * @returns {string}
 */
function readThemeCss() {
  return themeSheetNames()
    .map((name) => fs.readFileSync(path.join(CSS_DIR, name), 'utf8'))
    .join('');
}

/**
 * The HTTP mirror of readThemeCss() (class-2 test coupling, issue #969): GET
 * every sheet from a running `app` instance, in head.ejs's own link order,
 * and return both the per-sheet supertest responses (so a caller can assert
 * a per-sheet contract, e.g. the cache-control header) and the concatenated
 * body text (so a whole-stylesheet guard — e.g. variant-stag.test.js's
 * :root/[data-theme='stag'] slicing, or a cascade-order guard spanning the
 * former theme.css's full text — has one span to search, exactly as it did
 * before the split). A single-sheet fetch can never stand in for a
 * whole-stylesheet guard: several existing assertions span rules that now
 * live in different sheets (e.g. variant-stag.test.js's `:root`'s
 * --badge-icon-color and .badge-picker-glyph, or its whole-sheet
 * --green-900 ink guard).
 * Asserts every fetched sheet responded 200 (PR review fix): a caller that
 * only inspects `body`/`responses[i].text` after a failed fetch (a 404 from
 * a stale sheet name, a 500 from the static middleware) would otherwise read
 * an empty or error-page string as if it were real CSS and could still pass
 * a text-content guard by accident -- restores the status anchor every one
 * of this helper's class-2 callers relied on before the sheets were fetched
 * through one shared function.
 * @param {import('express').Application} app
 * @returns {Promise<{names: string[], responses: import('supertest').Response[], body: string}>}
 */
async function fetchThemeCssOverHttp(app) {
  const names = themeSheetNames();
  const responses = [];
  for (const name of names) {
    const res = await request(app).get('/css/' + name);
    if (res.status !== 200) {
      throw new Error(`theme-css.js: GET /css/${name} returned ${res.status}, expected 200`);
    }
    responses.push(res);
  }
  return { names, responses, body: responses.map((r) => r.text).join('') };
}

module.exports = { readThemeCss, themeSheetNames, fetchThemeCssOverHttp };
