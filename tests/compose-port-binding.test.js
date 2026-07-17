// tests/compose-port-binding.test.js
// Issue #561 — docker-compose.yml must publish port 3000 loopback-only
// (`127.0.0.1:3000:3000`), not `3000:3000` (Docker binds an unqualified
// host side to 0.0.0.0, serving the app in the clear beside the TLS site).
// This is a config-drift guard over ONE mechanism: the `ports:` entries of
// the committed docker-compose.yml. It fails if those re-open the bind. It
// does not prove the app is unreachable — two known bypasses leave it green
// (both tracked in #571, neither fixable from this file):
//
//   - `network_mode: host` — Docker then ignores `ports:` entirely and the
//     app listens on the host's 0.0.0.0:3000, while the untouched
//     `- '127.0.0.1:3000:3000'` entry here still parses to '127.0.0.1'.
//   - a committed `docker-compose.override.yml` — Docker merges it on every
//     host, and this guard never reads it.
//
// Read this file as "the committed ports: entries are loopback-bound",
// nothing wider.
//
// Parses the checked-in YAML directly rather than shelling out to
// `docker compose config` — that command merges any local
// docker-compose.override.yml, so on a box carrying an override it would
// report 127.0.0.1 even if the committed file still said 0.0.0.0, a false
// green that would hide the exact defect this issue fixes (AC1's note).
//
// This repo has no YAML-parsing dependency (see package.json) and this
// issue does not add one — the parse below is a narrow, purpose-built
// reader of just the `ports:` list under the `app` service, not a general
// YAML parser, mirroring the hand-rolled parsing already used by
// tests/classify-dep-pr.test.js for its own drift guards.
//
// Parsing posture: FAIL CLOSED, at every level. Every LINE in the app's
// ports: block must be a recognized shape, and every entry's container port
// must be decidable — anything else throws rather than being skipped. This
// applies to lines, not just to entries: a line the reader drops takes its
// whole mapping with it, and a mapping the guard never sees is a silent
// false green (it publishes the app while the guard reports safe). Skipping
// what it does not understand is precisely how this guard shipped three
// separate false greens in review; an unrecognized shape must break the
// build and be handled here deliberately, never ignored by default.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const COMPOSE_FILE = 'docker-compose.yml';

function readRoot(relativePath) {
  return fs.readFileSync(path.join(config.ROOT, relativePath), 'utf8');
}

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

// Finds a bare `<keyName>:` key among the DIRECT children of the block
// opened at parentIdx. Direct-child depth is taken from the first real line
// under the parent, and a candidate must sit at exactly that depth — a
// deeper `app:` (e.g. a long-form `depends_on:` → `app:` → `condition:`
// under some other service) is not this block's child and must not match.
// Returns { idx, indent }, or { idx: -1 } when absent.
//
// parentIndent is derived from parentIdx rather than accepted from the
// caller: it is not caller-owned information, and taking it as a parameter
// would let a caller pass a value inconsistent with parentIdx, silently
// scanning the wrong block with no way for this function to notice.
function findDirectChildKey(lines, parentIdx, keyName) {
  const parentIndent = indentOf(lines[parentIdx]);
  let childIndent = -1;
  for (let i = parentIdx + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= parentIndent) break; // dedented out of the parent block
    childIndent = indent;
    break;
  }
  if (childIndent === -1) return { idx: -1, indent: -1 };

  const keyRe = new RegExp(`^\\s*${keyName}:\\s*$`);
  for (let i = parentIdx + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= parentIndent) break; // dedented out of the parent block
    if (indent === childIndent && keyRe.test(lines[i])) return { idx: i, indent };
  }
  return { idx: -1, indent: -1 };
}

