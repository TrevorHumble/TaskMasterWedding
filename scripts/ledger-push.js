// scripts/ledger-push.js — ledger-branch materialize/commit/push (#228).
//
// #219's harvester appends to governance/ledger.ndjson, but main's branch
// protection (PR required + 6 required checks, enforced for admins) rejects
// any direct CI push, and a GITHUB_TOKEN-created PR cannot trigger its own
// required checks. Rows therefore live on the dedicated `ledger` branch
// (force-pushes and deletion blocked — server-side append-only). The file
// path and the CI-only-writer rule are unchanged; a row is still never part
// of the tree it describes. See DESIGN.md "Governance ledger (#219)".
//
// Two modes, both run by .github/workflows/ledger.yml around the harvester:
//   --materialize  fetch <remote>/ledger; when the branch exists, write its
//                  governance/ledger.ndjson into the working copy so the
//                  harvester appends to the real current ledger.
//   --push         no-op (exit 0) when the working-copy ledger equals the
//                  remote branch copy AND no rendered BUILDLOG.md is present
//                  to add/change; otherwise commit onto branch `ledger`
//                  (based on the remote tip, or HEAD when the branch is new)
//                  and push it. Never touches main.
//
// BUILDLOG.md (#447): when scripts/buildlog-render.js has written a rendered
// BUILDLOG.md into the working copy (a workflow step run before --push),
// --push includes it in the SAME commit as governance/ledger.ndjson — the
// browsable per-merge log and the data it is rendered from can never be
// observed out of sync with each other on the ledger branch. Absent that
// file (e.g. a caller that never ran the renderer, or these tests), push()
// behaves exactly as before #447: ledger-only.
//
// Repo dir and remote are injectable (env LEDGER_REPO_DIR / LEDGER_REMOTE)
// so tests can drive a scratch repo with a local bare remote.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LEDGER_FILE = 'governance/ledger.ndjson';
const RENDERED_BUILDLOG_FILE = 'BUILDLOG.md';
const LEDGER_BRANCH = 'ledger';

function makeGit(repoDir) {
  return function git(args, opts) {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  };
}

// True when the remote has a `ledger` branch (after this call, its tip is
// available locally as FETCH_HEAD and refs/remotes/<remote>/ledger).
function fetchLedgerBranch(git, remote) {
  try {
    git(['fetch', remote, `${LEDGER_BRANCH}:refs/remotes/${remote}/${LEDGER_BRANCH}`, '--force']);
    return true;
  } catch {
    return false;
  }
}

function remoteFileContent(git, remote, filePath) {
  try {
    return git(['show', `refs/remotes/${remote}/${LEDGER_BRANCH}:${filePath}`]);
  } catch {
    return null;
  }
}

function remoteLedgerContent(git, remote) {
  return remoteFileContent(git, remote, LEDGER_FILE);
}

// --materialize: make the working copy start from the branch's current rows.
function materialize(repoDir, remote) {
  const git = makeGit(repoDir);
  if (!fetchLedgerBranch(git, remote)) {
    console.log(`ledger-push: no ${LEDGER_BRANCH} branch on ${remote}; keeping checked-out seed.`);
    return;
  }
  const content = remoteLedgerContent(git, remote);
  if (content === null) {
    console.log(`ledger-push: ${LEDGER_BRANCH} branch has no ${LEDGER_FILE}; keeping seed.`);
    return;
  }
  fs.mkdirSync(path.join(repoDir, path.dirname(LEDGER_FILE)), { recursive: true });
  fs.writeFileSync(path.join(repoDir, LEDGER_FILE), content);
  console.log(`ledger-push: materialized ${LEDGER_FILE} from ${remote}/${LEDGER_BRANCH}.`);
}

// --push: commit the (possibly appended) working-copy ledger onto the ledger
// branch and push. Builds the commit with plumbing (hash-object/mktree/
// commit-tree) so the checked-out branch, index, and working tree are never
// switched — the workflow stays on the main checkout throughout.
function push(repoDir, remote) {
  const git = makeGit(repoDir);
  const filePath = path.join(repoDir, LEDGER_FILE);
  if (!fs.existsSync(filePath)) {
    console.log(`ledger-push: no ${LEDGER_FILE} in working copy; nothing to push.`);
    return;
  }
  const working = fs.readFileSync(filePath, 'utf8');

  const buildlogPath = path.join(repoDir, RENDERED_BUILDLOG_FILE);
  const buildlogPresent = fs.existsSync(buildlogPath);
  const buildlogWorking = buildlogPresent ? fs.readFileSync(buildlogPath, 'utf8') : null;

  const branchExists = fetchLedgerBranch(git, remote);
  const remoteContent = branchExists ? remoteLedgerContent(git, remote) : null;
  const remoteBuildlogContent = branchExists
    ? remoteFileContent(git, remote, RENDERED_BUILDLOG_FILE)
    : null;

  const ledgerUnchanged = remoteContent !== null && remoteContent === working;
  const buildlogUnchanged =
    !buildlogPresent ||
    (remoteBuildlogContent !== null && remoteBuildlogContent === buildlogWorking);
  if (ledgerUnchanged && buildlogUnchanged) {
    console.log('ledger-push: no new rows, nothing to commit.');
    return;
  }

  // Parent commit: the remote branch tip when it exists, else HEAD (first
  // ledger commit branches off the current main checkout).
  const parent = branchExists
    ? git(['rev-parse', `refs/remotes/${remote}/${LEDGER_BRANCH}`]).trim()
    : git(['rev-parse', 'HEAD']).trim();

  // Tree = parent's tree with the ledger blob replaced, plus the rendered
  // BUILDLOG.md blob replaced when present in the working copy (#447 AC5),
  // via a temp index.
  const tmpIndex = path.join(repoDir, '.git-ledger-index');
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(['read-tree', parent], { env });
    const blob = git(['hash-object', '-w', '--', LEDGER_FILE]).trim();
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${LEDGER_FILE}`], { env });
    if (buildlogPresent) {
      const buildlogBlob = git(['hash-object', '-w', '--', RENDERED_BUILDLOG_FILE]).trim();
      git(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${buildlogBlob},${RENDERED_BUILDLOG_FILE}`,
        ],
        { env }
      );
    }
    const tree = git(['write-tree'], { env }).trim();
    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: 'governance-ledger[bot]',
      GIT_AUTHOR_EMAIL: 'governance-ledger@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'governance-ledger[bot]',
      GIT_COMMITTER_EMAIL: 'governance-ledger@users.noreply.github.com',
    };
    const commit = git(['commit-tree', tree, '-p', parent, '-m', 'ledger: append harvested rows'], {
      env: commitEnv,
    }).trim();
    git(['push', remote, `${commit}:refs/heads/${LEDGER_BRANCH}`]);
    console.log(`ledger-push: pushed ${commit.slice(0, 12)} to ${remote}/${LEDGER_BRANCH}.`);
  } finally {
    if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
  }
}

function main() {
  const mode = process.argv[2];
  const repoDir = process.env.LEDGER_REPO_DIR || process.cwd();
  const remote = process.env.LEDGER_REMOTE || 'origin';
  if (mode === '--materialize') {
    materialize(repoDir, remote);
  } else if (mode === '--push') {
    push(repoDir, remote);
  } else {
    console.error('ledger-push: usage: node scripts/ledger-push.js --materialize|--push');
    process.exit(1);
  }
}

module.exports = { materialize, push, LEDGER_FILE, LEDGER_BRANCH };

if (require.main === module) {
  main();
}
