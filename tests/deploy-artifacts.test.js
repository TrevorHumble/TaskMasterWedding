// tests/deploy-artifacts.test.js
// Vitest tests for issue #286 (hosted-deploy artifacts): AC2-AC5 structural
// checks. Reads the shipped files with fs.readFileSync relative to
// config.ROOT and asserts the literal strings the acceptance criteria
// enumerate, mirroring tests/classify-dep-pr.test.js's pattern — this guards
// the artifacts against drift (a later edit silently dropping a literal the
// AC depends on) the same way that test guards the wedding-critical list.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

function readRoot(relativePath) {
  return fs.readFileSync(path.join(config.ROOT, relativePath), 'utf8');
}

describe('AC2: Dockerfile structural checks', () => {
  const dockerfile = readRoot('Dockerfile');

  it('contains FROM node:20-slim', () => {
    expect(dockerfile).toContain('FROM node:20-slim');
  });

  it('contains npm ci --omit=dev', () => {
    expect(dockerfile).toContain('npm ci --omit=dev');
  });

  it('contains USER node', () => {
    expect(dockerfile).toContain('USER node');
  });

  it('contains EXPOSE 3000', () => {
    expect(dockerfile).toContain('EXPOSE 3000');
  });

  it('contains a HEALTHCHECK line referencing /healthz', () => {
    // Edge case: presence-of-substring is not enough to prove the HEALTHCHECK
    // line itself references /healthz — a file could contain both tokens far
    // apart. Isolate the actual HEALTHCHECK instruction and assert /healthz
    // appears within it, so this test would fail if a future edit moved the
    // probe to a different endpoint while leaving the word HEALTHCHECK intact.
    const healthcheckLine = dockerfile
      .split('\n')
      .find((line) => line.trim().startsWith('HEALTHCHECK'));
    expect(healthcheckLine).toBeDefined();
    // HEALTHCHECK's CMD is on the following line (line continuation).
    const healthcheckIndex = dockerfile.split('\n').indexOf(healthcheckLine);
    const healthcheckBlock = dockerfile
      .split('\n')
      .slice(healthcheckIndex, healthcheckIndex + 2)
      .join('\n');
    expect(healthcheckBlock).toContain('/healthz');
  });

  it('contains CMD ["node", "src/app.js"]', () => {
    expect(dockerfile).toContain('CMD ["node", "src/app.js"]');
  });
});

describe('AC3: docker-compose.yml structural checks', () => {
  const compose = readRoot('docker-compose.yml');

  it('bind-mounts ./data:/app/data', () => {
    expect(compose).toContain('./data:/app/data');
  });

  it('bind-mounts ./backups:/app/backups', () => {
    expect(compose).toContain('./backups:/app/backups');
  });

  it('loads env_file', () => {
    expect(compose).toContain('env_file');
  });

  it('restarts unless-stopped', () => {
    expect(compose).toContain('restart: unless-stopped');
  });
});

describe('AC4: docs/deploy.md covers the required setup surface', () => {
  const deployDoc = readRoot(path.join('docs', 'deploy.md'));

  it.each([
    'COOKIE_SECRET',
    'BASE_URL',
    'NODE_ENV=production',
    'TRUST_PROXY',
    'set-admin-password',
    'persistent disk',
    'systemd',
  ])('contains the literal string %s', (literal) => {
    expect(deployDoc).toContain(literal);
  });

  it('contains a reverse-proxy example block (Caddy reverse_proxy or nginx proxy_pass)', () => {
    const hasCaddy = deployDoc.includes('reverse_proxy');
    const hasNginx = deployDoc.includes('proxy_pass');
    expect(hasCaddy || hasNginx).toBe(true);
  });
});

describe('AC5: .dockerignore keeps state and secrets out of the image', () => {
  const dockerignore = readRoot('.dockerignore');
  // Split into exact lines (not substring containment) so a line like
  // "node_modules/logging" could never falsely satisfy the "node_modules" AC —
  // the acceptance criterion is that these are their own ignore lines.
  const lines = dockerignore.split('\n').map((l) => l.trim());

  it.each(['data', 'backups', '.env', 'node_modules', 'coverage'])(
    'contains the line %s',
    (literal) => {
      expect(lines).toContain(literal);
    }
  );
});