// Returns the raw lines inside the `app` service's `ports:` block. Scoped to
// the app service specifically (not merely the first `ports:` key in the
// file) so the guard matches what its tests claim: a sibling service growing
// its own ports: entry must never shift which block is checked.
function appPortsBlockLines(yamlText) {
  const lines = yamlText.split(/\r?\n/);

  const servicesIdx = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (servicesIdx === -1) {
    throw new Error('No top-level `services:` key found in compose text');
  }

  const app = findDirectChildKey(lines, servicesIdx, 'app');
  if (app.idx === -1) {
    throw new Error('No `app:` service found as a direct child of `services:`');
  }

  const ports = findDirectChildKey(lines, app.idx, 'ports');
  if (ports.idx === -1) {
    throw new Error('No `ports:` key found under the `app` service');
  }

  const block = [];
  for (let i = ports.idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // blank: carries no indentation meaning
    // A YAML comment carries no indentation contract — it can sit at any
    // column, including flush-left. Two separate things follow, and
    // conflating them is what made this loop wrong:
    //
    //  1. A comment must never TERMINATE the scan. Read as a dedent, a
    //     flush-left `#` ends the block early and every mapping after it
    //     vanishes — the guard then reports safe on a published-wide file.
    //     Hence `continue`, never `break`, whatever its column.
    //  2. Only a comment INDENTED INTO the block is the block's content.
    //     portsBlockCommentText reads AC2's evidence out of these, so they
    //     must be kept (skipping them outright empties that check); but a
    //     flush-left comment trailing the last entry is not this block's
    //     documentation and is not admitted as such.
    //
    // extractPortEntries drops comments from entry parsing, so a kept
    // comment can never be mistaken for a mapping.
    if (line.trim().startsWith('#')) {
      if (indentOf(line) > ports.indent) block.push(line);
      continue;
    }
    if (indentOf(line) <= ports.indent) break; // dedented out of the ports: block
    block.push(line);
  }
  return block;
}

// Strips a YAML inline trailing comment and surrounding quotes from a list
// item's value. A quoted value is read to its matching closing quote, so a
// trailing `# loopback` note never ends up inside the parsed mapping and
// never leaves the quotes attached (which would fail AC1 on a safe file).
function unwrapListItemValue(raw) {
  const value = raw.trim();
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    const closingIdx = value.indexOf(quote, 1);
    if (closingIdx === -1) {
      throw new Error(`Unterminated quote in ports entry: ${raw}`);
    }
    return value.slice(1, closingIdx);
  }
  // Unquoted: a `#` preceded by whitespace opens a comment in YAML.
  const commentIdx = value.search(/\s#/);
  return (commentIdx === -1 ? value : value.slice(0, commentIdx)).trim();
}

// Returns the raw list-item strings (quotes and inline comments stripped)
// under the app service's `ports:` key.
//
// An unrecognized line THROWS rather than being skipped. Skipping is how a
// mapping goes invisible: compose's long syntax can put the dash on its own
// line —
//
//     ports:
//       - '127.0.0.1:3000:3000'
//       -
//         target: 3000
//         published: 8080
//
// — where the bare `-` matches no short-syntax item and the `target:` /
// `published:` lines carry no dash at all. Skipped, that entry vanishes
// entirely and the guard reports safe while Docker publishes container port
// 3000 on 0.0.0.0:8080 (long syntax defaults host_ip to 0.0.0.0). Throwing
// closes the whole class instead of one shape at a time.
function extractPortEntries(yamlText) {
  const entries = [];
  for (const line of appPortsBlockLines(yamlText)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // full-line comment, not a list item
    const item = trimmed.match(/^-\s*(.+)$/);
    if (!item) {
      throw new Error(
        `Unrecognized line in the app service's ports: block: ${JSON.stringify(line)}. ` +
          'Only `- <mapping>` short-syntax entries and full-line comments are supported. ' +
          'Extend this reader rather than letting the line be skipped — a skipped line is a false green.'
      );
    }
    entries.push(unwrapListItemValue(item[1]));
  }
  return entries;
}

// Returns every full-line comment inside the app service's `ports:` block —
// the "surrounding comment block" the implementation plan rewrites per AC2.
function portsBlockCommentText(yamlText) {
  return appPortsBlockLines(yamlText)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#'))
    .join('\n');
}

