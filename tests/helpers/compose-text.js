// tests/helpers/compose-text.js
//
// Shared indentation-walker for reading a key out of the `app:` service
// block in docker-compose.yml's checked-in text. Extracted from
// tests/compose-port-binding.test.js's findAppServiceNetworkMode (issue
// #571), which read one scalar direct-child key (`network_mode:`); this
// generalization also reads a nested BLOCK child (e.g. `logging:` ->
// `driver` + `options` -> `max-size`/`max-file`), for issue #1023's
// log-rotation guard. Own coverage lives in
// tests/helpers/compose-text-helper.test.js (the fixture cases), matching
// the sibling precedent tests/helpers/source-text.js <->
// tests/source-text-helper.test.js.
//
// Parses the file text directly rather than shelling out to
// `docker compose config`: that merges any docker-compose.override.yml
// present on disk and would false-green on a box carrying a stand-up
// override even if the committed base file is correct (see DESIGN.md's
// "Drift guard reach, stated honestly (#571)"). tests/helpers/source-text.js's
// comment stripper is NOT used here -- it strips `//` comments, which would
// corrupt a YAML value containing "http://".
'use strict';

// Returns every line belonging to the `services: -> app:` block (strictly
// more indented than the `app:` key line itself), or undefined if no `app:`
// service is present under `services:`. Comment lines are included
// unfiltered -- callers that need to ignore them (to avoid an odd-indented
// comment, e.g. docker-compose.yml's own inline comments, being mistaken
// for a direct child) filter them out themselves via directChildIndent
// below, which is the actual fix for the bug this comment used to invite:
// an earlier version of this file derived the "direct child" indentation
// from serviceLines[0] -- the block's FIRST line -- rather than from the
// shallowest non-comment line, so a deeper-indented comment placed first
// under `app:` silently widened what counted as "direct", and a real
// direct child (e.g. `network_mode: host`) one level shallower than that
// comment was skipped entirely.
function findAppServiceBlock(composeYaml) {
  const lines = composeYaml.split('\n');
  let inServices = false;
  let servicesIndent = 0;
  let inAppService = false;
  let appKeyIndent = 0;
  const serviceLines = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (line === 'services:') {
      inServices = true;
      servicesIndent = indent;
      continue;
    }
    if (inServices && indent <= servicesIndent) {
      inServices = false;
    }
    if (!inServices) continue;
    if (!inAppService && line === 'app:') {
      inAppService = true;
      appKeyIndent = indent;
      continue;
    }
    if (inAppService && indent <= appKeyIndent) {
      inAppService = false;
    }
    if (!inAppService) continue;
    serviceLines.push(rawLine);
  }
  return serviceLines.length > 0 ? serviceLines : undefined;
}

// The indentation of this block's actual direct children: the shallowest
// indentation among its non-blank, non-comment lines. Deliberately ignores
// comment lines when computing this, so a comment indented DEEPER than the
// block's real children can never shift what "direct child" means.
//
// A comment indented at or shallower than the `app:` key itself is a
// different case this does not reach: findAppServiceBlock above ends its
// scan at the first line with `indent <= appKeyIndent`, so such a comment
// truncates the block before this function ever sees it. That behavior is
// unchanged from the pre-extraction walker, not something this helper
// introduced, and it is recorded here so a reader does not credit this
// function with a robustness it does not have.
//
// Returns null if `lines` has no non-comment content at all.
function directChildIndent(lines) {
  let min = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (min === null || indent < min) min = indent;
  }
  return min;
}

// Reads a direct scalar child key of the `app:` service, e.g.
// `network_mode: host`. Returns the trimmed, unquoted value, or undefined
// if the key is absent. YAML mappings are last-key-wins on a duplicate key,
// so if `key:` appears more than once at the direct-child level, the LAST
// occurrence wins here too -- this loop keeps overwriting `found` rather
// than returning on the first match.
function findAppServiceScalarKey(composeYaml, key) {
  const serviceLines = findAppServiceBlock(composeYaml);
  if (!serviceLines) return undefined;
  const childIndent = directChildIndent(serviceLines);
  if (childIndent === null) return undefined;
  let found;
  for (const rawLine of serviceLines) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent !== childIndent) continue;
    if (line.startsWith(`${key}:`)) {
      found = line.slice(`${key}:`.length).trim().replace(/^['"]/, '').replace(/['"]$/, '');
    }
  }
  return found;
}

