// tests/source-text-helper.test.js
// Issue #939 AC1: unit coverage for tests/helpers/source-text.js's
// stripComments — the shared helper every source-text assertion in the ten
// in-scope test files now routes through. Covers exactly the three
// behavioral guarantees AC1 states: a comment-only literal disappears, a
// literal that also appears in code survives, and a literal that merely
// LOOKS like a comment delimiter inside a string/template/regex is never
// truncated.
'use strict';

const { stripComments } = require('./helpers/source-text');

describe('stripComments', () => {
  it('a literal that appears only inside a // comment is gone from the output', () => {
    const source = '// mentions TARGET_LITERAL in prose only\nconst x = 1;\n';
    expect(stripComments(source).indexOf('TARGET_LITERAL')).toBe(-1);
  });

  it('a literal that appears only inside a /* */ comment is gone from the output', () => {
    const source = '/* mentions TARGET_LITERAL in prose only */\nconst x = 1;\n';
    expect(stripComments(source).indexOf('TARGET_LITERAL')).toBe(-1);
  });

  it('a literal that appears in BOTH a comment and code survives at its code occurrence', () => {
    const source = '// TARGET_LITERAL is explained here\nconst TARGET_LITERAL = 5;\n';
    const stripped = stripComments(source);
    expect(stripped).toContain('const TARGET_LITERAL = 5;');
    // Exactly one occurrence left -- the comment's mention is gone, the
    // code's is not.
    expect(stripped.match(/TARGET_LITERAL/g).length).toBe(1);
  });

  it('a single-quoted string that looks like a comment opener survives intact', () => {
    const source = "const marker = '//not-a-comment';\n";
    expect(stripComments(source)).toContain("'//not-a-comment'");
  });

  it('a double-quoted string that looks like a block-comment opener survives intact', () => {
    const source = 'const marker = "/*not-a-comment*/";\n';
    expect(stripComments(source)).toContain('"/*not-a-comment*/"');
  });

  it('a template literal that looks like a comment opener survives intact', () => {
    const source = 'const marker = `/*still not a comment`;\n';
    expect(stripComments(source)).toContain('`/*still not a comment`');
  });

  it('a template literal with an interpolated expression survives, including a } inside ${...}', () => {
    const source = 'const s = `value: ${ { a: 1 }.a }`;\nconst y = 2;\n';
    const stripped = stripComments(source);
    expect(stripped).toContain('`value: ${ { a: 1 }.a }`');
    expect(stripped).toContain('const y = 2;');
  });

  it('a regex literal containing // survives intact and is not read as a line comment', () => {
    const source = 'const doubleSlash = /\\/\\//;\nconst after = 3;\n';
    const stripped = stripComments(source);
    expect(stripped).toContain('const doubleSlash = /\\/\\//;');
    expect(stripped).toContain('const after = 3;');
  });

  it('a real comment following code on the same line as a division is still stripped', () => {
    const source = 'const half = 10 / 2; // not a regex, this is a real comment\n';
    const stripped = stripComments(source);
    expect(stripped).toContain('const half = 10 / 2;');
    expect(stripped).not.toContain('not a regex');
  });

  it('code before and after a stripped comment is preserved verbatim (behavioral value, not just non-null)', () => {
    const source = 'function f() {\n  // step one\n  return 1;\n}\n';
    const stripped = stripComments(source);
    expect(stripped).toBe('function f() {\n  \n  return 1;\n}\n');
  });

  it('a /* */ comment inside a template interpolation is stripped', () => {
    const source = 'const s = `x: ${/* hides TARGET_LITERAL */ 1}`;\n';
    const stripped = stripComments(source);
    expect(stripped.indexOf('TARGET_LITERAL')).toBe(-1);
    expect(stripped).toContain('const s = `x: ${ 1}`;');
  });

  it('a // comment inside a template interpolation is stripped', () => {
    const source = 'const s = `x: ${\n  1 // hides TARGET_LITERAL\n}`;\nconst y = 2;\n';
    const stripped = stripComments(source);
    expect(stripped.indexOf('TARGET_LITERAL')).toBe(-1);
    expect(stripped).toContain('const y = 2;');
  });

  it('a nested template literal inside an interpolation survives intact', () => {
    const source = 'const s = `outer ${`inner ${1 + 1}`} tail`;\n';
    const stripped = stripComments(source);
    expect(stripped).toContain('`outer ${`inner ${1 + 1}`} tail`');
  });

  it('a ${}-free template with comment-looking content still survives byte-intact', () => {
    const source = 'const marker = `/*still not a comment`;\n';
    expect(stripComments(source)).toBe(source);
  });

  it('DOCUMENTED LIMITATION: a regex literal directly after `)` in statement position is not recognized, so its `/*` swallows following code (see header caveat in tests/helpers/source-text.js)', () => {
    const source = 'if (ok) /a\\/*b/.test(s);\nconst after = 3;\n';
    const stripped = stripComments(source);
    // The `/a\/*b/` regex is not detected here (regexAllowedHere does not
    // allow a regex directly after `)`, since that would break ordinary
    // division like `(a + b) / 2`), so its embedded `/*` is read as an
    // opening block comment and swallows everything up to the next `*/` --
    // which does not exist in this source, so it swallows to the end of the
    // file. This pins that known, accepted behavior; it is not a passing
    // grade for the input.
    expect(stripped).toBe('if (ok) /a\\');
    expect(stripped).not.toContain('const after = 3;');
  });

  it('a line comment before a CRLF line ending preserves the \\r\\n pair', () => {
    const source = 'const half = 10 / 2; // real comment\r\nconst after = 3;\r\n';
    const stripped = stripComments(source);
    expect(stripped).toBe('const half = 10 / 2; \r\nconst after = 3;\r\n');
  });
});
