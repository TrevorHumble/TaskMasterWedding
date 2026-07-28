// tests/badge-icon-tags.test.js
//
// Issue #903 AC4: src/public/js/badge-icon-tags.js is a hand-authored data
// file (window.BadgeIconTags, one entry per catalog icon id) that
// badge-picker.js folds into its search filter. Nothing enforces at require
// time that the map still matches the catalog src/services/badge-icons.js
// owns, or that every entry's tags are well-formed -- an edit to either file
// could silently drift the two apart (a new catalog icon with no tags, a
// renamed id left orphaned in the tag map, a tag that stops being a lowercase
// trimmed string) with no other test able to catch it.
//
// badge-icon-tags.js has no DOM dependency -- it only assigns
// window.BadgeIconTags -- so it is loaded here by reading it as text and
// evaluating it with `new Function('window', src)` against a stub object,
// same idea as tests/badge-picker-script.test.js's jsdom harness but without
// needing jsdom at all for this file.
'use strict';

const fs = require('fs');
const path = require('path');
const badgeIcons = require('../src/services/badge-icons');

const BADGE_ICON_TAGS_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'badge-icon-tags.js'
);

// AC4's stated tag shape: lowercase, starts with a letter/digit, and only
// ever contains letters, digits, single spaces, apostrophes, ampersands, or
// hyphens after that.
const TAG_SHAPE = /^[a-z0-9][a-z0-9 '&-]*$/;

// AC4's stated display-name-word shape, used to decide which words of an
// icon's name must appear in its tags -- a punctuation-only "word" (e.g. the
// "&" in "Fork & Knife") is excluded rather than required to appear as a tag
// word.
const NAME_WORD_SHAPE = /^[a-z0-9][a-z0-9'-]*$/;

/**
 * Evaluate the real data file exactly as a browser would (a plain script
 * assigning to the global `window`), without needing jsdom -- the file has
 * no other DOM dependency. Returns the assigned map.
 */
function loadTagMap() {
  const src = fs.readFileSync(BADGE_ICON_TAGS_JS_PATH, 'utf8');
  const stubWindow = {};
  new Function('window', src)(stubWindow);
  return stubWindow.BadgeIconTags;
}

describe('badge-icon-tags.js data file coverage (issue #903 AC4)', () => {
  const tagMap = loadTagMap();
  const icons = badgeIcons.listIcons();

  it('evaluates to a plain object assigned as window.BadgeIconTags', () => {
    expect(tagMap).toBeTruthy();
    expect(typeof tagMap).toBe('object');
  });

  it("the tag map's key set equals the catalog's id set exactly (no missing, no orphan keys)", () => {
    const catalogIds = new Set(icons.map((ic) => ic.id));
    const tagIds = new Set(Object.keys(tagMap));

    const missing = [...catalogIds].filter((id) => !tagIds.has(id));
    const orphaned = [...tagIds].filter((id) => !catalogIds.has(id));

    expect(missing).toEqual([]);
    expect(orphaned).toEqual([]);
    // Belt-and-suspenders on top of the two empty-diff checks above: same
    // size rules out a key set that happens to match by coincidence.
    expect(tagIds.size).toBe(catalogIds.size);
  });

  it('every catalog icon has at least 15 tags', () => {
    for (const icon of icons) {
      const tags = tagMap[icon.id];
      expect(Array.isArray(tags)).toBe(true);
      expect(tags.length).toBeGreaterThanOrEqual(15);
    }
  });

  it('every tag is a lowercase, trimmed, non-empty string matching the allowed shape', () => {
    for (const icon of icons) {
      for (const tag of tagMap[icon.id]) {
        expect(typeof tag).toBe('string');
        expect(tag.length).toBeGreaterThan(0);
        expect(tag).toBe(tag.trim());
        expect(tag).toBe(tag.toLowerCase());
        expect(tag).toMatch(TAG_SHAPE);
      }
    }
  });

  it("no tag repeats within one icon's own list", () => {
    for (const icon of icons) {
      const tags = tagMap[icon.id];
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it('every display-name word appears as a whitespace-delimited word of at least one tag', () => {
    for (const icon of icons) {
      const tags = tagMap[icon.id];
      // Every whitespace-delimited word across every tag, e.g. the tag
      // 'heart hands' contributes both 'heart' and 'hands' -- an exact
      // single-word tag trivially contributes itself.
      const tagWords = new Set();
      for (const tag of tags) {
        for (const word of tag.split(/\s+/)) tagWords.add(word);
      }

      const nameWords = icon.name
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => NAME_WORD_SHAPE.test(word));

      for (const word of nameWords) {
        expect(tagWords.has(word)).toBe(true);
      }
    }
  });
});