// Parses the LAST direct-child occurrence of `key:` (a nested block, e.g.
// `logging:`) inside the `app:` service. Returns undefined if `key:` is not
// present at the direct-child level. Otherwise returns:
//   - values: a flat object of every `childKey: value` leaf pair found
//     anywhere inside the block, at any depth greater than the block's own
//     level (e.g. { driver: 'json-file', 'max-size': '20m', 'max-file': '5' }
//     for a `logging:` block with `driver` beside an `options:` wrapper).
//   - headers: the set of bare `someKey:` lines found at the level directly
//     under the block header (i.e. block-only children with no leaf value
//     of their own, such as `options:`) -- present so a caller can assert a
//     specific nested wrapper actually exists in the source text, not just
//     that its descendant leaf values happen to be present somewhere.
// Like findAppServiceScalarKey, a duplicate `key:` at the direct-child
// level is resolved last-occurrence-wins, matching real YAML semantics.
function parseAppServiceBlock(composeYaml, key) {
  const serviceLines = findAppServiceBlock(composeYaml);
  if (!serviceLines) return undefined;
  const childIndent = directChildIndent(serviceLines);
  if (childIndent === null) return undefined;

  let parsed;
  for (let i = 0; i < serviceLines.length; i++) {
    const rawLine = serviceLines[i];
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent !== childIndent || line !== `${key}:`) continue;

    // Collect this occurrence's body: every following line more indented
    // than childIndent, stopping at the next sibling (a line back at
    // childIndent or shallower) -- which may itself be a later duplicate
    // `key:` the outer loop will pick up and overwrite `parsed` with.
    const bodyLines = [];
    for (let j = i + 1; j < serviceLines.length; j++) {
      const bodyRaw = serviceLines[j];
      const bodyTrimmed = bodyRaw.trim();
      if (bodyTrimmed === '') continue;
      const bodyIndent = bodyRaw.length - bodyRaw.trimStart().length;
      if (bodyIndent <= childIndent) break;
      bodyLines.push(bodyRaw);
    }

    const levelIndent = directChildIndent(bodyLines);
    const values = {};
    const headers = new Set();
    for (const bodyRaw of bodyLines) {
      const bodyTrimmed = bodyRaw.trim();
      if (bodyTrimmed.startsWith('#')) continue;
      const m = bodyTrimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) continue;
      const [, childKey, rawValue] = m;
      const value = rawValue.trim();
      if (value === '') {
        // A bare "someKey:" with nothing after it is itself a block header
        // (e.g. "options:") introducing more deeply nested lines, not a
        // leaf value. Only record it as a structural header when it sits
        // directly under the block (not some deeper grandchild header).
        const bodyIndent = bodyRaw.length - bodyRaw.trimStart().length;
        if (bodyIndent === levelIndent) headers.add(childKey);
        continue;
      }
      values[childKey] = value.replace(/^['"]/, '').replace(/['"]$/, '');
    }
    parsed = { values, headers };
  }
  return parsed;
}

// Convenience wrapper over parseAppServiceBlock returning just the flat
// leaf-value object (see parseAppServiceBlock's `values` for the shape),
// or undefined if `key:` is absent at the direct-child level.
function findAppServiceBlockKey(composeYaml, key) {
  const parsed = parseAppServiceBlock(composeYaml, key);
  return parsed ? parsed.values : undefined;
}

// Returns the set of bare block-header children (e.g. 'options') found
// directly under `key:`'s own level, or undefined if `key:` is absent.
// Lets a caller assert a specific nested wrapper is structurally present
// in the source text -- e.g. that a `logging:` block actually nests its
// caps under `options:` rather than placing them as siblings of `driver`,
// which docker compose would reject even though the flattened leaf values
// would look identical either way.
function findAppServiceBlockHeaders(composeYaml, key) {
  const parsed = parseAppServiceBlock(composeYaml, key);
  return parsed ? parsed.headers : undefined;
}

module.exports = {
  findAppServiceScalarKey,
  findAppServiceBlockKey,
  findAppServiceBlockHeaders,
};
