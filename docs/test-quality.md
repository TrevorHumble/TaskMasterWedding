# Test quality: the mutation-testing baseline (#199)

Coverage says which lines _ran_ under the tests. It cannot say whether a test would _fail_ if a line were wrong. Mutation testing measures exactly that: Stryker plants hundreds of small deliberate bugs ("mutants") one at a time and counts how many the test suite notices. The percentage it reports — the **mutation score** — is the honest answer to "are the tests actually good?"

## How to run it

```powershell
npm run mutation
```

Takes ~20 minutes locally (the CI job allows 90 minutes as headroom for slower runners). The readable report lands at `reports/mutation/mutation.html` (gitignored). A weekly scheduled CI job (`.github/workflows/mutation.yml`) runs the same command and uploads the report as an artifact — it is **never a required check** (rationale below).

## Baseline — 2026-07-05, branch `issue-198-199-test-quality` (main @ 485886a)

**Every number in this file — the outcome table, the per-module scores, and the three hand-made probes
below — is this single 2026-07-05 baseline, pre-#181.** `npm run mutation` has not been re-run since; no
number here reflects test additions landed after that date. Treat the whole file as historical until a
fresh dated row is appended per "Ratchet intent" below.

922 mutants planted across `src/services/**` and `src/routes/auth.js` (the admin-login lockout lives there; it is one of the three probe points below). Results:

| Outcome                     | Count | Meaning                                         |
| --------------------------- | ----- | ----------------------------------------------- |
| Detected (killed + timeout) | 563   | A test failed or hung — the bug was noticed     |
| Survived                    | 197   | Tests ran the mutated code and **still passed** |
| Not covered by any test     | 162   | No test even executes this code                 |

**Overall score: 61.06%** (74.08% counting only code the tests actually reach.)

Per module — higher is better:

| Module                    | Score  | Plain reading                                          |
| ------------------------- | ------ | ------------------------------------------------------ |
| `services/badges.js`      | 91.67% | Badge definitions are well defended                    |
| `services/feed.js`        | 87.90% | Feed logic is well defended                            |
| `services/scoring.js`     | 85.82% | Scoring is well defended                               |
| `services/submissions.js` | 82.69% | Solid, with the file-cleanup gap noted below           |
| `routes/auth.js`          | 72.15% | Login works, but boundary conditions slip through      |
| `services/photos.js`      | 68.86% | Core moderation caught; some edges slip                |
| `services/qr.js`          | 35.71% | QR generation is barely defended                       |
| `services/export.js`      | 16.06% | The keepsake export is nearly undefended — biggest gap |

## The three hand-made probes (from the 2026-07-04 review) — reproduced

The issue's evidence section demonstrated three deliberate bugs by hand. The automated run reproduces the same catch/miss pattern:

1. **Scoring ignores hidden photos** (`taken_down = 0` filter, `scoring.js`) — **detected.** Honest nuance: Stryker cannot edit the inside of a SQL string, so there is no mutant that removes _only_ the filter clause; the nearest mutants (blanking the scoring queries) are detected via test failure/hang.
2. **Hidden photos blocked from direct URLs** (a guard in `photos.js`) — **detected**, same SQL-string nuance as above.
3. **Admin lockout one attempt late** (`>=` → `>` in `auth.js`) — **SURVIVED**, exactly as demonstrated by hand. No test pins the lockout to the exact attempt count.

## Where the tests are thin — plain-English list

What a bug could quietly do today without any test noticing, worst first:

- **The keepsake export could break almost any way** (`export.js`, score 16%). Wrong photos in the ZIP, broken spreadsheet, mislabeled files — 103 planted bugs survived and another 106 weren't executed by any test. This is Goal D's deliverable ("one shared record, kept"); it deserves tests before the wedding.
- **QR codes** (`qr.js`, 36%): a bug in QR generation (wrong URL encoded, wrong size) would likely ship unnoticed.
- **Admin lockout boundary** (`auth.js`): locking one attempt later than configured goes unnoticed. Known since the hand review; now pinned by a named surviving mutant.
- **Replaced-photo file cleanup** (`submissions.js`): if replacing a photo stopped deleting the old files, every test still passes — disk quietly fills with orphans.
- **Badge-removal guard** (`removeSpecialBadge`, in `scoring.js`): if the admin removes a badge using a code that doesn't exist (or a system-managed one), the guard could be bypassed and no test would object. The matching guard on the _award_ path, also in `scoring.js`, is fully defended — every planted bug there was caught.
- **Silent error paths in submissions** (`submissions.js`): the superseded-file-cleanup error handler is never executed by any test at all, and the recompute-failure log message can be blanked without a test noticing — minor, but those failure paths are effectively unwatched.

Killing these survivors — starting with `export.js` and the lockout boundary — is concrete test-writing work tracked under #181.

## Ratchet intent

The baseline is 61.06%. As #181 lands tests, this number should only move up. Re-run `npm run mutation` after meaningful test additions and update this file; do not let recorded history be overwritten silently — append a dated row:

| Date       | Commit                                        | Score  | Notes                          |
| ---------- | --------------------------------------------- | ------ | ------------------------------ |
| 2026-07-05 | `issue-198-199-test-quality` (main @ 485886a) | 61.06% | Initial baseline (922 mutants) |

## Why this is a report, not a gate

The full run takes ~20 minutes and single mutants can flake by timeout — far too slow and noisy to block every PR, and a per-PR gate would push agents toward gaming the score rather than writing good tests. The owner's need here is a **quality signal** — a number that says whether the tests would notice a bug — so it runs manually and on a weekly CI timer (like CodeQL's cadence), and the score is read by a human. The per-PR quality bar remains the coverage gate in `vitest.config.mjs` (#198), which is fast and deterministic.

## Config notes (why two odd settings exist)

`stryker.conf.json` sets:

- `"vitest": { "related": false }` — the tests exercise services through the Express app (supertest), so vitest's related-file detection finds nothing and Stryker's dry run dies with "No tests were executed" without this.
- `"symlinkNodeModules": false` — with the default symlink, native modules (sharp/libvips, better-sqlite3) load through a second path inside Stryker's sandbox and crash the Windows test worker with an access violation (exit 0xC0000005). Resolving `node_modules` by walking up to the real directory keeps a single native load path.
