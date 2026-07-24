# Load Test — Peak Guest Traffic (Goal A)

A local peak-load check for Goal A: "fast and standing with the whole guest list on it at once, on venue wifi or their own connection." This drives a running, event-seeded instance with ~100 simulated guests hitting the real hot paths at once — sign-in, the home page, tasks, gallery, feed, leaderboard, and photo upload — and reports latency percentiles plus the error rate against a pass bar, so you know before the wedding whether the hosted app holds up under peak, and where the ceiling is.

It adds no new dependency and no paid service: `scripts/loadtest.js` uses Node's built-in `fetch` with a bounded concurrency pool.

## Run procedure

1. **Seed an isolated ~100-guest event.** Do this against a throwaway data directory, never the real event data:

   ```powershell
   $env:DATA_DIR = "data-demo"
   node scripts/seed-event.js --guests 100
   ```

2. **Set an admin password for this run** (only needed if you'll also poke around as admin during the test — the load test itself only acts as guests):

   ```powershell
   $env:DATA_DIR = "data-demo"
   node scripts/set-admin-password.js <choose-your-own-password>
   ```

3. **Start the app**, pointed at the same data directory, and leave it running in its own terminal:

   ```powershell
   $env:DATA_DIR = "data-demo"
   npm start
   ```

4. **Run the load test** against it, from a second terminal:

   ```powershell
   node scripts/loadtest.js --concurrency 100
   ```

   Or via the npm script:

   ```powershell
   npm run loadtest
   ```

   Useful flags (all optional):

   | Flag               | Default                 | Meaning                                                 |
   | ------------------ | ----------------------- | ------------------------------------------------------- |
   | `--base-url`       | `http://localhost:3000` | Where the running app is reachable                      |
   | `--concurrency`    | `100`                   | Number of virtual guests hammering the app at once      |
   | `--duration <sec>` | `30` (if neither given) | Run for a fixed wall-clock time                         |
   | `--requests <n>`   | —                       | Run until this many total requests are recorded instead |
   | `--token-prefix`   | `event-guest-token-`    | Must match the seeded guest tokens                      |

   Each virtual guest signs in by minting the signed `gsid` session cookie directly (node's built-in `crypto`, the same HMAC signing `cookie-parser`/`cookie-signature` do — no HTTP round trip) for `<token-prefix><lane>`, then repeatedly loads `/`, `/tasks`, `/gallery`, `/feed` (the feed is in the loop as of issue #194, since it is the page every like and comment lands back on), `/leaderboard`, and submits a real sample photo to `/tasks/:id/submit` — the heaviest request in the app (file upload + database write + thumbnail generation), and the one most likely to reveal the laptop struggling. Issue #244 retired the old `/j/<token>` sign-in link this harness used to sign in through; minting the cookie locally requires this process's `COOKIE_SECRET` to match the target server's (both default to reading the same project `.env`). The task id it submits against is discovered at runtime from the live `/tasks` page (a genuinely active task, preferring one the guest hasn't done yet), so the upload always lands on a real active task and runs the full insert-plus-thumbnail path rather than 404ing. If it can't find an active task, it prints a warning and skips the upload — that means the event isn't seeded, so run the seed step above first.

## Reading the output

The script prints a summary line, followed by a per-path breakdown line for every path that had at least one failure. For example, a clean run:

```
Summary: count=4213 server5xx=0 networkFailures=0 p50=42ms p95=310ms p99=880ms rps=140.4
```

And a run with failures:

```
Summary: count=4213 server5xx=1 networkFailures=6 p50=42ms p95=310ms p99=880ms rps=140.4
  /gallery: networkFailures=6
  /tasks/:id/submit: server5xx=1
```

- **count** — total requests sent across all virtual guests.
- **server5xx** — how many requests came back with a real HTTP `5xx` status from the app. This is the app breaking under load, and must be `0`.
- **networkFailures** — how many requests never got an HTTP response at all (connection refused, timeout, reset — the harness's `fetch` call threw). This is a **distinct** count from `server5xx`: it is not proof the app broke, and is reported for diagnosis, not as a pass/fail signal by itself.
- **p50 / p95 / p99** — response time in milliseconds that 50% / 95% / 99% of requests finished within (network failures' latencies are included). p95 is the headline number: it says "19 out of 20 guests saw a response at least this fast."
- **rps** — requests per second the app sustained during the run.
- **per-path breakdown** — for each path that had any failure, the path and its `server5xx`/`networkFailures` counts, so a `FAIL` (or an interesting `networkFailures` spike) tells you not just how much broke but where.

> Before issue #309, a client-side network drop and a real server 5xx were folded into one `errors` bucket via a `NETWORK_FAILURE_STATUS = 599` sentinel, and no path was recorded. That made the gate flaky: a run with only client-side connection drops (0 server errors) reported the same `FAIL` as a run where the app actually broke, with no way to tell which had happened or where. `server5xx` and `networkFailures` are now always distinct fields, never merged.

The script then prints `PASS` or `FAIL` and exits with status `0` (pass) or `1` (fail), so it can be dropped into a script or CI step that needs a clear signal.

## The Goal-A pass bar

The run passes when **both** of these hold:

- **`server5xx === 0`** — zero requests return a real `5xx` status from the app, even once.
- **p95 stays under the target** (2000ms by default) — the slowest-but-one guest in twenty still gets a response inside two seconds, not a spinner.

`networkFailures` is **not** part of the pass bar. A client-side connection drop under load is harness/network noise (a saturated local loopback, a laptop NIC hitting its own connection ceiling) unless it correlates with `server5xx` on the same path — read a nonzero `networkFailures` as a prompt to look closer, not as an automatic FAIL.

A `FAIL` line lists exactly which bar was missed (`server5xx`, `p95`, or both), and the per-path breakdown says where.

If it fails, the tunable to reach for first is `--concurrency` — vary it to find the actual ceiling (e.g. does 100 pass but 150 doesn't? what about 60?), so you know the real headroom above your expected peak guest count, not just a pass/fail at one number.

## Caveat: this is not the deployed URL

This test measures the app process itself — nothing about the real network path a guest's phone takes to the deployed URL. Running it on `localhost` skips real-network latency, the TLS handshake, and the reverse proxy hop entirely, along with venue-wifi effects like radio contention and distance-from-router weak signal. A clean local `PASS` tells you the app and the code can carry the load; it does **not** tell you the deployed URL, reached over real network and TLS/proxy overhead, can. Confirm the pass bar once against the deployed URL — ideally with several phones at once — before trusting it on the wedding day itself; that confirmation run is issue #292's job.

## Recorded baselines

**2026-07-10** — captured on the event laptop after the #309 attribution rewrite, against a throwaway `data-demo` event seed (`node scripts/seed-event.js --guests 100`) and a bounded request count (rather than the default 100-concurrency/30s run, to keep the recorded run short):

```
node scripts/loadtest.js --requests 400 --concurrency 40
Summary: count=520 server5xx=0 networkFailures=0 p50=73ms p95=184ms p99=226ms rps=410.4
PASS: within Goal A thresholds.
```

Zero `server5xx` and zero `networkFailures` — the app and this local harness both held up clean at this concurrency/request count. This is a **local** baseline only (see the caveat above); it does not stand in for a documented 100-concurrency run, which remains the harness's default and issue #292's hosted-URL job.

**2026-07-14 — before/after #311 (upload crash safety + peak mitigation):**

_Before_ (the #311 evidence, captured on the event laptop prior to this issue's fix, at `--concurrency 100`, no `--requests`/`--duration` bound given so the default write-up quotes the two runs as recorded in the issue): **25 dropped connections out of 14140 requests**, then on a re-run, **8 dropped out of 12084** — both at the socket layer (`networkFailures`), with `server5xx` at 0 throughout. A **read-only** run at the same concurrency (no uploads in the mix) dropped **0 of 6860**. Root cause per the issue: the synchronous heavy path (multer disk write + sharp thumbnail + synchronous better-sqlite3 insert) blocking the event loop long enough, under simultaneous uploads, that the untuned default `app.listen()` accept backlog sheds a few brand-new incoming connections before Express ever sees them.

_After_ (this run, same host, same seeded `--guests 100` event, same harness): with the #311 fix in place — `src/routes/guest.js`'s try/catch around `submissions.submitPhoto` (closes the crash risk) and the `MAX_CONCURRENT_UPLOADS` semaphore around that same call (`src/utils/upload-concurrency.js`, bounds how many heavy pipelines run at once) — a fresh 100-guest seed at the SAME scale as the worse of the two "before" runs:

```
node scripts/loadtest.js --base-url http://localhost:3311 --requests 14140 --concurrency 100
Summary: count=14436 server5xx=0 networkFailures=0 p50=216ms p95=562ms p99=690ms rps=370.5
PASS: within Goal A thresholds.
```

Zero `networkFailures` at the identical request count/concurrency that previously dropped 25 -- the upload-concurrency cap (default 6 concurrent heavy pipelines; env-overridable via `MAX_CONCURRENT_UPLOADS`) keeps enough of the accept backlog free that no incoming connection was shed. `server5xx` stayed 0 throughout, matching the before run and confirming the fix did not trade dropped connections for a new failure mode of its own. As with every other recorded run here, this is a **local** measurement (see the caveat above), not a substitute for the documented hosted-URL confirmation (issue #292).

## Hosted run (provisional — issue #525)

**2026-07-18** — the first load run on the **real production host** (the rented droplet), weeks ahead of #292's final proof, so a hosting-capacity or configuration failure surfaces with buffer instead of days. Every run above this line was on the event laptop; this one is on the host guests will actually reach.

**Target host:** the production droplet — 2 vCPU, ~2 GB RAM, 58 GB disk. The load ran against the same Docker image serving the live site (`taskmasterwedding-app:latest`, built from commit `6e8602f`), so it exercises the host's real CPU, memory, and disk and the exact code guests run.

**Isolation — the live event was never touched.** `docs/deploy.md` § "First data" forbids seeding production data, and the harness uploads a photo on every lap, so the run used a **short-lived, fully isolated instance**, never the live container or the real `data/`:

- a throwaway app container from the live image, with its own ephemeral `DATA_DIR` (inside the container layer — nothing bind-mounted) and its own single-use `COOKIE_SECRET`, on a private Docker network with no published ports;
- seeded with a fresh 100-guest event (`node scripts/seed-event.js --guests 100` → 100 guests, 20 active tasks);
- driven from a **separate** container on the same network (`scripts/loadtest.js --base-url http://<app-container>:3000 --concurrency 100 --duration 30`), so the app container's CPU/memory readings reflect the server alone, not the harness sharing its cores;
- torn down at the end — the ephemeral data dir vanished with the container. The live container stayed `healthy` with 0 restarts, and host disk use was unchanged (8%) before and after.

**Load profile:** 100 concurrent virtual guests for 30 s, each looping the read paths (`/`, `/tasks`, `/gallery`, `/feed`, `/leaderboard`) plus a real photo submit to `/tasks/:id/submit`.

**Measured numbers:**

```
Summary: count=7050 server5xx=0 networkFailures=0 p50=206ms p95=1240ms p99=1478ms rps=221.6
PASS: within Goal A thresholds.
```

App-container resource use, sampled every 2 s during the run (server only): CPU peaked at ~137 % of the 200 % two-core ceiling (≈1.4 of 2 cores), memory peaked at ~121 MiB of 1.9 GiB, no OOM kill, exit code 0, 0 restarts. Seeded data dir reached 12 MB.

**Verdict per surface:**

- **Read paths + upload (all paths):** **PASS.** `server5xx=0` and `networkFailures=0` across all 7,050 requests — nothing broke or dropped. p95 `1240ms` is under the 2000 ms Goal-A bar.
- **Host capacity:** **PASS, CPU is the binding resource.** Memory and disk had wide headroom; CPU is what moves. At a sustained flat-out 100-concurrent run the two cores peaked around 1.4 used, leaving ~30 % headroom — and a real reception is bursty, not 30 s of every guest hammering at once. No resource ceiling was hit. No follow-up issue is filed, because no surface reached a concern.

p95 here (`1240ms`) is higher than the laptop baselines above (`562ms` after #311) — expected: this host is two shared cloud vCPUs, not the event laptop, and this is a full sustained 30 s run. Zero server errors at that latency on the real hardware is the signal that matters this far out.

**What this run does _not_ cover:** the driver hit the app container directly over the host's private Docker network, so this measures the host's hardware and the app image — **not** the public `https://` URL, the reverse-proxy/TLS hop, or real venue-wifi (radio contention, weak signal). Those remain issue #292's job: the final, feature-complete confirmation against the public URL, ideally with several phones at once. This provisional run narrows nothing about #292 — it only buys an early capacity signal.
