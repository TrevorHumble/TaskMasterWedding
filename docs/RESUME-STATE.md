# Resume state — autonomous backlog run

**Living handoff doc.** A fresh or compacted agent reads this to resume the backlog-clearing run precisely. Update it at every pause. This is operational state, not product documentation — the North Star is [`north-star.md`](north-star.md); the standards are in `standards/`.

- **Last updated:** 2026-06-28
- **main HEAD at last update:** `9739ce3`
- **Run status:** PAUSED (owner said "stop when you can"). Main is green; no branches or agents in flight. The standing directive below still holds — resume the backlog in priority order, or wait for the owner's go.

## The mission and the owner's standing directives

The owner (Trevor) set this run going autonomously with: _"follow the goal, take it as far as you can ... go and go and don't stop until the backlog is cleared."_ Work every item against the North Star goals (A–D in [`north-star.md`](north-star.md)).

- **Budget:** do not micro-manage it — the owner's usage window refreshes ~every 90 minutes. Keep working; if a spend limit is hit, it clears on the next window.
- **Merge boundary (decides whether to merge vs. leave for the owner):**
  - **Auto-merge** on adversarial-review PASS + green CI: bug fixes, security, refactor, tests, correctness, and the _functional_ part of builds.
  - **Leave as an open PR for the owner** (do NOT merge): anything that changes the **visual design / brand look**, or shifts **product direction**. The owner is the final eye on visual results.
- **Decisions already made by the owner / derived from goals (do not re-ask):**
  1. **Contained sharing → lean:** an "after-party section, hidden until unlocked," not full multi-group. Expandable if time allows.
  2. **Task changes → next-tap,** not live push to guests.
  3. **New-feature UI → use the existing theme, functional and minimal.** Do not invent design; anything needing a real look-and-feel call → leave as an open PR.
  4. **Test fixtures → generate a real image** when a photo is needed (no blank/pink-square placeholder).
  5. **Admin password value stays the owner's** — fix the code, never set or invent the actual password.

## The pipeline every change goes through (do not skip)

Per `CLAUDE.md` / `AGENTS.md` / `standards/`:

1. **File a GitHub issue** meeting `standards/issue-standards.md` (user story, Given/When/Then ACs with ≥1 behavioral input→output assertion, numbered impl plan with file paths, dependency map). Write the body to a gitignored file under `data/wip-issues/` and `gh issue create --body-file`.
2. **Adversarial review of the issue** — spawn one independent **Opus** reviewer with a _de-biased_ briefing (give the goal, not the mechanisms; assume failure; cite evidence; PASS/FAIL). Revise until PASS. (Reviewers verify claims against the actual source — this has caught wrong ACs twice.)
3. **Implement** — spawn one **Sonnet** implementer. It edits the working tree, runs `npm run format` / `npm run lint` / `npm test`, and does NOT run git.
4. **Adversarial review of the PR** — spawn one independent **Opus** reviewer. It MUST run `npm test` itself (a single green run can be a false pass — see Gotchas). Revise until PASS.
5. **Commit through the gate, then PR:**
   - `git add -A`
   - `Push-Location <repo>; & .\tools\review_verdict.ps1 -Verdict PASS -Reviewers "reviewer-pr-opus"; Pop-Location` (binds the verdict to the staged `git write-tree`).
   - `git commit -F <data/commitmsg-*.txt>` (the pre-commit hook re-checks the tree; must match).
   - `git push -u origin <branch>`; `gh pr create --body-file <data/pr-*.md>`.
   - Watch CI: `gh pr checks <n> --watch --required`. On green: **auto-merge** (`gh pr merge <n> --squash --delete-branch`) OR **leave open** per the merge boundary.
   - Sync: `git checkout main; git pull --ff-only; git branch -D <branch>`.

Model policy: orchestrator + reviewers = **Opus**; implementer = **Sonnet**. A producer never reviews its own output. System-level changes (pipeline/hooks/standards/agents) need **two** independent reviewers, both PASS.

## Done this session (merged to main, full pipeline)

