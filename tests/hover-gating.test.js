// tests/hover-gating.test.js
// Covers issue #921: on a touch device, a tap triggers the emulated ":hover"
// state and it STICKS -- the tapped button or card keeps its hover ink until
// the guest taps somewhere else. The fix wraps every ":hover" rule across the
// themed stylesheets (see `tests/helpers/theme-css.js`'s `themeSheetNames()`)
// in `@media (hover: hover)`, plus an owner-approved `@media (hover: none)`
// always-visible treatment for `.admin-tile-actions` (that control depended
// on the sticky emulated-hover behavior to be reachable on a phone at all).
//
// AC1 needs nesting-aware parsing, not the flat indexOf block-read
// `tests/helpers/theme-css.js` / `tests/leaderboard-overflow.test.js` use --
// that flat read cannot tell what media block a rule sits inside. This file
// strips comments (and quoted strings) first, so a brace inside either one
// cannot perturb the walk -- base.css, feed.css, and guest.css each carry a
// "{" inside a prose comment today (documenting a browser default rule, e.g.
// "the UA's dialog:not([open]) { display: none }") -- then walks brace depth, keeping a
// stack of the @media conditions enclosing whatever is currently open, and
// checks every ":hover" rule's stack for "(hover: hover)".
//
// The two invariants the issue's implementation plan (step 4) assigns to this
// file are the AC1 gating walk and the AC2 always-visible assertion. Neither
// enumerates selectors or pins rule order -- new ":hover" rules added to any
// themed stylesheet in the future are covered automatically, and reordering
// existing rules cannot break either one (AC3's before/after preservation
// guarantee is instead the pre-commit `git diff` evidence, a PR-review
// artifact, not a committed assertion -- see the issue's implementation plan
// step 4 for why: after merge, HEAD is the post-change file and a committed
// before/after comparison would be vacuous).
//
// One further assertion names a selector outright: the AC3 check that the
// mixed group's ":focus-within" / ":has(.admin-fav-on)" members stay UNgated.
// That selector is the one the issue settles by name, so pinning its text is
// the point -- if it is rewritten, this test should be re-read, not silently
// keep passing against a rule that no longer exists.
'use strict';

const fs = require('fs');
const path = require('path');
const { themeSheetNames } = require('./helpers/theme-css');

const CSS_DIR = path.join(__dirname, '..', 'src', 'public', 'css');

const HOVER_SELECTOR_RE = /:hover\b/i;

/**
 * Strip everything that can hide a brace from the depth walk: block comments
 * first (a brace inside a comment must not open/close anything), then quoted
 * strings (emptied but re-quoted, so a brace inside e.g. a `content: '{'`
 * declaration -- none exist today, but the walk must not assume that --
 * can't perturb depth either). Comments are stripped BEFORE strings so an
 * apostrophe inside ordinary comment prose (guest's, owner's, don't) is never
 * mistaken for the open half of a quoted string.
 * @param {string} css
 * @returns {string}
 */
function stripCssNoise(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return noComments.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Walk a stylesheet's brace structure and return every top-level style rule
 * (selector list + declaration body + the list of @media conditions
 * enclosing it, outermost first). At-rules that are not `@media` (e.g. a
 * future `@supports`/`@keyframes`) still open/close a stack frame so depth
 * stays correct, but contribute no media condition.
 * @param {string} css
 * @returns {{selector: string, mediaConditions: string[], decl: string}[]}
 */
function collectRules(css) {
  const stripped = stripCssNoise(css);
  const rules = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      const header = buf.trim();
      buf = '';
      if (header.startsWith('@media')) {
        stack.push({ kind: 'media', condition: header.slice('@media'.length).trim() });
      } else if (header.startsWith('@')) {
        stack.push({ kind: 'at-rule' });
      } else {
        stack.push({ kind: 'rule', selector: header, start: i + 1 });
      }
      continue;
    }
    if (ch === '}') {
      if (stack.length === 0) {
        // A surplus "}" with nothing open is the other half of the
        // mis-tokenization case this function's closing guard exists to
        // catch (see below) -- silently no-op-ing here would let a
        // strip-then-walk bug that manifests as an extra "}" pass
        // undetected while its "too few closes" twin still throws.
        throw new Error('hover-gating.test.js: unmatched "}" with no open block');
      }
      const top = stack.pop();
      if (top.kind === 'rule') {
        const decl = stripped.slice(top.start, i);
        const mediaConditions = stack.filter((s) => s.kind === 'media').map((s) => s.condition);
        rules.push({ selector: top.selector, mediaConditions, decl });
      }
      buf = '';
      continue;
    }
    if (ch === ';' && stack.length === 0) {
      // A block-less at-rule statement (`@charset "UTF-8";`, `@import url(...);`)
      // ends in ";" with no "{"/"}" pair to reset `buf` for us. Without this
      // reset, its header text stays in `buf` and concatenates onto the NEXT
      // rule's header too -- e.g. `@charset "";.thing:hover` reads as one
      // combined header starting with "@" and gets misclassified as an
      // at-rule, silently dropping the real ":hover" rule that followed it
      // from the walk entirely. Only resets at depth 0 (outside every
      // block): a ";" terminating a declaration inside an open rule/media
      // body is harmless either way, since `buf`'s content there is already
      // discarded (the `buf = ''` above) the moment that block closes.
      buf = '';
      continue;
    }
    buf += ch;
  }
  // A well-formed stylesheet always balances -- a nonzero leftover stack
  // means the strip-then-walk pass mis-tokenized something (e.g. an
  // unterminated comment or string), which would otherwise silently produce
  // an incomplete rule list instead of a loud failure.
  if (stack.length !== 0) {
    throw new Error(`hover-gating.test.js: unbalanced braces after strip (depth ${stack.length})`);
  }
  return rules;
}

