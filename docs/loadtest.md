# Load Test — Peak Guest Traffic (Goal A)

A local peak-load check for Goal A: "fast and standing with the whole guest list on it at once, on venue wifi." This drives a running, event-seeded instance with ~100 simulated guests hitting the real hot paths at once — sign-in, the home page, tasks, gallery, feed, leaderboard, and photo upload — and reports latency percentiles plus the error rate against a pass bar, so you know before the wedding whether the laptop holds up under peak, and where the ceiling is.

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

   Each virtual guest signs in through `/j/<token-prefix><lane>` (capturing the real signed session cookie the same way a phone would), then repeatedly loads `/`, `/tasks`, `/gallery`, `/feed` (the feed is in the loop as of issue #194, since it is the page every like and comment lands back on), `/leaderboard`, and submits a real sample photo to `/tasks/:id/submit` — the heaviest request in the app (file upload + database write + thumbnail generation), and the one most likely to reveal the laptop struggling. The task id it submits against is discovered at runtime from the live `/tasks` page (a genuinely active task, preferring one the guest hasn't done yet), so the upload always lands on a real active task and runs the full insert-plus-thumbnail path rather than 404ing. If it can't find an active task, it prints a warning and skips the upload — that means the event isn't seeded, so run the seed step above first.

## Reading the output

The script prints one summary line, for example:

```
Summary: count=4213 errors=0 errorRate=0.00% p50=42ms p95=310ms p99=880ms rps=140.4
```

- **count** — total requests sent across all virtual guests.
- **errors** — how many of those requests came back with a `5xx` (server error) status.
- **errorRate** — errors ÷ count, as a percentage. This must be `0` — any server error under load is a real problem, not noise.
- **p50 / p95 / p99** — response time in milliseconds that 50% / 95% / 99% of requests finished within. p95 is the headline number: it says "19 out of 20 guests saw a response at least this fast."
- **rps** — requests per second the app sustained during the run.

The script then prints `PASS` or `FAIL` and exits with status `0` (pass) or `1` (fail), so it can be dropped into a script or CI step that needs a clear signal.

## The Goal-A pass bar

The run passes when **both** of these hold:

- **`0` requests return a `5xx` status** — the app never breaks under peak load, even once.
- **p95 stays under the target** (2000ms by default) — the slowest-but-one guest in twenty still gets a response inside two seconds, not a spinner.

A `FAIL` line lists exactly which bar was missed (error rate, p95, or both) so you know whether the problem is stability or raw speed.

If it fails, the tunable to reach for first is `--concurrency` — vary it to find the actual ceiling (e.g. does 100 pass but 150 doesn't? what about 60?), so you know the real headroom above your expected peak guest count, not just a pass/fail at one number.

## Caveat: this is not venue wifi

This test measures the laptop and the app — nothing about the network the guests' phones actually use on the day. Running it on `localhost` skips the wifi entirely: no radio contention, no distance-from-router weak signal, no other devices competing for bandwidth, none of the failure modes real **venue wifi** introduces. A clean local `PASS` tells you the laptop and the code can carry the load; it does **not** tell you the venue's wifi can. Treat the venue's actual network as a separate real-world dry-run — ideally on-site, with several phones at once — before trusting this pass bar on the wedding day itself.
