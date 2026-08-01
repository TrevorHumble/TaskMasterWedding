// tests/helpers/source-text.js
// Issue #939: shared comment stripper for tests that assert over backend JS
// source text (positional indexOf comparisons, negative/positive-presence
// checks, or regex extraction). Route every such read through stripComments
// so a comment added or reworded anywhere in the file can never flip a
// result, satisfy a positive-presence check, or shadow the real match a
// `.match`/`.indexOf` call is looking for. This replaces the private,
// less-complete stripper that used to live inline in
// tests/heic-conversion.test.js, leaving one JS comment stripper in the repo
// (tests/message-card.test.js has a separate EJS-comment stripper -- <%# %>
// syntax, a different concern).
//
// This is a single-pass character scanner, not a JS parser. It tracks just
// enough state (single/double-quoted strings, template literals with nested
// `${...}` expressions, regex literals, line comments, block comments) to be
// correct on this repo's own source files -- it makes no claim to handle
// every legal JS construct.
//
// Documented limitation: a regex literal written directly after `)` in
// statement position -- e.g. `if (ok) /a\/*b/.test(s);` -- is not recognized
// as a regex (see regexAllowedHere below; allowing regex after `)` would
// break ordinary division like `(a + b) / 2`), so its `/*` reads as an
// opening block comment and swallows following source. No file in this
// repo's src/ uses that shape (see the pinned case in
// tests/source-text-helper.test.js).
'use strict';

// Keywords after which a `/` starts a regex literal rather than meaning
// division -- e.g. `return /foo/` vs `a / b`. Checked against the last
// identifier-like token already emitted.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

// A `/` is the start of a regex literal (not division) unless it directly
// follows an identifier/number/`)`/`]` that isn't one of the keywords above
// -- good enough for this repo's own style, not a full parser. `out` is the
// output emitted so far by the calling scan, so the check looks at the last
// real token regardless of scan depth.
function regexAllowedHere(out) {
  const trimmed = out.replace(/\s+$/, '');
  if (trimmed === '') return true;
  const last = trimmed[trimmed.length - 1];
  if (/[a-zA-Z0-9_$)\]]/.test(last)) {
    const m = trimmed.match(/([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
    return Boolean(m && REGEX_PRECEDING_KEYWORDS.has(m[1]));
  }
  return true;
}

// Scans `source` from index `i`, stripping // and /* */ comments and
// passing strings/templates/regex through untouched. Recurses into a
// template literal's `${...}` interpolation with `stopAtBrace: true` --
// interpolation content is full code (it can hide a comment just like any
// other code can), so it gets the same stripping treatment as top-level
// source rather than being copied through verbatim.
//
// When `stopAtBrace` is true, the scan tracks `{`/`}` opened INSIDE the
// interpolation (e.g. an object literal such as `${ { a: 1 }.a }`) as extra
// depth so those aren't mistaken for the brace that closes the
// interpolation, and returns as soon as it sees that closing brace, without
// consuming it. When `stopAtBrace` is false (top-level source) the scan
// runs to the end of `source`; brace depth is still tracked but unused.
function scan(source, start, stopAtBrace) {
  let out = '';
  let i = start;
  const n = source.length;
  let braceDepth = 0;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (stopAtBrace && braceDepth === 0 && ch === '}') {
      return { result: out, end: i };
    }

    // Line comment -- drop through to (but not past) the newline, so a line
    // comment does not join its line to the next. A CRLF line ending stops
    // one character early, at the `\r`, so the `\r\n` pair survives intact
    // in the output instead of losing its `\r`.
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n' && !(source[i] === '\r' && source[i + 1] === '\n')) {
        i++;
      }
      continue;
    }

    // Block comment -- drop everything including embedded newlines. Safe to
    // run past the end of the string if unterminated (malformed input).
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Single/double-quoted string -- copied through untouched, so a literal
    // that merely looks like a comment delimiter ('//x', "/*") survives.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let str = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          str += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        str += source[i];
        i++;
      }
      str += source[i] || '';
      i++;
      out += str;
      continue;
    }

    // Template literal -- backtick-delimited text is copied through
    // untouched; a `${...}` interpolation is handed to a recursive scan
    // (comments stripped inside it, nested templates handled the same way
    // since a nested backtick re-enters this same branch).
    if (ch === '`') {
      let str = ch;
      i++;
      while (i < n) {
        if (source[i] === '`') {
          str += source[i];
          i++;
          break;
        }
        if (source[i] === '\\' && i + 1 < n) {
          str += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          str += '${';
          const sub = scan(source, i + 2, true);
          str += sub.result;
          str += '}';
          i = sub.end + 1; // consume the '}' the recursive scan stopped before
          continue;
        }
        str += source[i];
        i++;
      }
      out += str;
      continue;
    }

    // Regex literal -- copied through untouched (including a `//` or `/*`
    // inside it), so e.g. /\/\// is never mistaken for a comment opener.
    if (ch === '/' && regexAllowedHere(out)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '\n') break; // not actually a regex after all
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        j++; // consume the closing '/'
        while (j < n && /[a-z]/i.test(source[j])) j++; // flags
        out += source.slice(i, j);
        i = j;
        continue;
      }
      // Fall through: not a real regex (e.g. division) -- emit '/' plainly.
    }

    if (ch === '{') {
      braceDepth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth--;
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return { result: out, end: i };
}

function stripComments(source) {
  return scan(source, 0, false).result;
}

module.exports = { stripComments };
