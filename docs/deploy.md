# Deploy runbook

How to take Garden Party Pastels from a bare Linux host to serving guests over HTTPS, with data that survives a restart. See [`DESIGN.md`](../DESIGN.md) § Hosted deployment for why this shape was chosen; this file is the how-to.

## What you need

- **A small Linux host with a persistent disk** — a VPS (a droplet, a small EC2/Lightsail instance) or a PaaS plan that gives you a real, durable volume. SQLite and the uploaded photos live as plain files under `data/`; the persistent disk is what makes that safe.

  **Warning:** an ephemeral-filesystem platform — a default Heroku dyno, a Render free-tier service with no attached disk, any container host that wipes local storage on restart or redeploy — silently destroys the database and every wedding photo the next time the container restarts. Confirm your host gives you a disk that survives a restart before pointing guests at it.

- A domain name, so guests get a stable link and QR codes that do not change between printing and the party.
- Either Docker (Option A, recommended) or Node.js 20 installed directly on the host (Option B).

## Environment variables

Set these in a `.env` file in the project root (copy `.env.example`; the `.env` you create is gitignored and never committed).

| Variable              | Required             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKIE_SECRET`       | Yes                  | Signs the guest and admin cookies. Fixed, so restarts do not sign everyone out. Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`                                                                                                                                                                                                                                               |
| `BASE_URL`            | Yes                  | The public `https://` domain. Guest QR codes are built from this value — get it right before printing place-cards.                                                                                                                                                                                                                                                                                                          |
| `NODE_ENV=production` | Yes                  | Turns on Secure cookies and production behavior throughout the app.                                                                                                                                                                                                                                                                                                                                                         |
| `TRUST_PROXY`         | Yes (behind a proxy) | Set to `true` so Express reads the real guest IP from the reverse proxy's `X-Forwarded-For` header instead of the proxy's own address. Unset means "no proxy," which is wrong for every shape below.                                                                                                                                                                                                                        |
| `PORT`                | Option B only        | The port the bare Node process listens on. **Docker/Compose path (Option A): leave this unset.** The container always listens on 3000 internally; changing it there desyncs the image's `EXPOSE`/`HEALTHCHECK` from where the app actually listens, and the container restart-loops reporting unhealthy. To serve Option A on a different host port, edit the host side of `docker-compose.yml`'s `ports:` mapping instead. |
| `DATA_DIR`            | No                   | Overrides where the database, uploads, thumbnails, and admin hash live. Leave unset for the default (`./data`, bind-mounted in Option A).                                                                                                                                                                                                                                                                                   |
| `BACKUP_DIR`          | No                   | Overrides where `scripts/backup.js` writes snapshots. Leave unset for the default (`./backups`, bind-mounted in Option A).                                                                                                                                                                                                                                                                                                  |
| `MAINTENANCE`         | No                   | Set to `1` or `true` to serve guests a 503 maintenance page while `/admin` stays reachable.                                                                                                                                                                                                                                                                                                                                 |

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

TLS terminates at the reverse proxy; the app itself keeps serving plain HTTP on `localhost` exactly as it does in development.

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
2. Create tasks and guests through the admin UI.
3. Confirm `BASE_URL` is the final public domain — QR codes bake it in.
4. Restart the app so `BASE_URL` takes effect if it was changed after first boot.
5. Print the QR sheet (`/admin/qrsheet`).
6. Run one end-to-end test from a phone: scan a QR code, sign in, complete a task, view the leaderboard.

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

This writes a timestamped folder under `BACKUP_DIR` (default `./backups`) with a consistent copy of the database, the photo directories, and the admin password hash. Scheduling this on a recurring basis with off-host retention is covered separately (issue #287); until that lands, run it manually on a cadence you are comfortable with.

## Restore

1. Stop the app (`docker compose down` or `systemctl stop garden-party`).
2. Make sure `./data` is empty or does not exist — restoring on top of an existing `data/` overwrites it.
3. Copy the snapshot's contents back into `./data`:
   ```bash
   mkdir -p data
   cp backups/<timestamp>/app.db data/app.db
   cp -r backups/<timestamp>/uploads data/uploads
   cp -r backups/<timestamp>/thumbs data/thumbs
   cp backups/<timestamp>/admin.hash data/admin.hash   # skip if the snapshot has none
   ```
4. Fix ownership if needed (Option A): `sudo chown -R 1000:1000 ./data`
5. Start the app again (`docker compose up -d` or `systemctl start garden-party`).
