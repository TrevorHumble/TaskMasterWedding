// src/utils/initials.js
// Derive a short initials string from a display name.
// Rules: take the first letter of the first word and the first letter of the
// last word (uppercased). If only one word, return just that letter.
// Handles extra whitespace, empty strings, and null/undefined without crashing.
'use strict';

/**
 * @param {string|null|undefined} name
 * @returns {string}  "Ava Fenwick" → "AF", "Cher" → "C", "" → ""
 */
function initials(name) {
  if (!name || typeof name !== 'string') return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  // Spread iterates code POINTS, not UTF-16 code units — indexing with [0]
  // would split a surrogate pair (emoji, astral-plane scripts) and return a
  // lone surrogate that renders as a broken glyph.
  const first = [...parts[0]][0].toUpperCase();
  if (parts.length === 1) return first;
  const last = [...parts[parts.length - 1]][0].toUpperCase();
  return first + last;
}

module.exports = initials;
