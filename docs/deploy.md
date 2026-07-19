# Deploy runbook

How to take Garden Party Pastels from a bare Linux host to serving guests over HTTPS, with data that survives a restart. See [`DESIGN.md`](../DESIGN.md) § Hosted deployment for why this shape was chosen; this file is the how-to.

## What you need

- **A small Linux host with a persistent disk** — a VPS (a droplet, a small EC2/Lightsail instance) or a PaaS plan that gives you a real, durable volume. SQLite and the uploaded photos live as plain files under `data/`; the persistent disk is what makes that safe.

  **Warning:** an ephemeral-filesystem platform — a default Heroku dyno, a Render free-tier service with no attached disk, any container host that wipes local storage on restart or redeploy — silently destroys the database and every wedding photo the next time the container restarts. Confirm your host gives you a disk that survives a restart before pointing guests at it.

- A domain name, so guests get a stable link and QR codes that do not change between printing and the party.
- Either Docker (Option A, recommended) or Node.js 20 installed directly on the host (Option B).

## Environment variables

Set these in a `.env` file in the project root (copy `.env.example`; the `.env` you create is gitignored and never committed).

| Variable                              | Required             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKIE_SECRET`                       | Yes                  | Signs the guest and admin cookies. Fixed, so restarts do not sign everyone out. Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`                                                                                                                                                                                                                                                                                                                                                               |
| `BASE_URL`                            | Yes                  | The public `https://` domain. The shared entry poster's QR code is built from this value — get it right before printing the poster.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NODE_ENV=production`                 | Yes                  | Turns on Secure cookies and production behavior throughout the app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TRUST_PROXY`                         | Yes (behind a proxy) | Set to `true` so Express reads the real guest IP from the reverse proxy's `X-Forwarded-For` header instead of the proxy's own address. Unset means "no proxy," which is wrong for every shape below.                                                                                                                                                                                                                                                                                                                                        |
| `PORT`                                | Option B only        | The port the bare Node process listens on. **Docker/Compose path (Option A): leave this unset.** The container always listens on 3000 internally; changing it there desyncs the image's `EXPOSE`/`HEALTHCHECK` from where the app actually listens, and the container restart-loops reporting unhealthy. To serve Option A on a different host port, edit the host side of `docker-compose.yml`'s `ports:` mapping instead — keep the `127.0.0.1:` prefix (e.g. `127.0.0.1:8080:3000`); dropping it republishes the app on every interface. |
| `DATA_DIR`                            | No                   | Overrides where the database, uploads, thumbnails, and admin hash live. Leave unset for the default (`./data`, bind-mounted in Option A).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `BACKUP_DIR`                          | No                   | Overrides where `scripts/backup.js` writes the database snapshots and the shared photo store. Leave unset for the default (`./backups`, bind-mounted in Option A).                                                                                                                                                                                                                                                                                                                                                                          |
| `BACKUP_RETENTION_COUNT`              | No                   | How many **database snapshots** under `BACKUP_DIR` a scheduled backup run keeps; older ones are pruned after each run that writes a new snapshot. Applies only to the timestamped DB snapshots — it never prunes `BACKUP_DIR/photos/`, the shared photo store, which has no retention setting at all (see Scheduled backups below). Unset keeps every DB snapshot forever, which is also the setting a real disk-budget calculation can least afford — see Scheduled backups before turning on a cron/timer schedule.                       |
| `MAINTENANCE`                         | No                   | Set to `1` or `true` to serve guests a 503 maintenance page while `/admin` stays reachable.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RATE_LIMIT_WINDOW_MS`                | No                   | Fixed window (ms) shared by every route-level rate limiter below (issue #283). Default `600000` (10 minutes).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `RATE_LIMIT_IP_MAX`                   | No                   | Per-IP cap on `POST /join` and `POST /login` (each has its own counter). Default `300` per window — sized to clear the whole ~100-guest list joining/logging in from one venue-NAT IP at once with headroom, while still stopping a scripted flood.                                                                                                                                                                                                                                                                                         |
| `RATE_LIMIT_UPLOAD_MAX`               | No                   | Per-guest cap, shared across `POST /tasks/:id/submit` and `POST /me/edit`. Default `20` per window.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RATE_LIMIT_SOCIAL_MAX`               | No                   | Per-guest cap on the lighter social writes — `POST /bug-report` (its own budget) and `POST /p/:id/like` + `POST /p/:id/comments` (a second, shared budget). Default `60` per window.                                                                                                                                                                                                                                                                                                                                                        |
| `RATE_LIMIT_TRACKED_MAX`              | No                   | Hard cap on how many distinct keys one rate limiter tracks at a time. Default `5000`. Bounds memory and per-request CPU under a flood from many distinct source IPs; over the cap, the key whose window expires soonest is evicted. Raise only if you expect more than 5000 distinct clients in one window.                                                                                                                                                                                                                                 |
| `GUEST_LOGIN_TRACKED_MAX`             | No                   | Hard cap on how many distinct normalized contacts the guest-login lockout tracker (`src/routes/auth.js`) holds at once. Default `5000`. Over the cap, the oldest contact NOT currently locked out is evicted first, so a flood of made-up contacts cannot un-lock a real one.                                                                                                                                                                                                                                                               |
| `ADMIN_LOGIN_MAX_CONCURRENT_COMPARES` | No                   | Bound on how many `bcrypt.compare` calls `POST /admin/login` runs AT ONCE (issue #543). Default `2`. Not a rate limiter — see `DESIGN.md`'s "No limiter on `POST /admin/login`, deliberately." An over-limit caller queues (never refused) rather than being rejected, so raising or lowering this only trades event-loop share for queue wait time; it does not change the login page's total request throughput.                                                                                                                          |

## Option A — Docker Compose

1. Clone the repository onto the host.
2. Copy `.env.example` to `.env` and fill in `COOKIE_SECRET`, `BASE_URL`, `NODE_ENV=production`, and `TRUST_PROXY=true`. Do not set `PORT` (see the table above).
3. Build and start:
   ```bash
   docker compose up -d --build
   ```
4. Set the admin password:

   ```bash
   docker compose exec app node scripts/set-admin-password.js <password>
   ```

   The script takes the password as a plain positional argument — it does not prompt. It rejects a weak password outright (exit code 1, no hash written) when the password:
   - is under 12 characters,
   - is the same character repeated (`aaaaaaaaaaaa`),
   - is a simple ascending or descending run (`abcdefghijkl`, `0123456789012`), or
   - matches a common base word with only trailing digits stripped (`password`, `welcome`, `admin`, `letmein`, `qwerty`, with or without trailing digits, e.g. `Password1234`).

   Pick something outside all four before the first attempt, so it does not fail mysteriously.

5. On first run, if the host's `node` user (uid 1000) does not already own `./data` and `./backups`, fix ownership so the container (which runs as `node`, not root) can write to the bind mounts:
   ```bash
   sudo chown -R 1000:1000 ./data ./backups
   ```
6. Set up the firewall — allow only SSH, HTTP, and HTTPS, and nothing else:
   ```bash
   sudo ufw allow 22/tcp    # SSH — allow this BEFORE enabling, or you lock yourself out
   sudo ufw allow 80/tcp    # HTTP (redirects to HTTPS)
   sudo ufw allow 443/tcp   # HTTPS
   sudo ufw enable
   ```
   `docker-compose.yml`'s `ports:` entry binds the app to `127.0.0.1:3000` (see the comment there), so port 3000 is never published to the outside interface in the first place. The firewall is defense in depth on top of that binding, not a substitute for it — Docker inserts its own iptables rules ahead of ufw's `INPUT` chain, so `ufw deny 3000` alone does **not** close a docker-published port. Confirm with the § "First-boot checklist" off-host check below.

## First data

The database schema and the badge catalog are created automatically the first time the app boots (`src/db.js`) — there is nothing to seed for a production event to start.

**Do not run `scripts/seed.js` or `scripts/seed-event.js` against production data.** Both are dev/demo fixtures: `seed.js` adds six sample tasks, and `seed-event.js` fabricates around 100 fake guests plus sample photos for load-testing. Running either against a live event pollutes it with data that was never real.

Real tasks and guests are created through the admin UI:

- `/admin/tasks` — create the scavenger-hunt tasks guests will complete.
- `/admin/guests` — create guests and generate their QR codes.

**Line to hold:** seed scripts are dev fixtures; the admin UI is production data. Never blur the two.

## Option B — bare Linux + systemd

1. Install Node.js 20+ and clone the repository.
2. Install dependencies: `npm ci --omit=dev`
3. Set `.env` as in the Environment variables section above — `PORT` may be set here if you need something other than 3000.
4. Create a systemd unit, e.g. `/etc/systemd/system/garden-party.service`:
   ```ini
   [Unit]
   Description=Garden Party Pastels
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/opt/garden-party-pastels
   ExecStart=/usr/bin/node src/app.js
   Restart=always
   Environment=NODE_ENV=production
   EnvironmentFile=/opt/garden-party-pastels/.env

   [Install]
   WantedBy=multi-user.target
   ```
5. Enable and start it:
   ```bash
   systemctl enable --now garden-party
   ```

`Restart=always` is systemd's version of what `scripts/serve-resilient.js` does for laptop/dev use — `serve-resilient.js` remains for that purpose but is not needed under systemd, which already restarts a crashed process.

## Reverse proxy + TLS

TLS terminates at the reverse proxy; the app itself keeps serving plain HTTP on `localhost` exactly as it does in development. In Option A, `docker-compose.yml` binds the published port to `127.0.0.1` (see the comment above its `ports:` entry), so this is enforced by the binding, not just by convention — nothing on the outside interface can reach the app directly.

**Caddy** (provisions and renews certificates automatically):

```
hunt.example.com {
    reverse_proxy localhost:3000
}
```

**nginx** (pair with certbot for certificates):

```
server {
    location / {
        proxy_pass http://localhost:3000;
    }
}
```

## First-boot checklist

1. Set the admin password (`scripts/set-admin-password.js`).
2. Create tasks through the admin UI. Guests need no admin setup — they join themselves at `/join`.
3. Confirm `BASE_URL` is the final public domain — the poster's QR code bakes it in.
4. Restart the app so `BASE_URL` takes effect if it was changed after first boot.
5. Print the entry poster (`/admin/poster`) — one page, shared by every guest.
6. Run one end-to-end test from a phone: scan the poster's QR code, sign up, complete a task, view the leaderboard.
7. **Blocks go-live if it fails:** find the port you actually published — the `HOST_PORT` segment of `docker-compose.yml`'s `ports:` entry (`3000` unless you remapped it per the `PORT` row above). From a device that is NOT the host (your phone on cellular data, a laptop off the venue network), confirm that port is not reachable at the host's raw IP, not the domain:
   ```bash
   curl http://<host-ip>:3000
   ```
   Replace `3000` with your published port if you remapped it. This must **fail to connect** (connection refused / timed out) — and it must be a refusal on the right port. A connection-refused on a port nothing is bound to is not evidence the app is unexposed: if you remapped the host port and curl the old `3000`, a clean refusal there proves nothing, because `3000` is simply not published anymore. The port you curl must be the one `docker-compose.yml`'s `ports:` entry actually publishes. If that port returns any HTTP response, the app is exposed in the clear beside the TLS site — stop and fix the `docker-compose.yml` `ports:` binding (it must keep the `127.0.0.1:` prefix, e.g. `127.0.0.1:3000:3000` or `127.0.0.1:8080:3000`, never a bare `3000:3000`) and the firewall step above before letting any guest near the poster.

## Push-button deploy and rollback

Once the site is live, shipping a fix or reverting a bad one is a **push-button deploy**: one script, `tools/deploy.sh`, invoked either by hand over SSH from your own laptop or by a GitHub Actions button — never automatically.

**Deliberately manual, not on every merge to `main`.** Once invitations go out, real guests are on this site for weeks and the wedding itself is a fixed date. A merge that rebuilds prod unattended — at 11pm, mid-reception, or while a guest is mid-upload — is a failure mode this event cannot absorb: `docker compose up -d` restarts the container, and `restart: unless-stopped` does not make that restart invisible. A human chooses the moment; nothing in this repo deploys on its own.

**Deploy a commit** (from your laptop, using your own SSH agent — no repo secret needed):

```bash
ssh <host> 'cd /srv/taskmasterwedding && tools/deploy.sh <commit>'
```

`<commit>` defaults to `origin/main` if you omit it. `tools/deploy.sh` runs on the host: it refuses to proceed if the checkout has uncommitted changes to tracked files (naming them, so a hand-edit on the box is never silently overwritten or shipped), fetches, checks out `<commit>`, rebuilds the image with that commit baked in as the `GIT_SHA` build argument, restarts the container, and polls `/healthz` (bounded, with a timeout) until it reports the exact commit you asked for — never printing success without verifying the app that came up actually matches.

**Rollback is the identical command with an older commit instead of a newer one** — there is no separate rollback procedure to remember or to get wrong under pressure:

```bash
ssh <host> 'cd /srv/taskmasterwedding && tools/deploy.sh <previous-commit-sha>'
```

**The GitHub Actions button.** `.github/workflows/deploy.yml` is a `workflow_dispatch`-only workflow (repo → Actions tab → "Deploy" → "Run workflow", with `commit` and `host` inputs) that SSHes in and runs the identical command above. Arming it needs **exactly one repo secret** (`SSH_PRIVATE_KEY`) **and exactly one repo variable** (`SSH_KNOWN_HOSTS`, the droplet's host key, captured once from your hosting provider's console — see [`DESIGN.md`](../DESIGN.md) § Hosted deployment for why it is pinned there rather than fetched at runtime). **Both are required — the button fails closed if either is missing.** The laptop command above needs neither; it authenticates with the operator's own SSH agent.

**Do not deploy during the reception.** A deploy restarts the container, and any request in flight at that moment is dropped. Ship a fix well before the event starts, or well after it ends — not while guests are actively uploading photos or checking the leaderboard.

## Logs

The app logs to stdout only — there is no file logging. Read logs with:

```bash
docker compose logs        # Option A
journalctl -u garden-party # Option B, unit name from your systemd file
```

## Backups

`scripts/backup.js` splits the database and the photos into two independent pieces, because they have opposite cadences (issue #558): the database changes minute to minute and is small; photos are write-once and can be large. Three modes:

```bash
node scripts/backup.js --db-only       # database snapshot (app.db + admin.hash) only, no photos
node scripts/backup.js --photos-only   # incremental photos only, no database snapshot
node scripts/backup.js                 # default: both
```

(Prefix with `docker compose exec app` for Option A.) Passing both flags together is rejected — the run exits non-zero rather than silently letting one win.

- `--db-only` writes a new timestamped folder under `BACKUP_DIR` (default `./backups`) with a WAL-safe snapshot of `app.db` plus the admin password hash.
- `--photos-only` (and the default run) copies any file in `uploads/`/`thumbs/` not already present, by name, into **one shared, append-only store** at `BACKUP_DIR/photos/{uploads,thumbs}` — never a fresh per-run copy. A photo is write-once, so "already at this name" means "already backed up"; a re-run only pays for what changed since the last one.

Before writing anything, every mode runs a **disk budget** check: it sizes exactly what that mode is about to copy, compares it to the free space on `BACKUP_DIR`, and aborts non-zero — naming the free bytes and the bytes needed, starting no copy at all — if there isn't room. See below for the numbers that check is protecting.

## Scheduled backups

A production host should not depend on a human remembering to run `scripts/backup.js`. Put it on the host's own scheduler — cron or a systemd timer — not an in-app `setInterval`, so a wedged app process cannot also silently stop backups.

**The disk budget.** `data/` (the live database and photos) shares one disk with `BACKUP_DIR`. What that disk must hold, once the backup schedule has run long enough to catch up, is:

```
photo-size + (retention + 1) x db-size
```

`photo-size` is the full live photo set, counted **once** — the shared store never keeps a second copy of a photo, so it does not multiply with retention. `db-size` is the live `app.db`; `retention` is `BACKUP_RETENTION_COUNT`; the `+1` is because a new snapshot briefly exists before the prune-after-success step deletes the oldest one down to `retention`. This is the number the disk-budget check enforces per run and the number to size a host against — **not** an unqualified "run it hourly" example: at even a modest few GB of wedding photos, an hourly cadence with a large retention count multiplies only the small `db-size` term, which is exactly the point of the split (the old, pre-#558 shape multiplied the whole photo set instead, and could fill a small host's disk outright).

**Split cadence, sized to a 60 GB host (the #544 droplet).** Run the cheap, frequent thing often; run the expensive, rare thing rarely:

**cron (Option B):**

```
*/15 * * * *  cd /srv/taskmasterwedding && /usr/bin/node scripts/backup.js --db-only     >> /var/log/tmw-backup.log 2>&1
17 3  * * *   cd /srv/taskmasterwedding && /usr/bin/node scripts/backup.js --photos-only >> /var/log/tmw-backup.log 2>&1
```

`app.db` is a few MB for this event's scale (~100 guests), so `--db-only` every 15 minutes costs almost nothing even at a generous retention. `--photos-only` (or a plain, flagless run) once a day at 3:17am is enough to keep the store caught up between events; running it more often only saves the size of that day's new photos, which the incremental store makes cheap either way.

**Docker Compose (Option A):** same schedule, prefixed with `docker compose exec -T app` instead of `/usr/bin/node`. The `-T` flag disables the pseudo-TTY that `docker compose exec` allocates by default, which cron's non-interactive environment doesn't have. The compose file already bind-mounts `./backups`, so both the snapshots and the shared photo store land on the host at the usual path.

**Retention.** Set `BACKUP_RETENTION_COUNT` in `.env` to the number of **database snapshots** to keep; each `--db-only` (or default) run prunes older ones down to that count after it finishes writing the new snapshot. This has no effect on `BACKUP_DIR/photos/` — the shared store is never pruned by this tool (see below). Unset keeps every DB snapshot forever, which is the setting the disk-budget formula above is least forgiving of — pick a number once a schedule is running:

```
# .env
BACKUP_RETENTION_COUNT=192
```

`192` matches the 15-minute `--db-only` cadence above with two days of history (`4 x 24 x 2`). Scale `retention` in the formula above to whatever cadence and history you choose — the database term stays cheap at almost any reasonable number, because `db-size` itself is small.

**Why the photo store has no retention setting.** Each photo lands in `BACKUP_DIR/photos/` exactly once, ever. Deleting from that store on any schedule would delete the only backup copy of a photo no longer in `uploads/` — the exact loss a backup exists to prevent. Removing a photo from the store is a deliberate, manual act (see the hard-takedown note under Restore below), not something a retention count should ever do automatically.

**Off-host copy.** A snapshot or the photo store on the same disk as `data/` protects against an app bug (a bad write, a corrupted table) — it does not protect against losing that disk, or the whole host, and it does not relieve how much local disk `BACKUP_DIR` itself needs (the disk-budget formula above is about the _local_ copy; this step is a second, independent copy elsewhere). Copy `BACKUP_DIR` (both the snapshots and `photos/`) somewhere else too:

- **rclone** (works with S3, Backblaze B2, Google Drive, and most other cloud storage — configure the remote once with `rclone config`, then):
  ```bash
  rclone sync ./backups remote:wedding-backups
  ```
  `rclone sync` is itself incremental — like the local photo store, a re-run only transfers what changed since the last sync — which is why it stays the real off-host safety net rather than a full re-upload every time. See [rclone's own docs](https://rclone.org/docs/) for configuring `remote`.
- **scp/rsync** (to a second host or NAS you control):
  ```bash
  rsync -a ./backups/ user@second-host:/srv/wedding-backups/
  ```

Add either as its own cron line after the backup jobs, offset a few minutes later so it copies finished files rather than ones mid-write.

## Restore

A restore combines two independent pieces (issue #558): the database comes from one chosen timestamped snapshot; the photos come from the single shared store, not from inside that snapshot.

1. Stop the app (`docker compose down` or `systemctl stop garden-party`).
2. Make sure `./data` is empty or does not exist — restoring on top of an existing `data/` overwrites it.
3. Delete any stale WAL files left from the prior run, then copy the chosen snapshot's `app.db` plus the shared store's `photos/` back into `./data`:
   ```bash
   mkdir -p data
   rm -f data/app.db-wal data/app.db-shm
   cp backups/<timestamp>/app.db data/app.db
   cp backups/<timestamp>/admin.hash data/admin.hash   # skip if the snapshot has none
   cp -r backups/photos/uploads data/uploads
   cp -r backups/photos/thumbs data/thumbs
   ```
4. Fix ownership if needed (Option A): `sudo chown -R 1000:1000 ./data`
5. Start the app again (`docker compose up -d` or `systemctl start garden-party`).

**Hard takedown vs. the shared store.** A **hard** takedown — a photo deleted from `uploads/` outright, not hidden by moderation — removes it from the live app but leaves it sitting in `BACKUP_DIR/photos/`, because the store is append-only by design (see Scheduled backups above). If you don't also delete that file from `BACKUP_DIR/photos/` by hand, the next restore copies it straight back into the live set. A moderation hide does not have this problem — it never touches `uploads/`, so there is nothing to remove from the store.
