# Deploy runbook

How to take Garden Party Pastels from a bare Linux host to serving guests over HTTPS, with data that survives a restart. See [`DESIGN.md`](../DESIGN.md) § Hosted deployment for why this shape was chosen; this file is the how-to.

## What you need

- **A small Linux host with a persistent disk** — a VPS (a droplet, a small EC2/Lightsail instance) or a PaaS plan that gives you a real, durable volume. SQLite and the uploaded photos live as plain files under `data/`; the persistent disk is what makes that safe.

  **Warning:** an ephemeral-filesystem platform — a default Heroku dyno, a Render free-tier service with no attached disk, any container host that wipes local storage on restart or redeploy — silently destroys the database and every wedding photo the next time the container restarts. Confirm your host gives you a disk that survives a restart before pointing guests at it.

- A domain name, so guests get a stable link and QR codes that do not change between printing and the party.
- Either Docker (Option A, recommended) or Node.js 20 installed directly on the host (Option B).

## Environment variables

Set these in a `.env` file in the project root (copy `.env.example`; the `.env` you create is gitignored and never committed).

| Variable                              | Required             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKIE_SECRET`                       | Yes                  | Signs the guest and admin cookies. Fixed, so restarts do not sign everyone out. Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`                                                                                                                                                                                                                                                                                                                                                                       |
| `BASE_URL`                            | Yes                  | The public `https://` domain. Guest QR codes are built from this value — get it right before printing place-cards.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NODE_ENV=production`                 | Yes                  | Turns on Secure cookies and production behavior throughout the app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TRUST_PROXY`                         | Yes (behind a proxy) | Set to `true` so Express reads the real guest IP from the reverse proxy's `X-Forwarded-For` header instead of the proxy's own address. Unset means "no proxy," which is wrong for every shape below.                                                                                                                                                                                                                                                                                                                                                |
| `PORT`                                | Option B only        | The port the bare Node process listens on. **Docker/Compose path (Option A): leave this unset.** The container always listens on 3000 internally; changing it there desyncs the image's `EXPOSE`/`HEALTHCHECK` from where the app actually listens, and the container restart-loops reporting unhealthy. To serve Option A on a different host port, edit the host-port segment of `docker-compose.yml`'s `ports:` mapping instead, keeping the `127.0.0.1` host IP (e.g. `127.0.0.1:8080:3000`) — never drop the host IP or widen it to `0.0.0.0`. |
| `DATA_DIR`                            | No                   | Overrides where the database, uploads, thumbnails, and admin hash live. Leave unset for the default (`./data`, bind-mounted in Option A).                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BACKUP_DIR`                          | No                   | Overrides where `scripts/backup.js` writes snapshots. Leave unset for the default (`./backups`, bind-mounted in Option A).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `BACKUP_RETENTION_COUNT`              | No                   | How many snapshots under `BACKUP_DIR` a scheduled backup run keeps; older ones are pruned after each run. Unset (`0`) keeps everything — see Scheduled backups below before turning on a cron/timer schedule.                                                                                                                                                                                                                                                                                                                                       |
| `MAINTENANCE`                         | No                   | Set to `1` or `true` to serve guests a 503 maintenance page while `/admin` stays reachable.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RATE_LIMIT_WINDOW_MS`                | No                   | Fixed window (ms) shared by every route-level rate limiter below (issue #283). Default `600000` (10 minutes).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RATE_LIMIT_IP_MAX`                   | No                   | Per-IP cap on `POST /join` and `POST /login` (each has its own counter). Default `300` per window — sized to clear the whole ~100-guest list joining/logging in from one venue-NAT IP at once with headroom, while still stopping a scripted flood.                                                                                                                                                                                                                                                                                                 |
| `RATE_LIMIT_UPLOAD_MAX`               | No                   | Per-guest cap, shared across `POST /tasks/:id/submit` and `POST /me/edit`. Default `20` per window.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RATE_LIMIT_SOCIAL_MAX`               | No                   | Per-guest cap on the lighter social writes — `POST /bug-report` (its own budget) and `POST /p/:id/like` + `POST /p/:id/comments` (a second, shared budget). Default `60` per window.                                                                                                                                                                                                                                                                                                                                                                |
| `RATE_LIMIT_TRACKED_MAX`              | No                   | Hard cap on how many distinct keys one rate limiter tracks at a time. Default `5000`. Bounds memory and per-request CPU under a flood from many distinct source IPs; over the cap, the key whose window expires soonest is evicted. Raise only if you expect more than 5000 distinct clients in one window.                                                                                                                                                                                                                                         |
| `GUEST_LOGIN_TRACKED_MAX`             | No                   | Hard cap on how many distinct normalized contacts the guest-login lockout tracker (`src/routes/auth.js`) holds at once. Default `5000`. Over the cap, the oldest contact NOT currently locked out is evicted first, so a flood of made-up contacts cannot un-lock a real one.                                                                                                                                                                                                                                                                       |
| `ADMIN_LOGIN_MAX_CONCURRENT_COMPARES` | No                   | Bound on how many `bcrypt.compare` calls `POST /admin/login` runs AT ONCE (issue #543). Default `2`. Not a rate limiter — see `DESIGN.md`'s "No limiter on `POST /admin/login`, deliberately." An over-limit caller queues (never refused) rather than being rejected, so raising or lowering this only trades event-loop share for queue wait time; it does not change the login page's total request throughput.                                                                                                                                  |

## Option A — Docker Compose

1. Clone the repository onto the host.
2. Copy `.env.example` to `.env` and fill in `COOKIE_SECRET`, `BASE_URL`, `NODE_ENV=production`, and `TRUST_PROXY=true`. Do not set `PORT` (see the table above).
3. Set up the firewall as in the [Firewall](#firewall) section below. This step is still required even though `docker-compose.yml` binds the app's port to `127.0.0.1`: it closes everything else a bare host exposes by default. It is not, by itself, what keeps port 3000 private — see the note below.
4. Build and start:
   ```bash
   docker compose up -d --build
   ```
5. Set the admin password:

   ```bash
   docker compose exec app node scripts/set-admin-password.js <password>
   ```

   The script takes the password as a plain positional argument — it does not prompt. It rejects a weak password outright (exit code 1, no hash written) when the password:
   - is under 12 characters,
   - is the same character repeated (`aaaaaaaaaaaa`),
   - is a simple ascending or descending run (`abcdefghijkl`, `0123456789012`), or
   - matches a common base word with only trailing digits stripped (`password`, `welcome`, `admin`, `letmein`, `qwerty`, with or without trailing digits, e.g. `Password1234`).

   Pick something outside all four before the first attempt, so it does not fail mysteriously.

6. On first run, if the host's `node` user (uid 1000) does not already own `./data` and `./backups`, fix ownership so the container (which runs as `node`, not root) can write to the bind mounts:
   ```bash
   sudo chown -R 1000:1000 ./data ./backups
   ```

**A firewall alone does not close port 3000.** `sudo ufw deny 3000` has no effect on a docker-published port. A published port is DNAT'd in the `nat` table's `PREROUTING` chain and the packet is then routed on to `FORWARD`, through Docker's own `DOCKER-USER`/`DOCKER` chains — it never traverses `INPUT`, which is where ufw's rules sit. ufw is bypassed entirely, not merely out-ordered, so do not go looking for Docker's rules in `INPUT`: they are not there, and the deny rule never sees the packet. The control that actually keeps `:3000` off the public internet is `docker-compose.yml` binding it to `127.0.0.1` (see the comment above its `ports:` entry); the [Firewall](#firewall) step hardens everything else on the host, it does not stand in for the loopback bind. See DESIGN.md § Hosted deployment.

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
4. Set up the firewall as in the [Firewall](#firewall) section below. Unlike Option A, there is no Docker-published port here to worry about — a plain `ufw deny <port>` works normally against a bare Node process, since nothing inserts iptables rules ahead of it.
5. Create a systemd unit, e.g. `/etc/systemd/system/garden-party.service`:
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
6. Enable and start it:
   ```bash
   systemctl enable --now garden-party
   ```

`Restart=always` is systemd's version of what `scripts/serve-resilient.js` does for laptop/dev use — `serve-resilient.js` remains for that purpose but is not needed under systemd, which already restarts a crashed process.

## Firewall

Both options need this, and this is the only copy of the allow-list — Option A and Option B each reference it rather than repeating it. Change it here.

Only the reverse proxy's ports should be reachable from outside. Allow SSH **before** enabling ufw, or you lock yourself out of your own host:

```bash
sudo ufw default deny incoming   # everything not allowed below is closed
sudo ufw allow 22/tcp            # SSH — allow this first
sudo ufw allow 80/tcp            # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp           # HTTPS
sudo ufw enable
```

**The first line is the control, not a formality.** The app's port is deliberately absent from the allow-list, so default-deny is what closes it — under Option B especially, where nothing else keeps that port shut. The bare Node process listens on **every** interface: `src/app.js` calls `app.listen(PORT)` with no host argument, so on an IPv6-capable host Node binds the dual-stack wildcard `::`, which is wider than `0.0.0.0` — IPv4 and IPv6 both. Default-deny therefore has to cover both families, and it does: ufw ships `IPV6=yes` in `/etc/default/ufw`, so `default deny incoming` applies to IPv6 as well as IPv4. Some provider images ship with `default allow incoming` pre-set; without that first line, `:3000` stays open on such a host even after the three allows and `ufw enable`.

If you run SSH on a non-standard port, allow that port instead of 22 — and confirm the rule is in place before `ufw enable`, in a second terminal you have already logged in on.

What this does not do differs by option: under Option A a firewall cannot close the app's port at all (see the note at the end of Option A), while under Option B a plain `ufw deny <port>` works normally. The app's own port never appears in the allow-list above either way — nothing outside the host should reach it directly.

## Reverse proxy + TLS

TLS terminates at the reverse proxy; the app itself keeps serving plain HTTP, exactly as it does in development.

**Which address the app is bound to depends on your option, and this matters for the firewall.** Under **Option A**, `docker-compose.yml` publishes the port on `127.0.0.1` only, so nothing off-host can reach the app directly. Under **Option B** there is no such bind: `src/app.js` calls `app.listen(PORT)` with no host argument, so the bare Node process listens on **every** interface (the dual-stack wildcard `::`, IPv4 and IPv6 both). An Option B host is therefore serving the app to the internet on `:3000` until the [Firewall](#firewall) step closes it — that step is not optional there, it is the only thing closing the port.

**Address the app as `127.0.0.1:3000`, not `localhost:3000`.** Under Option A the app is bound to `127.0.0.1` only — nothing is listening on `[::1]`. On a host whose `/etc/hosts` maps `localhost` to `::1` as well as `127.0.0.1`, nginx resolves both at config-parse time and round-robins between them, so roughly half of guest requests hit the unbound `[::1]:3000` and return 502. Writing the literal IPv4 address removes the ambiguity. (Caddy's Go dialer falls back to IPv4 and would survive `localhost`, but both examples use the explicit address so the next reader does not have to know that.)

**Caddy** (provisions and renews certificates automatically):

```
hunt.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** (pair with certbot for certificates):

```
server {
    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

## First-boot checklist

1. Set the admin password (`scripts/set-admin-password.js`).
2. Create tasks through the admin UI. Guests need no admin setup — they join themselves at `/join`.
3. Confirm `BASE_URL` is the final public domain — the poster's QR code bakes it in.
4. Restart the app so `BASE_URL` takes effect if it was changed after first boot.
5. **Prove port 3000 is not reachable from off-host. This step blocks go-live if it fails.** From a device that is NOT the host itself — your laptop on its own network, a phone on cellular data — run this against the host's **raw IP address**, not its domain name:

   ```bash
   curl http://<host-ip>:3000/healthz
   ```

   This must fail to connect (connection refused/timed out), not return a response. A `200` here means the app is still reachable in the clear on `:3000`, bypassing TLS and the reverse proxy entirely — do not print the poster or point guests at the domain until this fails.

   **Use the IP, not the domain — the domain can pass this check while the door is wide open.** If the domain sits behind a CDN or load balancer, it resolves to that proxy rather than to your host, so `curl` never reaches the origin at all: the connection fails, the step looks passed, and the origin's `<host-ip>:3000` keeps answering `200` in the clear. Only the raw IP tests the machine the app actually runs on. This is why the original report of this hole used the IP directly. Get the IP from your provider's console, or on the host with `curl -s ifconfig.me`.

   See the firewall + `docker-compose.yml` loopback-bind notes in Option A/B above and DESIGN.md § Hosted deployment for why both the firewall and the port binding matter here.

6. Print the entry poster (`/admin/poster`) — one page, shared by every guest.
7. Run one end-to-end test from a phone: scan the poster's QR code, sign up, complete a task, view the leaderboard.

## Logs

The app logs to stdout only — there is no file logging. Read logs with:

```bash
docker compose logs        # Option A
journalctl -u garden-party # Option B, unit name from your systemd file
```

## Backups

Run `scripts/backup.js` for a one-off snapshot (safe against a live database):

```bash
docker compose exec app node scripts/backup.js   # Option A
node scripts/backup.js                           # Option B
```

This writes a timestamped folder under `BACKUP_DIR` (default `./backups`) with a consistent copy of the database, the photo directories, and the admin password hash.

## Scheduled backups

A production host should not depend on a human remembering to run `scripts/backup.js`. Put it on the host's own scheduler — cron or a systemd timer — not an in-app `setInterval`, so a wedged app process cannot also silently stop backups.

**cron (Option B):**

```
17 * * * * cd /srv/taskmasterwedding && /usr/bin/node scripts/backup.js >> /var/log/tmw-backup.log 2>&1
```

Hourly, offset 17 minutes past the hour to avoid top-of-hour load on the host. Adjust the working directory to match your checkout.

**Docker Compose (Option A):**

```
17 * * * * cd /srv/taskmasterwedding && docker compose exec -T app node scripts/backup.js >> /var/log/tmw-backup.log 2>&1
```

The `-T` flag disables the pseudo-TTY that `docker compose exec` allocates by default, which cron's non-interactive environment doesn't have. The compose file already bind-mounts `./backups`, so snapshots land on the host at the usual path.

**Retention.** Set `BACKUP_RETENTION_COUNT` in `.env` to the number of snapshots to keep; each backup run prunes older ones down to that count after it finishes writing the new snapshot. Unset (the default) keeps every snapshot forever — fine for a laptop doing occasional manual backups, wrong for an hourly production schedule that would otherwise fill the disk over the weeks before the event.

```
# .env
BACKUP_RETENTION_COUNT=48
```

`48` matches an hourly schedule with two days of history. Scale it to your cadence — e.g. `14` for daily backups with two weeks of history.

**Off-host copy.** A snapshot on the same disk as `data/` protects against an app bug (a bad write, a corrupted table) — it does not protect against losing that disk, or the whole host. Copy `BACKUP_DIR` somewhere else too:

- **rclone** (works with S3, Backblaze B2, Google Drive, and most other cloud storage — configure the remote once with `rclone config`, then):
  ```bash
  rclone sync ./backups remote:wedding-backups
  ```
  See [rclone's own docs](https://rclone.org/docs/) for configuring `remote`.
- **scp/rsync** (to a second host or NAS you control):
  ```bash
  rsync -a ./backups/ user@second-host:/srv/wedding-backups/
  ```

Add either as its own cron line after the backup job, offset a few minutes later so it copies a finished snapshot rather than one mid-write.

## Restore

1. Stop the app (`docker compose down` or `systemctl stop garden-party`).
2. Make sure `./data` is empty or does not exist — restoring on top of an existing `data/` overwrites it.
3. Delete any stale WAL files left from the prior run, then copy the chosen snapshot's contents back into `./data`:
   ```bash
   mkdir -p data
   rm -f data/app.db-wal data/app.db-shm
   cp backups/<timestamp>/app.db data/app.db
   cp -r backups/<timestamp>/uploads data/uploads
   cp -r backups/<timestamp>/thumbs data/thumbs
   cp backups/<timestamp>/admin.hash data/admin.hash   # skip if the snapshot has none
   ```
4. Fix ownership if needed (Option A): `sudo chown -R 1000:1000 ./data`
5. Start the app again (`docker compose up -d` or `systemctl start garden-party`).
