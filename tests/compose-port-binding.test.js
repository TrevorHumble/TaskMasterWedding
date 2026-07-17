// tests/compose-port-binding.test.js
// Drift guard for issue #561: docker-compose.yml must publish container port
// 3000 bound to 127.0.0.1, never to 0.0.0.0 (the default when no host IP is
// given). Parses the checked-in YAML directly with a small regex helper
// (mirroring tests/deploy-artifacts.test.js's fs.readFileSync-based style,
// no yaml dependency installed) rather than shelling out to
// `docker compose config`, which merges any docker-compose.override.yml
// present on disk and would false-green on a box carrying the historical
// stand-up override even if the committed file still said "3000:3000".
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// A compose port entry has the form `[HOST_IP:]HOST_PORT:CONTAINER_PORT`.
// Returns the HOST_IP for the entry whose CONTAINER_PORT matches, or null if
// no host IP is present (the "3000:3000" bare form), or undefined if no
// entry for that container port exists at all.
function findHostIpForContainerPort(composeYaml, containerPort) {
  const target = String(containerPort);
  const lines = composeYaml.split('\n');
  let inPortsBlock = false;
  let portsIndent = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    // Enter the ports: block; leave it at the next key at the same or
    // shallower indentation, so only its own list entries are scanned (a
    // "- ...:3000" entry belonging to some other list can never false-match).
    if (line === 'ports:') {
      inPortsBlock = true;
      portsIndent = indent;
      continue;
    }
    if (inPortsBlock && !line.startsWith('-') && indent <= portsIndent) {
      inPortsBlock = false;
    }
    if (!inPortsBlock) continue;
    if (!line.startsWith('-')) continue;
    // Strip the leading "- " and surrounding quotes.
    const entry = line.replace(/^-\s*/, '').trim().replace(/^['"]/, '').replace(/['"]$/, '');
    const parts = entry.split(':');
    if (parts.length === 0) continue;
    const entryContainerPort = parts[parts.length - 1];
    if (entryContainerPort !== target) continue;
    if (parts.length >= 3) {
      // HOST_IP:HOST_PORT:CONTAINER_PORT
      return parts[0];
    }
    // HOST_PORT:CONTAINER_PORT — no host IP given, Docker defaults to 0.0.0.0.
    return null;
  }
  return undefined;
}

describe('findHostIpForContainerPort (fixture cases)', () => {
  it('returns null (no host IP) for the bare "3000:3000" form — the defect this issue removes', () => {
    const fixture = ['services:', '  app:', '    ports:', "      - '3000:3000'"].join('\n');
    expect(findHostIpForContainerPort(fixture, 3000)).toBeNull();
  });

  it('returns 127.0.0.1 for the "127.0.0.1:3000:3000" form', () => {
    const fixture = ['services:', '  app:', '    ports:', "      - '127.0.0.1:3000:3000'"].join(
      '\n'
    );
    expect(findHostIpForContainerPort(fixture, 3000)).toBe('127.0.0.1');
  });
});

describe('AC1/AC5: docker-compose.yml publishes port 3000 loopback-only', () => {
  const compose = fs.readFileSync(path.join(config.ROOT, 'docker-compose.yml'), 'utf8');

  it('binds the container-3000 mapping to host IP 127.0.0.1', () => {
    const hostIp = findHostIpForContainerPort(compose, 3000);
    expect(hostIp).toBe('127.0.0.1');
  });

  it('does NOT publish on 0.0.0.0 or leave the host IP absent', () => {
    const hostIp = findHostIpForContainerPort(compose, 3000);
    expect(hostIp).not.toBeNull();
    expect(hostIp).not.toBe('0.0.0.0');
  });

  it('AC5 negative case: the guard fails against the old bare "3000:3000" fixture', () => {
    const preFixCompose = ['services:', '  app:', '    ports:', "      - '3000:3000'"].join('\n');
    expect(findHostIpForContainerPort(preFixCompose, 3000)).not.toBe('127.0.0.1');
  });
});
