#!/usr/bin/env bash
# tools/deploy.sh — push-button deploy + rollback (issue #562).
#
# Runs ON THE HOST, inside the checkout the caller has already cd'd into
# (e.g. /srv/taskmasterwedding) — never on the laptop. Contains no `ssh` and
# takes no host argument: the caller (a human at the keyboard, or
# .github/workflows/deploy.yml) SSHes in and runs this; this script never
# SSHes back out. See DESIGN.md § Hosted deployment and docs/deploy.md for
# the runbook, and data/wip-issues/562-pushbutton-deploy.md plan step 4 for
# the full "why on-box" rationale: git fetch/checkout and `docker compose`
# can only act where the checkout and the Docker daemon are.
#
# Usage: tools/deploy.sh [<target-commit-or-ref>]   (default: origin/main)
#
# Rollback is this SAME script pointed at an older commit — there is no
# separate rollback code path, so rollback is exercised by the same tests
# as a forward deploy (tests/deploy-script.test.js).
#
# This script never deletes data/ or backups/ under any flag — they are
# bind mounts holding every wedding photo (DESIGN.md, docs/deploy.md).
set -euo pipefail

TARGET="${1:-origin/main}"

# Overridable only for tests (tests/deploy-script.test.js, via a stub `docker`
# put earlier on PATH and a local HTTP server) — a real deploy always uses
# the default URL below: the on-box loopback probe AC4 requires
# (127.0.0.1:3000, matching #561's loopback-only publish — this is the only
# probe that reaches the app without going through the reverse proxy).
HEALTHZ_URL="${DEPLOY_HEALTHZ_URL:-http://127.0.0.1:3000/healthz}"
HEALTHZ_TIMEOUT_SECS="${DEPLOY_HEALTHZ_TIMEOUT_SECS:-60}"
HEALTHZ_POLL_INTERVAL_SECS="${DEPLOY_HEALTHZ_POLL_INTERVAL_SECS:-2}"

# --- AC3: refuse a dirty tree, BEFORE any fetch/build/pull runs. ------------
# `git status --porcelain` lines starting "??" are untracked files, which are
# not this check's concern (a hand-edit to a TRACKED file is the hazard: it
# would be silently overwritten by `git checkout` below, or silently shipped
# if checkout preserved it). Every other line means a tracked path is
# modified/staged/deleted, so filter untracked lines out and act on what's
# left.
dirty_paths="$(git status --porcelain | grep -v '^??' || true)"
if [ -n "$dirty_paths" ]; then
  echo "deploy.sh: refusing to deploy — the working tree has uncommitted changes to tracked files:" >&2
  echo "$dirty_paths" >&2
  exit 1
fi

echo "deploy.sh: fetching..."
git fetch

echo "deploy.sh: checking out $TARGET..."
git checkout "$TARGET"

# The exact commit checkout resolved TARGET to — this is what gets built,
# what gets reported as "requested", and what the live app's reported commit
# is compared against below. Resolving once here (rather than re-resolving
# TARGET again later) means a ref that moves mid-run (e.g. another `git push`
# to origin/main while this script is running) cannot make the deploy and the
# verification disagree about what "the target" meant.
resolved_sha="$(git rev-parse HEAD)"

echo "deploy.sh: building image for $resolved_sha..."
docker compose build --build-arg "GIT_SHA=$resolved_sha"

echo "deploy.sh: starting..."
docker compose up -d

# --- AC4: poll until healthy, bounded, then verify the commit it reports. ---
echo "deploy.sh: waiting for $HEALTHZ_URL to report healthy (timeout ${HEALTHZ_TIMEOUT_SECS}s)..."
elapsed=0
healthy_body=""
while [ "$elapsed" -lt "$HEALTHZ_TIMEOUT_SECS" ]; do
  if healthy_body="$(curl -fsS --max-time "$HEALTHZ_POLL_INTERVAL_SECS" "$HEALTHZ_URL" 2>/dev/null)"; then
    break
  fi
  healthy_body=""
  sleep "$HEALTHZ_POLL_INTERVAL_SECS"
  elapsed=$((elapsed + HEALTHZ_POLL_INTERVAL_SECS))
done

if [ -z "$healthy_body" ]; then
  echo "deploy.sh: FAILED — $HEALTHZ_URL never reported healthy within ${HEALTHZ_TIMEOUT_SECS}s." >&2
  exit 1
fi

# Pull the "commit" field out of the JSON body without a JSON parser — a
# narrow, purpose-built read of a known small shape, matching this repo's
# no-new-dependency posture for exactly this situation
# (tests/compose-port-binding.test.js's precedent).
live_commit="$(printf '%s' "$healthy_body" | grep -o '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"([^"]*)"$/\1/')"

if [ -z "$live_commit" ]; then
  echo "deploy.sh: FAILED — $HEALTHZ_URL responded but no commit field was found in: $healthy_body" >&2
  exit 1
fi

if [ "$live_commit" != "$resolved_sha" ]; then
  echo "deploy.sh: FAILED — live commit '$live_commit' does not match the requested target '$TARGET' ($resolved_sha)." >&2
  exit 1
fi

echo "deploy.sh: OK — deployed and verified. Live commit: $live_commit"