| PR                                                               | Issue | What                                                                                                                                                                    | Goal |
| ---------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [#20](https://github.com/TrevorHumble/TaskMasterWedding/pull/20) | #19   | Testability seam: `require.main` guard on `app.listen`, env-overridable `DATA_DIR`/`DB_PATH`, `tests/helpers/testApp.js` (`loadApp`/`seed`). Unblocks behavioral tests. | A    |
| [#22](https://github.com/TrevorHumble/TaskMasterWedding/pull/22) | #21   | Broken photos fixed: pass `pageScript:'gallery.js'`, native thumbnail `src`, lightbox `.open` class.                                                                    | D    |
| [#26](https://github.com/TrevorHumble/TaskMasterWedding/pull/26) | #25   | Removed hardcoded/leaked admin password default; generic login error; README updated.                                                                                   | C    |
| [#28](https://github.com/TrevorHumble/TaskMasterWedding/pull/28) | #27   | Neutralized spreadsheet formula-injection in the xlsx export (`neutralizeCell`).                                                                                        | D/C  |

## Queued for the owner (open PR — do NOT merge; visual)

- [PR #24](https://github.com/TrevorHumble/TaskMasterWedding/pull/24) (issue #23 stays open until merged) — guest-view markup reconnected to the theme's class vocabulary (`container→page`, `btn` modifier drop, `form-row→form-group`, `task-row→task-item`, etc.). Adds no CSS. The PR lists what still needs the owner's design work (leaderboard rows, photo grids, error boxes, gallery pager — no theme rule exists for them).

## Backlog remaining (priority order)

**Security cluster (auto-merge):**

- Real photo takedown + access control — taken-down photos (`taken_down=1`) are still served by the raw `express.static` mounts at `/uploads` & `/thumbs`, so a "taken down" photo is reachable by direct URL. Make takedown actually block access while staying reversible (e.g. quarantine-move on takedown/restore, or a guarded serve route). **Prereq for contained-sharing.**
- Login hardening — rate-limit/lockout on `POST /admin/login`, reject weak/common passwords in `scripts/set-admin-password.js`, raise bcrypt cost to ≥12. (Depends on admin-pw, done.)
- CSRF protection on state-changing POSTs (login, onboard, uploads, admin actions). Biggest of the cluster.
- HTTP security headers (helmet) — note: the app loads Google Fonts + has inline `<style>` in 404/error, so a strict CSP will break rendering; use helmet's safe headers + a permissive/considered CSP.
- HTTPS/secure cookies + fail-closed `COOKIE_SECRET` — cookies are `secure:false`; `COOKIE_SECRET` silently falls back to a random per-boot value. Make cookies secure behind the tunnel and fail closed if unset in production.

**Correctness cluster (auto-merge):** nested `<main>` tags; centralize scoring/points + bonus-clamp (`scoring-owner`); de-scaffold the `mountRouterIfPresent`/optional-module bootstrap in `app.js`; single-source upload config + avatar parity + thumb naming; delete orphan files on task deletion; duplicate-flash fix.

**Goal-builds (leave as open PRs for the owner — UI/product):**

- Contained sharing (lean after-party section, hidden until unlocked) + hide/move/delete moderation. (Goal C; depends on real-takedown.)
- Host-curated favorites → auto-generated end-of-night slideshow. (Goal D)
- Prizes the hosts set, displayed to guests. (Goal B)

**Visual (leave for owner):** admin-view CSS reconnection (same kind of fix as #24, for `admin-*.ejs`).

**Durability (auto-merge):** expand the test suite toward ~80% meaningful coverage and ramp the CI coverage gate; move the in-memory ZIP+xlsx export off the request thread (peak-load).

**UX (mostly leave for owner):** tap-target/button spacing (owner explicitly wants this), forced-camera `capture` removal, client-side upload validation + HEIC accept, upload-ux.

**Dependabot (auto-merge safe ones):** 14 open PRs (#2–#15). Merge the low-risk action/minor bumps; hold the risky majors (ejs 3→6, eslint 9→10, multer 1→2, better-sqlite3, sharp, archiver) until verified against the suite. CI must stay green.

## Gotchas / learnings (read before resuming)

- **Trust the adversarial reviewer — it catches real bugs.** This session it caught: a test that bound to and polluted the real `data/app.db` (a single "green" run was a false pass); a seam AC that was factually wrong twice; the gallery lightbox CSS mismatch. The PR reviewer MUST run `npm test` itself, and for state-touching tests, run it twice to prove repeatability.
- **Test require-order:** any test that touches `src/db`/`config`/services/app must require them only **after** `loadApp()` sets `DATA_DIR`/`DB_PATH` (set env first, then require — see the comment in `tests/helpers/testApp.js`). Requiring at top level binds to the real `data/app.db`.
- **Community pages are guest-gated:** `guest.js:59` `router.use(requireGuest)` is mounted at `/` before `community.js`, so `/`, `/gallery`, `/leaderboard`, `/u/:id` all 403 without a `gsid` cookie. This is intended (private wedding), not a bug. In tests, sign in with `const agent = request.agent(app); await agent.get('/j/seedtoken')`. The one ungated GET that renders a view is `/admin/login`.
- **`tests/helpers/testApp.js`** exists: `loadApp()` → fresh temp dir + env + returns `{ app, db }`; `seed(db)` → guest token `seedtoken`, task title `Selfie with the cake`, one non-taken-down submission (`thumb_path='t.jpg'`).
- **PowerShell / git:** `gh` is at `C:\Program Files\GitHub CLI\gh.exe` (not on PATH). Use `git -C <repo>`. Commit with `-F <file>` (here-strings mangle). Issue/PR bodies via `--body-file` from `data/` (gitignored). Don't pipe `2>&1` on native commands (PowerShell wraps stderr as errors). `Push-Location <repo>` before running `tools/*.ps1` that call bare `git`.
- **Branch protection is on `main`** (PR required, checks `commit-gate-integrity`/`lint`/`test`, `enforce_admins`). No direct push to main — everything is a PR. CRLF/prettier determinism is handled (`endOfLine:auto`).
- **WIP artifacts** live in `data/wip-issues/`, `data/commitmsg-*.txt`, `data/pr-*.md` — all under gitignored `data/`.

## How to resume

1. Read this file + [`north-star.md`](north-star.md) + `standards/`.
2. `gh issue list` / `gh pr list` for live state; confirm `main` is green.
3. Pick the highest-priority remaining backlog item above; run the full pipeline; auto-merge or leave-for-owner per the boundary.
4. Update this file at each pause.