// A compose port mapping is HOST_IP:HOST_PORT:CONTAINER_PORT,
// HOST_PORT:CONTAINER_PORT, or a bare CONTAINER_PORT, each optionally
// carrying a /tcp|/udp|/sctp protocol suffix, and each port position
// optionally a RANGE (`8080-8081`). hostIp is null whenever the entry
// carries fewer than 3 colon-separated segments — Docker then defaults the
// host bind to 0.0.0.0, exactly the defect this guard exists to catch.
//
// The protocol suffix is stripped BEFORE splitting: left attached it rides
// along on the container-port segment ('3000/tcp'), which then compares
// unequal to '3000' and makes the mapping invisible to the port filter
// below — a shadow mapping the guard would silently pass over.
//
// An IPv6 host IP (`[::1]:3000:3000`) is NOT supported, by decision rather
// than oversight: it splits into more than 3 segments and throws
// "Unrecognized port mapping shape" below. That reds the build on a bind
// that is in fact safe, which is the right way round — a false red gets
// investigated, and it can never publish the app the way a skipped entry
// can. Extend this function if the deploy ever needs an IPv6 bind.
function parsePortMapping(entry) {
  // Long syntax (`- target: 3000`) is a mapping, not a string, and is not
  // supported by this reader. Say so rather than misparsing it into a
  // nonsense short-syntax mapping and asserting against the wreckage.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*:\s/.test(entry)) {
    throw new Error(
      `Long-syntax ports entry is not supported by this guard: ${entry}. ` +
        'Extend parsePortMapping to read target/published/host_ip before using it.'
    );
  }

  const withoutProtocol = entry.replace(/\/(tcp|udp|sctp)$/i, '');
  const parts = withoutProtocol.split(':');
  if (parts.length === 3) {
    return { hostIp: parts[0], hostPort: parts[1], containerPort: parts[2] };
  }
  if (parts.length === 2) {
    return { hostIp: null, hostPort: parts[0], containerPort: parts[1] };
  }
  if (parts.length === 1) {
    return { hostIp: null, hostPort: null, containerPort: parts[0] };
  }
  throw new Error(`Unrecognized port mapping shape: ${entry}`);
}

// Does a container-port SPEC publish `port`? The spec is a single port
// (`3000`) or an inclusive range (`3000-3001`) — a range covering 3000
// publishes the app just as an exact match does, and comparing the raw spec
// string to '3000' would not see it. Throws on any spec it cannot decide,
// so an unreadable shape fails the build instead of being skipped.
function containerSpecPublishes(spec, port) {
  const single = spec.match(/^(\d+)$/);
  if (single) return Number(single[1]) === port;

  const range = spec.match(/^(\d+)-(\d+)$/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    return port >= Math.min(low, high) && port <= Math.max(low, high);
  }

  throw new Error(
    `Unrecognized container port spec: ${JSON.stringify(spec)}. ` +
      'Extend containerSpecPublishes rather than letting it be skipped.'
  );
}

// Returns EVERY mapping publishing the given container port, not just the
// first. Returning one match would let a second, wider mapping for the same
// container port (a '127.0.0.1:3000:3000' entry followed by an '8080:3000'
// entry) sit unexamined behind a green assertion while Docker published the
// app on 0.0.0.0:8080 — the guard would bless the exact hole #561 closes.
// Every match must be checked.
function findMappingsForContainerPort(yamlText, containerPort) {
  const entries = extractPortEntries(yamlText).map(parsePortMapping);
  const matches = entries.filter((m) => containerSpecPublishes(m.containerPort, containerPort));
  if (matches.length === 0) {
    throw new Error(`No port mapping found for container port ${containerPort}`);
  }
  return matches;
}

// The assertion AC1 makes against the real file, factored out so the AC5
// fixture cases prove THIS guard's sensitivity rather than a parallel
// reimplementation that could drift from it. No redundant non-empty check:
// findMappingsForContainerPort already throws when nothing matches, so an
// assertion here could never fire and would only imply the empty case
// reaches this far.
function assertAllLoopback(yamlText) {
  for (const mapping of findMappingsForContainerPort(yamlText, 3000)) {
    expect(mapping.hostIp).toBe('127.0.0.1');
  }
}

describe('AC1: docker-compose.yml publishes port 3000 loopback-only', () => {
  it("every one of the app service's 3000 mappings has host IP 127.0.0.1", () => {
    assertAllLoopback(readRoot(COMPOSE_FILE));
  });
});

describe('AC2: the ports: comment records the reason', () => {
  it('contains the literal string 127.0.0.1', () => {
    expect(portsBlockCommentText(readRoot(COMPOSE_FILE))).toContain('127.0.0.1');
  });

  it('states the app is reached through the reverse proxy', () => {
    expect(/reverse proxy/i.test(portsBlockCommentText(readRoot(COMPOSE_FILE)))).toBe(true);
  });

  it('warns that a docker-published port is not closed by ufw', () => {
    // Case-insensitive, like its siblings above: AC2 is about the comment
    // stating the rule, not about where the sentence break falls. A reword
    // that opens a sentence with "Docker-published port ..." must not red
    // the build and read as a port-binding regression over a capital D.
    const commentBlock = portsBlockCommentText(readRoot(COMPOSE_FILE));
    expect(/docker-published port/i.test(commentBlock)).toBe(true);
    expect(/ufw/i.test(commentBlock)).toBe(true);
  });
});

