---
description: /deploy [<commit>] — push-button deploy + rollback for lillyandaxel.com
---

# `/deploy` — push-button deploy + rollback

Wraps the #562 deploy runbook (`docs/deploy.md` § "Push-button deploy and rollback") so shipping a fix
or rolling back is one command instead of a `ssh` line reconstructed under pressure.

## What to do

1. **Timing guard — check this first, before anything else.** If it is currently event/reception time,
   or guests are actively uploading photos or checking the leaderboard, stop and warn the owner instead
   of deploying. The wedding is Friday, Aug 7, 2026. A deploy restarts the container
   (`docker compose up -d`) and drops any request in flight at that moment — see `docs/deploy.md`
   § "Do not deploy during the reception." Wait for an explicit go-ahead before continuing.

2. **Resolve the target.** `$ARGUMENTS` is the commit or ref to deploy. Empty means the newest
   `origin/main`; a specific SHA means deploy (or roll back to) exactly that commit.

3. **Deploy — run the exact #562 one-liner, never a re-implementation of its steps:**

   ```bash
   ssh root@lillyandaxel.com 'cd /srv/taskmasterwedding && tools/deploy.sh <target>'
   ```

   Log in as `root` — the deploy key lives there; a bare host SSHes as `runner`, which is denied.
   Give this command a generous timeout: `tools/deploy.sh` rebuilds the Docker image with `<target>`
   baked in, which takes minutes, not seconds.

   `tools/deploy.sh` refuses a dirty tree, polls `/healthz` until it reports the requested commit, and
   exits non-zero on a dirty tree, a healthz timeout, or a commit mismatch. **Report a non-zero exit
   verbatim to the owner and stop — do not retry blindly.** Retrying without reading the failure repeats
   whatever refused it the first time.

4. **Confirm and report the live version:**

   ```bash
   curl -fsS https://lillyandaxel.com/healthz
   ```

   Report the `commit` field back to the owner as what guests are seeing live right now.

## Notes

- **Rollback is the same command with an older commit:** `/deploy <old-sha>`. There is no separate
  rollback path.
- This command carries no secret and echoes none — it runs over the operator's own SSH agent, the same
  laptop path `docs/deploy.md` documents (no repo secret involved).
- **First-ever deploy of a brand-new script needs a one-time hand bootstrap on the box** (`git fetch &&
git checkout origin/main` run directly there) — the script can't arrive on the host by way of its own
  deploy. This command does not automate that; do it by hand once, then `/deploy` works from there on.
