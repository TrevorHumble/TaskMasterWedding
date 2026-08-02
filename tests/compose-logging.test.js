// tests/compose-logging.test.js
// Drift guard for issue #1023: the `app` service's docker-compose.yml
// logging cap (json-file, max-size 20m, max-file 5) must stay set, and
// docs/deploy.md's Logs section must quote the same values -- so the two
// cannot drift independently. Parses the checked-in YAML and Markdown text
// directly (fs.readFileSync), the same style as
// tests/compose-port-binding.test.js, rather than shelling out to
// `docker compose config`: that merges any docker-compose.override.yml
// present on disk and would false-green on a box carrying a stand-up
// override even if the committed base file is correct (see DESIGN.md's
// "Drift guard reach, stated honestly (#571)").
//
// The AC2 cross-check isolates the actual "Rotation cap" paragraph in
// docs/deploy.md and asserts the compose-shaped quoted literal
// (`max-size: '20m'`), the same way tests/deploy-artifacts.test.js's
// "nginx server block literals" describe isolates its own fenced block
// rather than doing a whole-document `toContain` -- a bare
// `toContain(logging['max-file'])` against a 391-line document would pass
// for the single digit '5' no matter what the document actually says (every
// digit 0-9 already occurs in the file), so it could never catch the doc
// drifting to a different value, or the paragraph being deleted outright.
// Helper coverage (fixture cases) lives in tests/compose-text-helper.test.js,
// not here -- this file only exercises the two real, in-repo artifacts.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { findAppServiceBlockKey, findAppServiceBlockHeaders } = require('./helpers/compose-text');

const compose = fs.readFileSync(path.join(config.ROOT, 'docker-compose.yml'), 'utf8');
const logging = findAppServiceBlockKey(compose, 'logging');
const loggingHeaders = findAppServiceBlockHeaders(compose, 'logging');

describe('AC1: docker-compose.yml caps the app service log with json-file rotation', () => {
  it('declares a logging: block on the app service', () => {
    expect(logging).toBeDefined();
  });

  it('uses the json-file driver with a 20m/5-file rotation cap', () => {
    expect(logging.driver).toBe('json-file');
    expect(logging['max-size']).toBe('20m');
    expect(logging['max-file']).toBe('5');
  });

  it('nests the caps under an options: wrapper, not as bare siblings of driver (docker compose requires this shape)', () => {
    expect(loggingHeaders).toEqual(new Set(['options']));
  });
});

describe('AC2: docs/deploy.md quotes the same rotation values as docker-compose.yml', () => {
  const deployDoc = fs.readFileSync(path.join(config.ROOT, 'docs', 'deploy.md'), 'utf8');
  // deploy.md is CRLF on disk (repo convention) -- split on a
  // line-ending-agnostic blank-line pattern so this does not silently stop
  // matching if the file's line endings ever change.
  const capParagraph = deployDoc.split(/\r?\n\r?\n/).find((p) => p.startsWith('**Rotation cap'));

  it('finds the Rotation cap paragraph in the Logs section', () => {
    // A future docs edit that deletes this paragraph must go red here, not
    // just leave the assertions below vacuously unreachable (both would
    // read `undefined`.toContain(...) and throw, not silently pass).
    expect(capParagraph).toBeDefined();
  });

  it('quotes the compose-shaped max-size literal, so the doc cannot silently disagree with compose', () => {
    expect(logging).toBeDefined();
    expect(capParagraph).toContain(`max-size: '${logging['max-size']}'`);
  });

  it('quotes the compose-shaped max-file literal, so the doc cannot silently disagree with compose', () => {
    expect(logging).toBeDefined();
    expect(capParagraph).toContain(`max-file: '${logging['max-file']}'`);
  });
});