describe('AC5: the drift guard actually guards (fixture cases)', () => {
  // Structured so AC5's negative case is assertable without mutating the
  // real file: the loopback-bound shape this issue ships, the bare exposed
  // shape it removes, and the shadow-mapping shapes that would slip past a
  // narrower guard are all exercised as in-test fixture strings.
  function fixture(portLines) {
    return [
      'services:',
      '  app:',
      '    build: .',
      '    ports:',
      ...portLines.map((l) => `      ${l}`),
      '    env_file: .env',
      '',
    ].join('\n');
  }

  const LOOPBACK_FIXTURE = fixture(["- '127.0.0.1:3000:3000'"]);
  const EXPOSED_FIXTURE = fixture(["- '3000:3000'"]);
  // Regression cases for the first-match-only defect: a safe-looking loopback
  // entry FOLLOWED by a second mapping republishing the same container port
  // on 0.0.0.0. Docker honors both; the guard must too. The `/tcp` variant is
  // the same hole wearing a protocol suffix — both are valid short syntax.
  const SHADOWED_FIXTURE = fixture(["- '127.0.0.1:3000:3000'", "- '8080:3000'"]);
  const SHADOWED_PROTOCOL_FIXTURE = fixture(["- '127.0.0.1:3000:3000'", "- '8080:3000/tcp'"]);
  // A host port RANGE whose container range covers 3000 publishes the app
  // just as an exact mapping does.
  const SHADOWED_RANGE_FIXTURE = fixture(["- '127.0.0.1:3000:3000'", "- '8080-8081:3000-3001'"]);

  it('the 127.0.0.1:3000:3000 form passes', () => {
    expect(() => assertAllLoopback(LOOPBACK_FIXTURE)).not.toThrow();
  });

  it('the bare 3000:3000 form fails the guard', () => {
    // A docker-compose.yml reverted to `- '3000:3000'` would fail the AC1
    // test exactly the way this fixture fails here. Pin the parse first, as
    // every sibling negative case does: assertAllLoopback signals failure BY
    // throwing, so a bare toThrow() alone could not tell "the guard caught
    // the exposed bind" from "the parser blew up before evaluating it" —
    // and this is the exact defect #561 exists to fix.
    expect(findMappingsForContainerPort(EXPOSED_FIXTURE, 3000)[0]).toMatchObject({
      hostIp: null,
      hostPort: '3000',
      containerPort: '3000',
    });
    expect(() => assertAllLoopback(EXPOSED_FIXTURE)).toThrow();
  });

  it('a loopback mapping SHADOWING a second 0.0.0.0 mapping for port 3000 fails the guard', () => {
    // The defect this shape catches: checking only the first match returns
    // the safe 127.0.0.1 entry and goes green, while Docker publishes
    // container port 3000 on 0.0.0.0:8080 and serves the app in the clear.
    const mappings = findMappingsForContainerPort(SHADOWED_FIXTURE, 3000);
    expect(mappings).toHaveLength(2);
    expect(mappings[1]).toMatchObject({ hostIp: null, hostPort: '8080', containerPort: '3000' });
    expect(() => assertAllLoopback(SHADOWED_FIXTURE)).toThrow();
  });

  it('a shadow mapping carrying a /tcp protocol suffix fails the guard', () => {
    // Left unstripped, the suffix rides along on the container port
    // ('3000/tcp'), compares unequal to '3000', and makes this mapping
    // invisible — green suite, app published on 0.0.0.0:8080.
    const mappings = findMappingsForContainerPort(SHADOWED_PROTOCOL_FIXTURE, 3000);
    expect(mappings).toHaveLength(2);
    expect(mappings[1]).toMatchObject({ hostIp: null, hostPort: '8080', containerPort: '3000' });
    expect(() => assertAllLoopback(SHADOWED_PROTOCOL_FIXTURE)).toThrow();
  });

  it('a shadow mapping using a port RANGE covering 3000 fails the guard', () => {
    const mappings = findMappingsForContainerPort(SHADOWED_RANGE_FIXTURE, 3000);
    expect(mappings).toHaveLength(2);
    expect(mappings[1]).toMatchObject({ hostIp: null, containerPort: '3000-3001' });
    expect(() => assertAllLoopback(SHADOWED_RANGE_FIXTURE)).toThrow();
  });

  it.each([
    ['0.0.0.0:3000:3000/tcp', '0.0.0.0'],
    ['3000:3000/udp', null],
  ])('the exposed form %s is caught (host IP %s)', (entry, expectedHostIp) => {
    const single = fixture([`- '${entry}'`]);
    expect(findMappingsForContainerPort(single, 3000)[0].hostIp).toBe(expectedHostIp);
    expect(() => assertAllLoopback(single)).toThrow();
  });

  it('an inline trailing comment does not break the parse of a safe mapping', () => {
    const withComment = fixture(["- '127.0.0.1:3000:3000' # loopback only"]);
    expect(findMappingsForContainerPort(withComment, 3000)).toEqual([
      { hostIp: '127.0.0.1', hostPort: '3000', containerPort: '3000' },
    ]);
    expect(() => assertAllLoopback(withComment)).not.toThrow();
  });

  it('an undecidable container port spec throws rather than being skipped', () => {
    // Fail-closed posture: a shape this reader cannot decide must break the
    // build, never be quietly filtered out into a green result.
    expect(() => findMappingsForContainerPort(fixture(["- '8080:not-a-port'"]), 3000)).toThrow(
      /Unrecognized container port spec/
    );
  });

  it('a long-syntax entry on one line (`- target: 3000`) throws rather than being misparsed', () => {
    expect(() => findMappingsForContainerPort(fixture(['- target: 3000']), 3000)).toThrow(
      /Long-syntax ports entry is not supported/
    );
  });

  it('a comment dedented inside the ports: block does not truncate it', () => {
    // A comment can sit at any column, including flush-left. Treating its
    // indent as a block delimiter ended the block early and silently dropped
    // every entry after it — here, the '8080:3000' that publishes the app on
    // 0.0.0.0. The comment must be ignored, not read as the block's end.
    const withDedentedComment = [
      'services:',
      '  app:',
      '    build: .',
      '    ports:',
      "      - '127.0.0.1:3000:3000'",
      '# debug: also expose publicly',
      "      - '8080:3000'",
      '    env_file: .env',
      '',
    ].join('\n');
    const mappings = findMappingsForContainerPort(withDedentedComment, 3000);
    expect(mappings).toHaveLength(2);
    expect(mappings[1]).toMatchObject({ hostIp: null, hostPort: '8080', containerPort: '3000' });
    expect(() => assertAllLoopback(withDedentedComment)).toThrow();
  });

  it('a long-syntax BLOCK entry (bare dash, keys on following lines) fails the guard', () => {
    // The shape that vanished entirely while the suite stayed green: the
    // bare `-` matches no short-syntax item, and target:/published: carry no
    // dash, so every line of the entry was skipped. Docker publishes
    // container port 3000 on 0.0.0.0:8080 here (long syntax defaults
    // host_ip to 0.0.0.0) — the guard must refuse to read this file at all
    // rather than report safe.
    const blockSyntax = fixture([
      "- '127.0.0.1:3000:3000'",
      '-',
      '  target: 3000',
      '  published: 8080',
    ]);
    expect(() => findMappingsForContainerPort(blockSyntax, 3000)).toThrow(
      /Unrecognized line in the app service's ports: block/
    );
    expect(() => assertAllLoopback(blockSyntax)).toThrow();
  });

  it("the parse is scoped to the app service, not a sibling service's ports:", () => {
    // A sibling service publishing its own 3000 must not be mistaken for the
    // app's mapping, and must not shift which block AC1 reads.
    const withSibling = [
      'services:',
      '  metrics:',
      '    image: example/metrics',
      '    ports:',
      "      - '3000:3000'",
      '  app:',
      '    build: .',
      '    ports:',
      "      - '127.0.0.1:3000:3000'",
      '    env_file: .env',
      '',
    ].join('\n');
    expect(findMappingsForContainerPort(withSibling, 3000)).toEqual([
      { hostIp: '127.0.0.1', hostPort: '3000', containerPort: '3000' },
    ]);
    expect(() => assertAllLoopback(withSibling)).not.toThrow();
  });

  it('a nested `app:` key under another service does not shadow the real app service', () => {
    // A long-form `depends_on:` naming `app:` is a deeper key, not a direct
    // child of `services:`; binding to it would read the wrong block.
    const withDependsOn = [
      'services:',
      '  proxy:',
      '    image: caddy',
      '    depends_on:',
      '      app:',
      '        condition: service_healthy',
      '  app:',
      '    build: .',
      '    ports:',
      "      - '127.0.0.1:3000:3000'",
      '    env_file: .env',
      '',
    ].join('\n');
    expect(findMappingsForContainerPort(withDependsOn, 3000)).toEqual([
      { hostIp: '127.0.0.1', hostPort: '3000', containerPort: '3000' },
    ]);
    expect(() => assertAllLoopback(withDependsOn)).not.toThrow();
  });
});
