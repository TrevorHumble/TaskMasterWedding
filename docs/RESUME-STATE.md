# Resume state — autonomous backlog run

**Living handoff doc.** A fresh or compacted agent reads this to resume the backlog-clearing run precisely. Update it at every pause. This is operational state, not product documentation — the North Star is [`north-star.md`](north-star.md); the standards are in `standards/`.

- **Last updated:** 2026-06-28 (design-system + alpha push session)
- **main HEAD at last update:** `8dc9447`
- **Run status:** the app is at a **prototype-alpha state on the Lillian & Axel design system** and the top privacy bug is fixed. Continue the backlog in priority order, or hand to the owner for user testing.

## Milestone reached this session: prototype alpha on the design system

The owner supplied a design system ("Lillian & Axel" — clean white, forest-green `#467058`, all-serif Cormorant Garamond + EB Garamond, a single heart motif, generous white space; tokens + guide now in `docs/design-system/`) and directed a complete redesign + critical-bug pass to reach a testable alpha. Done:

| PR                                                               | Issue | What                                                                                                                                                                                                                                                                                 | Merged |
| ---------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| [#31](https://github.com/TrevorHumble/TaskMasterWedding/pull/31) | #30   | Guest redesign: `theme.css` rebuilt on the design system; all 8 guest views + partials converged to one class vocabulary; nested `<main>` + duplicate flash fixed; heart motif + wordmark; design system incorporated to `docs/design-system/`; two inline fallback pages reskinned. | yes    |
| [#33](https://github.com/TrevorHumble/TaskMasterWedding/pull/33) | #32   | Admin redesign: all 6 admin views converged onto the theme vocabulary; data tables/forms/cards on-brand; qrsheet recolored; `makeAdminAgent` test helper + admin-render tests.                                                                                                       | yes    |
| [#35](https://github.com/TrevorHumble/TaskMasterWedding/pull/35) | #34   | Security: taken-down photos were still served by direct URL; added a two-stage guard (Stage-1 stored-name allowlist closes the case-variant + NTFS `::$DATA` bypass class, Stage-2 `COLLATE NOCASE` takedown lookup); NOCASE indexes; files untouched so export still works.         | yes    |

Verified live over real HTTP: every page returns 200 with the serif/heart/green design and exactly one `<main>`, zero Dancing-Script/pastel remnants. The takedown fix was re-attacked with 24+ bypass vectors by an independent reviewer — all blocked.

**Prototype is ready for user testing.** The design is done and the top privacy hole is closed. Remaining items below are production-hardening (for the live wedding Aug 7) and new features, not alpha-test blockers.

## The owner's standing directives

- **Merge policy:** non-visual change types — bug fixes, security, refactor, tests, correctness — auto-merge on adversarial-review PASS + green CI (owner pre-merge gate retired 2026-07-02; see the "Merge policy" decision in `DESIGN.md`). The owner reviews the live result after the fact and can request changes or revert; owner control is upstream (issue-speccing), not a pre-merge gate. **Visual / product-direction changes are the one exception (reinstated 2026-07-08, #294; mechanism replaced 2026-07-15, #378):** the owner settles the look **live**, before it is even written down — `npm run preview` hands him a seeded localhost link, the orchestrator edits the real front end directly against it while nothing commits, and he refreshes and says approved. Only then is the pixel-freeze recorded (`tools/persist-visual-approval.ps1`) and the normal criteria / issue-review / implementation / PR-review pipeline runs on the transcribed result. See `agents/orchestrator.md` § "Visual-approval loop" and `DESIGN.md` § "Visual-approval loop reinstated (#294) -- superseded by #378".
- **5 derived decisions:** contained-sharing → lean ("after-party section, hidden until unlocked"); task changes → next-tap; new-feature UI → existing theme, minimal; test fixtures → generate a real image; admin password value stays the owner's (fix code only).
- **OPEN owner question (non-blocking):** couple-name spelling. The design system says **"Lillian & Axel" / "Lilly & Axel"**; repo docs say **"Lily Sckeiky."** The redesign uses the design system's spelling. One-line sweep to change if the owner says otherwise.

## The pipeline every change goes through (do not skip)

Per `CLAUDE.md` / `AGENTS.md` / `standards/`: file a GitHub issue (issue-standards) → independent **Opus** adversarial review of the issue (de-biased: goal not mechanisms, assume failure, cite evidence, PASS/FAIL) → **Sonnet** implements → independent **Opus** adversarial review of the PR (MUST run `npm test` itself) → commit through the gate (`git add -A`; `tools/review_verdict.ps1 -Verdict PASS -Reviewers "..."` binds the verdict to `git write-tree`; `git commit -F data/commitmsg-*.txt`) → push → `gh pr create --body-file` → watch CI → merge on green CI. System-level changes need two reviewers, both PASS.

## Backlog remaining (priority order)

**Security cluster (auto-merge):** login hardening (rate-limit/lockout on `POST /admin/login`, reject weak/common passwords in `scripts/set-admin-password.js`, bcrypt cost ≥12); CSRF on state-changing POSTs; helmet headers (careful CSP — Google Fonts + inline `<style>` in 404/error/qrsheet); HTTPS/secure cookies + fail-closed `COOKIE_SECRET`.

**Correctness cluster (auto-merge):** centralize scoring/points + bonus-clamp; de-scaffold the `mountRouterIfPresent` bootstrap in `app.js`; single-source upload config (config.js `MAX_UPLOAD_BYTES` 12 MB vs photos.js 15 MB mismatch; avatar parity; thumb naming); delete orphan photo files on task deletion; admin views render their own `<p class="flash">` for `msg` (minor dup-flash, cosmetic).

**Goal-builds (UI/product):** contained sharing (lean after-party section) + hide/move/delete moderation (now unblocked by the real-takedown fix); host-curated favorites → end-of-night slideshow; prizes the hosts set, shown to guests.

**Durability (auto-merge):** expand the test suite toward ~80% meaningful coverage + ramp the CI coverage gate; move the in-memory ZIP+xlsx export off the request thread.

**UX:** tap-target/button spacing (owner wants this); forced-camera `capture` removal; client-side upload validation + HEIC accept.

**Dependabot:** 14 open PRs (#2–#15). Merge low-risk action/minor bumps; hold risky majors (ejs 3→6, eslint 9→10, multer 1→2, better-sqlite3, sharp, archiver) until verified against the suite.

## Gotchas / learnings (read before resuming)

- **The adversarial reviewer earns its keep — trust it.** This session it caught: wrong source-file paths + a prettier/format collision in the redesign issue; two real, demonstrated security bypasses in the photo-access fix (case-variant filenames, then NTFS `::$DATA`) that drove the design to a stored-name allowlist; and the dev-DB-pollution trap on every state-touching test. The PR reviewer MUST run `npm test` itself and re-attack security fixes against the actual code.
- **Photo-serving guard (new):** taken-down access control lives in `src/services/photos.js` (`blockTakenDownOriginal` / `blockTakenDownThumb`), mounted before the `/uploads` and `/thumbs` static mounts in `app.js`. Stage-1 allowlist regex `^[0-9a-f]{16}-\d+\.(jpg|png|webp|heic)$` (thumbs add `.jpg`); Stage-2 `COLLATE NOCASE … taken_down = 1`. Any test fetching an image must use a realistic stored filename — the old `seed()` `p.jpg`/`t.jpg` do NOT match the allowlist (they 404, correctly).
- **Admin-auth in tests:** `tests/helpers/testApp.js` `makeAdminAgent(app, password)` writes a bcrypt hash to the temp `ADMIN_HASH_PATH` and logs a supertest agent in. Use it for admin-gated render tests.
- **Test require-order:** require `src/db` / `config` / services / app only AFTER `loadApp()` sets `DATA_DIR` / `DB_PATH`.
- **Community pages are guest-gated** (403 without a `gsid` cookie); `/admin/login` is the one ungated view. Issue #244 retired `GET /j/:token` (it now just 302s to `/join` and sets no cookie) — sign a guest in with `signInGuest(app, token)` from `tests/helpers/testApp.js`, which mints the signed `gsid` cookie directly into a supertest agent's cookie jar instead of visiting a URL.
- **The header partial owns the single `<main class="page">` and renders flash once;** views provide inner content only (do not open their own `<main>` or re-render flash).
- **PowerShell / git:** `gh` at `C:\Program Files\GitHub CLI\gh.exe` (full path). `git -C <repo>`. Commit with `-F`. Issue/PR bodies via `--body-file` from gitignored `data/`. `Push-Location <repo>` before `tools/*.ps1`. Don't pipe `2>&1` on native commands. Stage → record verdict → commit with nothing changing in between (even prettier invalidates the verdict).
- **Branch protection on `main`:** PR required; checks `commit-gate-integrity` / `lint` / `test`; `enforce_admins`. CRLF/prettier determinism handled (`endOfLine:auto`).

## How to resume

1. Read this file + [`north-star.md`](north-star.md) + `standards/`.
2. `gh issue list` / `gh pr list` for live state; confirm `main` is green.
3. Pick the highest-priority remaining backlog item; run the full pipeline; merge on green CI (adversarial-review PASS + green checks).
4. Update this file at each pause.

## Live log

Per-increment ledger lines written by the orchestrator during autonomous timed runs. One line per increment, form:

```
[HH:MM] elapsed=Xm/budget=Ym | selector→{DO <item> | CASCADE | WRAP} | next=<item>
```

The `elapsed` value must be derived from a real system-clock read at that moment — never estimated or carried forward. A compacted instance verifies the loop is live by reading the last ledger line here.
