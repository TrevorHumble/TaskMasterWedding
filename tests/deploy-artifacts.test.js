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

  describe('nginx server block literals (issue #936 drift guard)', () => {
    // Isolate the actual nginx fenced code block, the same way the Dockerfile
    // HEALTHCHECK test above isolates its instruction, rather than asserting
    // containment against the whole document. A literal that only survives in
    // surrounding prose (not in the block a host operator actually copies)
    // must go red here — whole-document `toContain` would pass either way.
    const fencedBlocks = deployDoc.split('```');
    const nginxBlock = fencedBlocks.find((block) => block.includes('proxy_pass'));

    it('finds the nginx fenced code block', () => {
      expect(nginxBlock).toBeDefined();
    });

    it('contains the literal client_max_body_size 160m', () => {
      // A future docs reflow that drops this line would silently reinstate
      // nginx's compiled-in 1m default, capping every phone-photo upload at
      // 1 MB with a bare 413 before the app ever runs. Pin the exact literal
      // rather than just "client_max_body_size" so a reflow that weakens the
      // value (e.g. down to the 1m default) also goes red.
      expect(nginxBlock).toContain('client_max_body_size 160m;');
    });

    it('contains the literal proxy_read_timeout 300s', () => {
      // Below this, a queued upload held past nginx's wait-for-response
      // window gets a bare 504 before the app ever answers.
      expect(nginxBlock).toContain('proxy_read_timeout 300s;');
    });

    it('contains the literal client_body_timeout 120s', () => {
      // Below this, a slow venue radio link can be cut off mid-upload before
      // the app or its upload slots are ever the bottleneck.
      expect(nginxBlock).toContain('client_body_timeout 120s;');
    });

    it('contains the X-Forwarded-For proxy_set_header line', () => {
      // Without this, the app's TRUST_PROXY=true reads every guest as the
      // same address (nginx's own), collapsing everyone into one
      // rate-limit bucket instead of one bucket per guest.
      expect(nginxBlock).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    });

    it('contains the X-Forwarded-Proto and Host proxy_set_header lines', () => {
      // Without X-Forwarded-Proto, req.protocol reports plain http for every
      // HTTPS guest; without Host, the app sees nginx's proxy_pass target
      // instead of the domain guests actually requested.
      expect(nginxBlock).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
      expect(nginxBlock).toContain('proxy_set_header Host $host;');
    });
  });

  describe('client_max_body_size derivation guard (issue #936)', () => {
    // Owner of the ceiling is src/services/photos.js. This catches the app
    // ceiling moving above the documented proxy cap — the drift direction
    // that produces a guest-visible 413 (the app would accept a batch nginx
    // rejects before the app ever sees it). Pattern precedent:
    // tests/avatar-upload-limit.test.js derives its assertion from the same
    // owner rather than re-stating the number.
    const photosSource = readRoot(path.join('src', 'services', 'photos.js'));

    const mbPerFileMatch = photosSource.match(/const MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024;/);
    const maxFilesMatch = photosSource.match(/const MEMORY_BATCH_MAX_FILES = (\d+);/);
    // Match inside the isolated nginx block, not the whole document — same
    // isolation reasoning as the literals suite above.
    const nginxBlock = deployDoc.split('```').find((block) => block.includes('proxy_pass'));
    const capMbMatch = nginxBlock.match(/client_max_body_size (\d+)m;/);

    it('finds all three source literals', () => {
      expect(mbPerFileMatch).not.toBeNull();
      expect(maxFilesMatch).not.toBeNull();
      expect(capMbMatch).not.toBeNull();
    });

    it('documented nginx cap covers the app worst-case batch size', () => {
      const mbPerFile = Number(mbPerFileMatch[1]);
      const maxFiles = Number(maxFilesMatch[1]);
      const capMb = Number(capMbMatch[1]);
      expect(capMb).toBeGreaterThanOrEqual(mbPerFile * maxFiles);
    });
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