function readSheet(name) {
  return fs.readFileSync(path.join(CSS_DIR, name), 'utf8');
}

// Single owner for both gating predicates: the AC1 walk below and every
// guard test that proves a near-miss condition (negated, comma-listed) does
// NOT count as gating must all test the SAME regex. A private copy in a
// guard test would stay green after someone loosened the walk's own check,
// defeating the guard's entire purpose.
const HOVER_GATE_RE = /^\(\s*hover\s*:\s*hover\s*\)$/i;
const HOVER_NONE_GATE_RE = /^\(\s*hover\s*:\s*none\s*\)$/i;

// collectRules trims every condition before pushing it, so neither predicate
// re-normalizes what its producer already guarantees.
function isHoverGated(rule) {
  return rule.mediaConditions.some((cond) => HOVER_GATE_RE.test(cond));
}

function isHoverNoneGated(rule) {
  return rule.mediaConditions.some((cond) => HOVER_NONE_GATE_RE.test(cond));
}

describe('hover-only styles are gated behind @media (hover: hover) (#921)', () => {
  test('every ":hover" rule across the themed stylesheets sits inside an @media (hover: hover) block', () => {
    const ungated = [];
    for (const name of themeSheetNames()) {
      const rules = collectRules(readSheet(name));
      for (const rule of rules) {
        if (!HOVER_SELECTOR_RE.test(rule.selector)) continue;
        if (!isHoverGated(rule)) {
          ungated.push(`${name}: ${rule.selector}`);
        }
      }
    }
    // A single forgotten rule fails the test (AC1) -- report which one(s).
    expect(ungated).toEqual([]);
  });

  test('.admin-tile:focus-within / .admin-tile-actions:has(...) group stays ungated (AC3 non-hover exception)', () => {
    // AC3 requires this exact mixed selector group -- the non-":hover"
    // members that must NOT be wrapped in "(hover: hover)" -- stays reachable
    // without a hover event (focus-within for keyboard/AT users, :has() for
    // a favorited heart). Locate it by name rather than asserting some
    // generic "a non-hover rule exists somewhere", which would pass for any
    // non-empty corpus and prove nothing about this specific promise.
    const rules = collectRules(readSheet('admin.css'));
    const focusWithinRule = rules.find(
      (r) =>
        r.selector.replace(/\s+/g, ' ').trim() ===
        '.admin-tile:focus-within .admin-tile-actions, .admin-tile-actions:has(.admin-fav-on)'
    );
    expect(focusWithinRule).toBeDefined();
    expect(focusWithinRule.mediaConditions).toEqual([]);
  });

  test('.admin-tile-actions renders opacity: 1 on non-hover devices via @media (hover: none) in admin.css, with no hover/focus/:has() dependency', () => {
    const rules = collectRules(readSheet('admin.css'));
    const touchRule = rules.find(
      (r) => r.selector.trim() === '.admin-tile-actions' && isHoverNoneGated(r)
    );
    expect(touchRule).toBeDefined();
    expect(touchRule.decl).toMatch(/opacity:\s*1\b/);
    // The always-visible touch rule is its own bare selector, not grouped
    // onto the hover/focus/:has() reveal -- that grouping is exactly the
    // sticky-on-touch bug (AC2's "no hover, focus, or :has() dependency").
    expect(touchRule.selector).not.toMatch(/:hover|:focus-within|:has\(/);
  });

  test('an uppercase ":HOVER" selector is still detected (pseudo-classes are ASCII case-insensitive)', () => {
    const css = '.thing:HOVER { opacity: 1; }';
    const rules = collectRules(css);
    const hoverRule = rules.find((r) => HOVER_SELECTOR_RE.test(r.selector));
    expect(hoverRule).toBeDefined();
    expect(hoverRule.mediaConditions).toEqual([]);
  });

  test('a ":hover" rule following a block-less at-rule (e.g. "@charset ...;") is still detected, not swallowed into the at-rule header', () => {
    const css = '@charset "UTF-8";\n.thing:hover { opacity: 1; }';
    const rules = collectRules(css);
    const hoverRule = rules.find((r) => r.selector.trim() === '.thing:hover');
    // Before the depth-0 ";" reset in collectRules, `buf` never cleared
    // between the "@charset" statement and the next selector, so the
    // combined header ('@charset "";.thing:hover') started with "@" and was
    // classified as an at-rule -- `rules` would contain no entry for
    // ".thing:hover" at all, and its ungated ":hover" would never be seen.
    expect(hoverRule).toBeDefined();
    expect(hoverRule.mediaConditions).toEqual([]);
  });

  test('"@media not all and (hover: hover)" does not count as gating (negated condition)', () => {
    const css = '@media not all and (hover: hover) {\n.thing:hover { opacity: 1; }\n}';
    const rules = collectRules(css);
    const hoverRule = rules.find((r) => r.selector.trim() === '.thing:hover');
    expect(hoverRule).toBeDefined();
    expect(isHoverGated(hoverRule)).toBe(false);
  });

  test('"@media (hover: hover), (hover: none)" does not count as gating (comma list includes a non-gating branch)', () => {
    const css = '@media (hover: hover), (hover: none) {\n.thing:hover { opacity: 1; }\n}';
    const rules = collectRules(css);
    const hoverRule = rules.find((r) => r.selector.trim() === '.thing:hover');
    expect(hoverRule).toBeDefined();
    expect(isHoverGated(hoverRule)).toBe(false);
  });
});
