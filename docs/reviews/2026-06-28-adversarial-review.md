# Adversarial Code Review — Garden Party Pastels (as-built baseline)

> **Historical (hosting model changed 2026-07):** this document describes the original laptop + Cloudflare-tunnel deployment. Current hosting: see DESIGN.md § Hosted deployment and docs/deploy.md.

**Date:** 2026-06-28  
**Method:** bias-gated multi-adversary review per `standards/adversarial-review-protocol.md`. Architecture had 3 independent reviewers (2-of-3 majority for `confirmed`); security, testability, and UX-usability had 2 each. A separate bias-gate agent audited the briefing.

**Bias-gate verdict:** CLEAN (only anti-builder bias; no positive framing, planted suspicions, or scope-narrowing).

**Reviewer verdicts:** architecture-1=FAIL, architecture-2=FAIL, architecture-3=FAIL, security-1=FAIL, security-2=FAIL, testability-1=FAIL, testability-2=FAIL, ux-1=FAIL, ux-2=FAIL.

**Totals:** 60 findings — 11 blocker, 23 major, 19 minor, 7 nit. 26 confirmed by multiple independent reviewers.

> Salvageability: the defects are localized (missing CSRF, a view/CSS class-name mismatch, an unwired gallery script, no test seams, absent security headers) rather than structural rot. The route/service/view/data separation is sound. Verdict: refactor, not rewrite.

---

## Blocker (11)

### Blocker-1 — No CSRF protection on any state-changing POST despite cookie-based auth

`ARCHITECTURE` · `blocker` · **confirmed ×3**  
**Where:** `src/app.js` — 47-50 (middleware stack); admin.js POST handlers; guest.js:233,372; auth.js:147  
**Why it matters:** Auth is a signed cookie (admin='1', gsid=token) with sameSite:'lax', and the app is reachable over the internet via Cloudflare tunnel. Lax does NOT stop top-level cross-site POSTs from form submits, so an attacker page can drive admin deletes/point-awards (delete guest also hard-deletes photo files from disk, irreversibly) or guest profile edits. No csurf/double-submit token exists anywhere. Baseline professional requirement for cookie-auth web apps (OWASP CSRF Cheat Sheet).  
**Fix:** Add per-session CSRF tokens: generate a random token tied to the admin/guest cookie, expose via res.locals, render a hidden <input name="_csrf"> in every POST form (and the fetch in upload.js), and add middleware before the routers that rejects POSTs whose body/header token doesn't match (validate multipart routes after multer parses). Also set sameSite:'strict' on the admin cookie.

### Blocker-2 — Gallery and public-profile never load gallery.js — every thumbnail renders blank and the lightbox is dead

`ARCHITECTURE` · `blocker` · single-reviewer  
**Where:** `src/views/gallery.ejs` — gallery.ejs:24-31,66-73; public-profile.ejs:79-87; footer.ejs:8-10; community.js:145,237  
**Why it matters:** Thumbnails render as <img class="gallery-thumb js-lazy" data-src="/thumbs/..."> with NO src; gallery.js copies data-src->src and wires the lightbox. But neither gallery.ejs nor public-profile.ejs passes pageScript, and footer.ejs only emits a script tag when pageScript is defined, so gallery.js never loads. The shared gallery and profile photo walls (a core deliverable) render entirely as empty/broken image boxes and click-to-enlarge does nothing.  
**Fix:** Add pageScript:'gallery.js' to both res.render calls in community.js (gallery ~145, public-profile ~237), OR add <script src="/js/gallery.js" defer></script> before the footer include in both views (matching task.ejs/me-edit.ejs). As defense-in-depth, give each thumbnail a real src so a JS failure degrades to working images.

### Blocker-3 — Every page emits nested, unbalanced <main> tags (invalid HTML on all views)

`ARCHITECTURE` · `blocker` · single-reviewer  
**Where:** `src/views/partials/header.ejs` — header.ejs:39 (opens <main class="page">); footer.ejs:2 (single </main>); each view opens its own <main> at line 5  
**Why it matters:** header.ejs opens <main class="page"> and never closes it; every content view opens a SECOND <main>; footer.ejs emits exactly one </main>. Net per page: two <main> opened, one closed. Two main landmarks violate the HTML spec and break accessibility landmark navigation; the unclosed element forces browser error-recovery and stacks .page max-width + padding unpredictably.  
**Fix:** Choose one main wrapper. Simplest: remove the stray <main class="page"> from header.ejs and keep each view's own <main> (and the </main> in footer correspondingly), then audit all views so exactly one <main> opens and closes per page.

### Blocker-4 — Hardcoded default admin password in source and leaked to unauthenticated users in login error

`SECURITY` · `blocker` · **confirmed ×2**  
**Where:** `scripts/set-admin-password.js` — set-admin-password.js:18,20; auth.js:156  
**Why it matters:** set-admin-password.js hardcodes DEFAULT_PASSWORD='ButtMonster' and uses it when run with no arg, so the shipped default admin credential is in the repo. Worse, auth.js:156 renders to ANY unauthenticated visitor of /admin/login when data/admin.hash is missing (the exact state on a fresh deploy): 'Run: node scripts/set-admin-password.js ButtMonster' — printing the actual password on a public screen. Admin guards photo moderation, point/badge awards, guest deletion, and full data export.  
**Fix:** Remove the hardcoded default; require the password as a mandatory argument and exit with usage if absent. In auth.js:156 say only 'Admin login is not configured; run the setup script' with no command/password. Rotate the password.

### Blocker-5 — No test infrastructure at all — no runner, no test script, no dev deps, no test directory

`TESTABILITY` · `blocker` · **confirmed ×2**  
**Where:** `package.json` — 10-15  
**Why it matters:** scripts has start/dev/seed/set-admin but no test script; devDependencies is absent; no test/tests/**tests**/spec directory and not a single test file exists. The objective demands code testable to professional standards, but no suite can be written or run because nothing to write/run it with is present — the baseline gap that makes other testability concerns moot until fixed.  
**Fix:** Add a runner (node:test built into Node 20, or vitest/jest), add a 'test' script (e.g. "test": "node --test" or "vitest run"), create test/, and wire it into CI so it runs on every change.

### Blocker-6 — db.js opens the real SQLite file at module-load with no injection seam; every consumer is forced onto the production DB

`TESTABILITY` · `blocker` · **confirmed ×2**  
**Where:** `src/db.js` — 12-22  
**Why it matters:** On require, db.js runs fs.mkdirSync, new Database(config.DB_PATH), db.pragma, and db.exec(schema) at top level, exporting a fully-constructed singleton bound to the on-disk DB. Merely requiring scoring.js touches the filesystem and creates app.db (+ WAL files), verified empirically. No module that requires db can be unit-tested against an isolated :memory: DB; tests mutate the real app.db, cannot run in parallel, and can't start clean. No factory, no env override, no in-memory option.  
**Fix:** Refactor into a factory: function openDb(dbPath=config.DB_PATH){ const db=new Database(dbPath); db.pragma(...); db.exec(schemaSql); return db; } Export openDb and schemaSql; keep a lazily-created default singleton for production; allow process.env.DB_PATH (and ':memory:') to override. Better, have services accept a db argument.

### Blocker-7 — DB_PATH is hard-derived with no env/config override — tests cannot redirect to an in-memory/throwaway DB

`TESTABILITY` · `blocker` · single-reviewer  
**Where:** `config.js` — 58, 72  
**Why it matters:** DATA_DIR and DB_PATH are computed from path.join(ROOT,...) and read nothing from process.env (unlike PORT/BASE_URL). better-sqlite3 supports ':memory:' for clean disposable per-test DBs, but the fixed path forces any DB-backed test to mutate the one real data/app.db, making tests stateful, order-dependent, non-parallelizable, and destructive.  
**Fix:** Read overrides in config.js: DATA_DIR: process.env.DATA_DIR || path.join(ROOT,'data'); DB_PATH: process.env.DB_PATH || path.join(DATA_DIR,'app.db'). Combine with the db-factory fix for full isolation.

### Blocker-8 — app.js calls app.listen() at module load with no require.main guard — cannot be imported for HTTP tests

`TESTABILITY` · `blocker` · **confirmed ×2**  
**Where:** `src/app.js` — 145-153  
**Why it matters:** app.listen(config.PORT,...) runs unconditionally at the bottom of the module and module.exports = app comes after, with ensureDataDirs() also running on import. So require('../src/app') immediately binds the real port and runs all load-time side effects; two test files collide on the port and run against production data. This forecloses the entire supertest integration layer (auth gating, upload flow, admin guards, redirects).  
**Fix:** Split construction from listening: build/export app (no listen, no hard dir-creation side effect) via a createApp() (optionally taking deps like db), and put app.listen in a separate server.js / bin entry guarded by if (require.main === module). Tests then do request(createApp()).

### Blocker-9 — Views reference CSS classes that do not exist in theme.css — guest pages render essentially unstyled

`UX` · `blocker` · **confirmed ×2**  
**Where:** `src/public/css/theme.css` — theme.css full vs onboard.ejs:5-52, guest-home.ejs:13-84, tasks.ejs:21-43, leaderboard.ejs:5-48  
**Why it matters:** Views and theme.css use disjoint class vocabularies. Classes like form-row/form-label/form-input, btn--primary/btn-primary, alert--error, task-row/task-link, profile-card/avatar-img, progress-bar/progress-bar-fill, badge-item, photo-grid, leaderboard-list/leaderboard-row/lb-avatar return zero matches in theme.css, which instead defines .form-group, .btn-secondary (no primary), .task-item, .progress/.progress-fill, .stat, the leaderboard as a <table>. The two stylesheets were written against different template generations and never reconciled, so the first screen a guest sees (onboarding form), the task list, the points/progress card, badge/photo grids, and the leaderboard fall back to unstyled browser defaults with no layout, spacing, or tap-target sizing — broken on phones.  
**Fix:** Pick ONE vocabulary and make markup and CSS agree. Fastest: rewrite views to use the classes theme.css already defines (form-row->form-group, btn--primary->.btn, task-row->.task-item, leaderboard-list->the .leaderboard table markup, progress-bar->.progress), add the one missing .btn-primary rule, standardize single-dash naming. Then inventory every class used in views/ and diff against theme.css selectors so every used class has a rule; verify at phone width.

### Blocker-10 — Gallery and profile thumbnails never load — gallery.js not wired up; images rely on data-src lazy-load that never runs

`UX` · `blocker` · **confirmed ×2**  
**Where:** `src/routes/community.js` — 145-152, 237-245 (render without pageScript); gallery.ejs:24-31; public-profile.ejs:79-86  
**Why it matters:** Thumbnails render as <img class="gallery-thumb js-lazy" data-src="/thumbs/..."> with no src; gallery.js sets src from data-src and wires the lightbox. But the gallery and public-profile renders pass no pageScript, and footer.ejs only emits a script when pageScript is set, so gallery.js never executes. The shared photo gallery (a headline feature) shows nothing but blank/broken boxes. (Same defect as the architecture-lens gallery.js finding, surfaced here as the UX impact.)  
**Fix:** Pass pageScript:'gallery.js' in both render calls (community.js ~145 and ~237) or hard-include <script src="/js/gallery.js" defer></script> in gallery.ejs and public-profile.ejs as task.ejs does. As defense-in-depth give each thumbnail a real src so a JS failure degrades to working images. Verify a thumbnail actually loads.

### Blocker-11 — Lightbox never opens — CSS shows it via a .open class the JS never adds

`UX` · `blocker` · single-reviewer  
**Where:** `src/public/js/gallery.js` — gallery.js:68,76,112; theme.css:443-453; gallery.ejs:67  
**Why it matters:** theme.css sets .lightbox{display:none} and .lightbox.open{display:flex} — visibility is controlled purely by the .open class. But gallery.js toggles lightbox.hidden (and a body class) and NEVER adds/removes .open, so .lightbox stays display:none and setting hidden=false has no effect. Even with gallery.js loaded, tapping a photo to enlarge would do nothing — a dead-end with no feedback for the expected phone interaction.  
**Fix:** Make JS and CSS agree on one mechanism: in gallery.js use lightbox.classList.add('open')/remove('open') instead of toggling hidden, and update the Escape/backdrop guards to test classList.contains('open'). Or add .lightbox:not([hidden]){display:flex;} to the CSS. Test open/close/Escape/backdrop.

---

## Major (23)

### Major-1 — Build-time 'sections exist yet?' scaffolding shipped into production bootstrap (conditional fs.existsSync mounts)

`ARCHITECTURE` · `major` · **confirmed ×3**  
**Where:** `src/app.js` — 62-121  
**Why it matters:** app.js gates mandatory modules on disk presence at runtime: session.js mounted only if fs.existsSync, routers via mountRouterIfPresent() that silently skips missing files, a temporary GET / placeholder, and auth.js trySaveAvatar wraps require in try/catch. In a finished app these files always exist, so the conditionals are permanently dead branches that weaken the failure mode from 'crash loudly' to 'serve a broken app quietly' (a renamed/missing route 404s instead of failing at boot).  
**Fix:** Replace conditional mounts with unconditional require()/app.use() for session.js and all four routers in the correct (load-bearing) order; delete the fs.existsSync guards, the fallback stub middleware, the temporary GET / block, and trySaveAvatar's try/catch-around-require. Keep a comment explaining why admin.js must mount before guest.js. If a module is missing the app should fail to boot.

### Major-2 — Two competing 'single sources of truth' for upload limits/types; avatar path uses a different, unfiltered limit

`ARCHITECTURE` · `major` · **confirmed ×3**  
**Where:** `src/services/photos.js` — 32-82; config.js:84-86; src/routes/auth.js:31-34  
**Why it matters:** config.js declares MAX_UPLOAD_BYTES=12MB and ALLOWED_MIME (no HEIC) claiming to be canonical; photos.js declares its OWN MAX_UPLOAD_BYTES=15MB + HEIC/HEIF, also claiming to be 'the single source of truth'. Submissions use photos.js (15MB, HEIC); avatar multer in auth.js uses config (12MB) with NO fileFilter, so avatars accept ANY mimetype up to 12MB fed to sharp. THUMB_WIDTH and BADGE_THRESHOLDS are likewise duplicated. config.js's copies are dead/misleading; a maintainer editing config.js would change avatars but not submissions.  
**Fix:** Pick one owner. Either delete MAX_UPLOAD_BYTES/THUMB_WIDTH/ALLOWED_MIME/BADGE_THRESHOLDS from config.js and import from photos.js/scoring.js, or move them all into config.js and have photos.js/scoring.js import them. Give auth.js's avatar multer the same fileFilter and byte limit as photos.js. Remove the contradictory 'single source of truth' comments.

### Major-3 — Task deletion orphans photo and thumbnail files on disk; inconsistent with guest deletion which cleans them

`ARCHITECTURE` · `major` · **confirmed ×2**  
**Where:** `src/routes/admin.js` — 407-411 vs 227-254  
**Why it matters:** POST /admin/tasks/:id/delete runs DELETE FROM tasks and nothing else. The FK ON DELETE CASCADE removes submission ROWS, but the original+thumb FILES are never unlinked, leaking every photo/thumbnail for that task onto disk forever (no row references them, so export never includes/cleans them). Guest deletion deliberately calls photos.hardDelete per submission first, so the two delete paths apply opposite disk-consistency policies.  
**Fix:** Before DELETE FROM tasks, select the task's submission ids and call photos.hardDelete(id) for each (mirroring the guest-delete loop). Better: centralize 'delete submission incl. files' in photos.js inside a transaction and call it from both delete paths so row+file removal cannot partially fail.

### Major-4 — Excel formula injection in the data export (CSV injection)

`ARCHITECTURE` · `major` · single-reviewer  
**Where:** `src/services/export.js` — 145-153 (Guests), 171-182 (Submissions), 196-204 (Badges)  
**Why it matters:** Guest names, captions, task titles, and social-link strings are written straight into worksheet cells with no neutralization. These are guest-controlled free text; a caption/name starting with =, +, -, or @ (e.g. =HYPERLINK(...) or =cmd|'/c calc'!A1) becomes an active formula when the admin opens summary.xlsx. CSV/spreadsheet formula injection (OWASP) can trigger data exfiltration or command execution on the admin's machine — the one artifact the admin opens at end of weekend.  
**Fix:** Before writing any user-derived string cell, prefix a single quote when the value starts with = + - @ tab/CR, e.g. function safeCell(v){ v=v==null?'':String(v); return /^[=+\-@\t\r]/.test(v)?"'"+v:v; } and wrap name/caption/task/social through it on all three sheets.

### Major-5 — Bonus points clamped at >=0 in storage, but admin.js comments/fallback rely on them going negative

`ARCHITECTURE` · `major` · **confirmed ×2**  
**Where:** `src/routes/admin.js` — 78-94, 267-269  
**Why it matters:** scoring.js stmtAddBonus is UPDATE guests SET bonus_points = MAX(0, bonus_points + ?) — clamped at zero. But admin.js comments state bonus 'may be negative ... does NOT clamp at 0 ... can drive a guest's bonus below zero'. Both claims are false against the SQL. admin.js's fallback pointsForGuest SQL computes completed+bonus with no MAX(0,...) guard, so the two point computations would diverge if the clamp changed. Comments contradicting code are worse than no comments.  
**Fix:** Decide the invariant once: keep the MAX(0,...) clamp and delete the 'can go negative' comments, OR remove the clamp if negative penalties are intended and make leaderboard/getPoints handle it. Then collapse admin.js's pointsForGuest/completedCount fallbacks into direct scoring.getPoints/getCompletedCount calls (the typeof probes are dead/defensive cruft).

### Major-6 — Points/completed-count logic implemented in 3-4 places with diverging behavior

`ARCHITECTURE` · `major` · **confirmed ×2**  
**Where:** `src/services/scoring.js` — scoring.js:115-120 & 251-271; admin.js:81-94; export.js:128-130; community.js leaderboard  
**Why it matters:** Total points = completed + bonus is computed in scoring.getPoints, again in scoring.leaderboard SQL, again in admin.pointsForGuest (with a fallback branch), and again in export.js. completed-count (taken_down=0) is re-issued inline in guest.js:80, admin.js:101, community.js, export.js:100-103. Four copies of the same business rule means a future scoring change must be found and edited in four places or the leaderboard, admin table, and export silently disagree. Low cohesion — the rule is not owned by one module.  
**Fix:** Make scoring.js the sole owner: export a single getPoints(guestId) and getCompletedCount(guestId); have admin.js, export.js, guest.js, community.js call them instead of inlining SQL. Remove admin.pointsForGuest's fallback SQL. Keep the leaderboard SQL but comment that it must stay equivalent to getPoints.

### Major-7 — Live COOKIE_SECRET shipped in the deliverable's .env file

`SECURITY` · `major` · **confirmed ×2**  
**Where:** `.env` — 3  
**Why it matters:** .env exists in the delivered working tree (not just .env.example) with a real 64-hex COOKIE_SECRET. It signs both guest gsid and admin cookies, so anyone who obtains it can forge a valid signed admin='1' cookie and bypass login entirely (defeating bcrypt), or forge any guest's gsid. A secret that travels with the code is compromised. (.gitignore lists .env so it is likely untracked, but it is present on disk in the artifact.)  
**Fix:** Remove the value from the distributed .env (keep only .env.example with COOKIE_SECRET= blank). Generate a fresh secret per deployment and never include it in the source bundle. Treat the leaked value as burned and rotate. Confirm git ls-files .env is empty.

### Major-8 — Cookies set with secure:false over plain HTTP — admin and guest tokens sniffable on the LAN

`SECURITY` · `major` · **confirmed ×2**  
**Where:** `src/routes/auth.js` — 20-27 (COOKIE_OPTS); 87 (gsid); 170 (admin); app.js:58-60  
**Why it matters:** COOKIE_OPTS has secure:false and the app serves plain HTTP. The threat model explicitly includes an attacker on the same network; guests reach the laptop over http on the venue wifi. Anyone passively sniffing captures the signed admin cookie (full takeover: delete guests/photo files, export all data) or any guest's gsid (account takeover). Signing prevents forgery, not replay — a captured signed cookie is fully reusable for its 14-day life.  
**Fix:** Terminate TLS end-to-end (run behind a local HTTPS reverse proxy / self-signed cert, or have the Cloudflare tunnel connect to an https origin) and set secure:true. If plain-http LAN is a hard requirement, document the network as the trust boundary.

### Major-9 — No rate limiting or lockout on POST /admin/login — unbounded brute force

`SECURITY` · `major` · **confirmed ×2**  
**Where:** `src/routes/auth.js` — 147-174  
**Why it matters:** POST /admin/login runs bcrypt.compareSync with no attempt counter, lockout, or delay (no express-rate-limit anywhere). bcrypt cost 10 is fast enough that a weak/default password (the shipped 'ButtMonster') falls quickly, and one correct guess yields full admin control (export of all guest photos+PII, mass deletion). Reachable over both LAN and the Cloudflare tunnel.  
**Fix:** Add rate limiting + lockout on POST /admin/login (e.g. express-rate-limit max ~5-10 attempts/15 min per IP with backoff). Require a strong admin password (reject short/common ones in set-admin-password.js) and raise bcrypt cost to >=12.

### Major-10 — Guest session token is the long-lived QR token itself — leak = permanent account takeover, no rotation

`SECURITY` · `major` · **confirmed ×2**  
**Where:** `src/routes/auth.js` — 79-96 (/j/:token sets gsid = guest.token); session.js:16-19  
**Why it matters:** GET /j/:token sets the guest's permanent token (the QR target, UNIQUE in guests.token) as the gsid session cookie for 14 days, and attachGuest authenticates by SELECT WHERE token=?. The URL token and session credential are identical, so any URL-leak path (screenshot/share, browser history on a borrowed phone, Referer to Google Fonts, shoulder-surfing the QR, access/tunnel logs) yields a non-expiring credential for that guest. The token never rotates; there is no logout and no way to revoke a single guest's token without deleting them. It is also a login-CSRF/fixation vector (state-changing auth over GET, Lax-prefetchable): an attacker link signs the victim into the attacker's account.  
**Fix:** Separate the one-time sign-in token from the session credential: on /j/:token mint a fresh random session id stored server-side bound to guest_id and set THAT as gsid (never the QR token). Add Referrer-Policy: no-referrer so the token isn't leaked to third-party origins. Do not blindly overwrite an existing valid gsid. Optionally make the QR token single-use/rotate after redemption.

### Major-11 — Taken-down photos remain downloadable; /uploads and /thumbs served with no access control

`SECURITY` · `major` · single-reviewer  
**Where:** `src/app.js` — 58-60 (static mounts); admin.js:515-526 (takedown only flips taken_down)  
**Why it matters:** app.use('/uploads', express.static(...)) and '/thumbs' have no auth gate. Takedown only sets taken_down=1 and keeps the file, which is still served to anyone with the URL (it is in page source as data-full). So moderation does not actually remove an inappropriate photo: every guest who loaded the gallery keeps a working link, and any non-guest on the network/tunnel with the URL can fetch any original. Defeats the stated 'moderate photos' requirement and exposes all guests' photos.  
**Fix:** Serve originals/thumbnails through an authenticated route that looks up the submission and returns 404 when taken_down=1 (admins may still see). Do not use a bare express.static mount for guest photos. For true removal, move/delete the file on takedown rather than only flipping a flag.

### Major-12 — No security response headers (no helmet: CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy)

`SECURITY` · `major` · single-reviewer  
**Where:** `src/app.js` — 42-60 (middleware stack)  
**Why it matters:** The app sets no security headers. With no Referrer-Policy the guest token in /j/<token> (and every authenticated URL) leaks via Referer to the Google Fonts origin loaded on every page. With no X-Content-Type-Options:nosniff a file served from /uploads could be MIME-sniffed; with no CSP there is no second line behind EJS escaping; with no X-Frame-Options admin pages can be framed for clickjacking. Standard hardening for any Express app.  
**Fix:** Add helmet (or set headers manually) before the routers: at minimum Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, and a restrictive Content-Security-Policy (allow/move the inline <style> in error pages and the Google Fonts links).

### Major-13 — Admin session is a static non-expiring admin=1 cookie with no server-side session/revocation

`SECURITY` · `major` · single-reviewer  
**Where:** `src/middleware/session.js` — 60-67 (requireAdmin); auth.js:170 (set)  
**Why it matters:** requireAdmin checks only req.signedCookies.admin === '1'; login sets a constant signed '1' with 14-day maxAge. The cookie carries no nonce/session id, is not invalidated server-side on logout (logout only clears it client-side), and cannot be revoked except by rotating COOKIE_SECRET (which logs out every guest too). Any party that obtains the signed value once (LAN sniff, backup, shared laptop) has permanent admin until expiry.  
**Fix:** Replace the constant flag with a server-side session: on login generate crypto.randomBytes(32), store it (sessions table or in-memory Set with expiry), set it as the signed cookie, and have requireAdmin verify it exists and is unexpired. On logout delete the server-side record so the cookie is dead even if replayed. Consider shortening maxAge to the event duration.

### Major-14 — scoring.js prepares all statements and binds recomputeAutoBadges against the singleton db at import time

`TESTABILITY` · `major` · **confirmed ×2**  
**Where:** `src/services/scoring.js` — 20, 58-92, 140-166  
**Why it matters:** scoring.js pulls the production singleton and calls db.prepare(...) for all statements at module top level, and recomputeAutoBadges = db.transaction(...) binds at import. The highest-value business logic to test (thresholds, grant/revoke idempotency, the awarded_by==='system' revoke guard, the MAX(0,...) clamp, leaderboard ordering/ties) is welded to the production DB with no way to pass a test db.  
**Fix:** After making db injectable, convert scoring.js to a factory makeScoring(db){ const stmt... = db.prepare(...); return {...}; }, keeping a thin default export wired to production. Tests build scoring over an in-memory db seeded with the badge catalog and assert grants/revokes at counts 4/5/9/10/14/15.

### Major-15 — Photo service welds fs + sharp + multer + db singleton; thumbnail/avatar/takedown logic untestable in isolation

`TESTABILITY` · `major` · **confirmed ×2**  
**Where:** `src/services/photos.js` — 47, 90-94, 181-194, 219-234, 271  
**Why it matters:** photos.js binds the db singleton, runs fs.mkdirSync at import, and calls sharp(...).toFile(...) directly against config-derived dirs in makeThumb/saveAvatar; saveAvatar also writes the DB. Time/randomness (crypto.randomBytes, Date.now) are hard-wired with no injected clock/RNG, so filename/token format and the makeUniqueToken collision-retry throw path are non-deterministic and untestable. Even the pure helpers (url builders, randomFilename, the MIME->ext map) are buried among import-time side effects.  
**Fix:** Inject db, dirs, sharp, and fs via a factory makePhotos({db, uploadsDir, thumbsDir, sharp, fs}); move fs.mkdirSync into an explicit ensureDirs(); inject rand/now seams into randomFilename and an exists-predicate + rng into makeUniqueToken so collisions can be forced; export the pure helpers from a side-effect-free submodule.

### Major-16 — export.js binds the db singleton and hard-codes UPLOADS_DIR; buildSummaryBuffer can't be tested against a seeded DB

`TESTABILITY` · `major` · **confirmed ×2**  
**Where:** `src/services/export.js` — 10, 70-94, 258-291  
**Why it matters:** export.js requires the db singleton and issues raw db.prepare(...).all() for guests/tasks/submissions/badges in buildSummaryBuffer; streamExportZip reads config.UPLOADS_DIR via fs directly. Export is a named business-logic target (the admin's end-of-weekend deliverable) and buildSummaryBuffer is the most testable piece (rows in, xlsx Buffer out, with real aggregation), but the production singleton blocks feeding it fixtures. Pure helpers safeName/extOf/fmtDate are also unreachable in isolation (extOf/fmtDate not even exported).  
**Fix:** Pass db (and uploadsDir/fs) into buildSummaryBuffer(db) / streamExportZip(res,{db,uploadsDir,fs}); split DB-gathering from workbook-shaping so a pure aggregator returns plain row arrays. Export extOf and fmtDate. Tests then seed an in-memory db, build the buffer, reload with ExcelJS, and assert sheet totals.

### Major-17 — Pure high-value logic (leaderboard ranking, progress-bar math, social-link sanitization) trapped inline in route handlers

`TESTABILITY` · `major` · **confirmed ×2**  
**Where:** `src/routes/community.js` — 166-185 (ranking); 24-86 (parseSocialLinks); guest.js:108-137 (progress math)  
**Why it matters:** The competition-ranking tie logic is inline in the /leaderboard handler; parseSocialLinks (pure URL sanitization rejecting javascript: URLs — security-relevant) is module-private (only the router is exported); the next/prev-threshold and progressPercent arithmetic is inline in guest.js's GET / handler. The most defect-prone, security-relevant logic is unreachable without standing up a live DB, rendered EJS, and fake req/res. Completed-count is also re-implemented in 3-4 places, so a test of scoring.getCompletedCount gives false confidence.  
**Fix:** Extract pure functions: rankRows(rows) and badgeProgress(completed, thresholds) into scoring.js (or a lib/ module), and parseSocialLinks into a side-effect-free util, exporting them; have handlers call them. Replace the inline completed-count copies with scoring.getCompletedCount. Unit-test with table-driven inputs (empty/all-tied/all-distinct; 0/mid-band/on-threshold/maxed).

### Major-18 — auth.js / session.js embed DB queries, fs reads, and bcrypt in route/middleware bodies with no seam

`TESTABILITY` · `major` · single-reviewer  
**Where:** `src/routes/auth.js` — 81, 112-135, 147-174; session.js:16-19,60-67  
**Why it matters:** /j/:token, POST /onboard, and POST /admin/login do inline db.prepare(...), fs.readFileSync(ADMIN_HASH_PATH), and bcrypt.compareSync, and session middleware reads cookies and hits db.prepare directly. Auth is a named test target, but the interesting decisions (unknown token->404, onboarded->redirect, missing hash->500, wrong password->401, cookie tamper handling) are bound to the production db and real admin.hash with no verifyAdminPassword/resolveGuestByToken to unit-test.  
**Fix:** Extract injectable helpers: verifyAdminPassword(plain, hash), loadAdminHash(fs, path), resolveGuestByToken(db, token); have routes call them. Make session middleware take db via closure makeSession(db). Then thin supertest integration tests (enabled by the createApp split) cover the routes.

### Major-19 — Admin views reference non-existent CSS classes — admin console renders largely unstyled

`UX` · `major` · **confirmed ×2**  
**Where:** `src/views/admin-dashboard.ejs` — admin-dashboard.ejs:5-41; admin-guests.ejs:43-105; admin-tasks.ejs:5-81; admin-photos.ejs:5-49  
**Why it matters:** Admin views use .container, .admin-table, .stat-card, .stat-number, .card-grid, .btn-small, .photo-admin-grid, .stacked-form, etc., none of which exist in theme.css (which has .data-table, .btn-sm, .stat/.stat-num). The admin runs this on a laptop all weekend to moderate photos and manage 100 guests; unstyled dense 8-column tables with full-size buttons (.btn-small falls back to bare .btn) crowd action cells and raise mis-click risk on destructive Delete/Take-down actions sitting next to benign ones.  
**Fix:** Align admin markup to existing CSS or add the missing rules: at minimum define/alias .admin-table->.data-table, .btn-small->.btn-sm, .card-grid/.stat-card, a compact cell-form layout, and add overflow-x:auto on the wide tables.

### Major-20 — Flash messages render twice on guest pages (header partial + inline view block)

`UX` · `major` · **confirmed ×2**  
**Where:** `src/views/partials/header.ejs` — header.ejs:33-37; guest-home.ejs:7-11; tasks.ejs:7-11; task.ejs:7-11; me-edit.ejs:7-11  
**Why it matters:** header.ejs renders res.locals.flash on every page, and guest-home/tasks/task/me-edit ALSO render the same flash inline at the top of <main>, so a confirmation/error (e.g. 'Photo uploaded!') appears twice stacked — looks broken, erodes trust, and pushes content below the fold on a phone. (Same as the architecture-lens duplicate-flash finding.)  
**Fix:** Render the flash in exactly one place: since the header partial already handles it for all pages, delete the inline flash blocks (lines 7-11) from guest-home.ejs, tasks.ejs, task.ejs, and me-edit.ejs. Normalize flash.type to 'ok'|'err' so the class always matches a defined style.

### Major-21 — Task photo input forces device camera via capture="environment", blocking upload of existing photos

`UX` · `major` · single-reviewer  
**Where:** `src/views/task.ejs` — 43-49  
**Why it matters:** The task photo input is <input type="file" accept="image/*" capture="environment" required>. capture instructs the browser to open the rear camera directly and on iOS Safari/Chrome Android suppresses the 'choose from library' option. Many scavenger-hunt photos are already in the camera roll or taken by a friend, so forcing the live camera is a common 'it won't let me pick a photo' dead-end for non-technical guests. The avatar input correctly omits capture.  
**Fix:** Remove capture="environment" from the task photo input. accept="image/*" alone still offers the camera as one option on mobile while preserving library/file access.

### Major-22 — Nested/unclosed <main> on every page; duplicate main landmarks

`UX` · `major` · single-reviewer  
**Where:** `src/views/partials/header.ejs` — header.ejs:39 (opens <main class="page">, never closed); footer.ejs:2 (single </main>); each view opens its own <main> at line 5  
**Why it matters:** header.ejs opens a <main> that is never closed, every view opens a second <main>, and footer.ejs closes only one. Two main landmarks is invalid HTML and confuses screen-reader landmark navigation, and the unclosed element forces browser error-recovery, stacking the header's .page max-width and the view's .page padding unpredictably. (Same defect surfaced by the architecture lens.)  
**Fix:** Choose one main wrapper: remove <main class="page"> from header.ejs and keep each view's own <main> (adjusting footer's </main> accordingly), then audit all views so exactly one <main> opens and closes per rendered page.

### Major-23 — Primary nav links are below the 44px minimum touch-target size and wrap on a phone

`UX` · `major` · single-reviewer  
**Where:** `src/public/css/theme.css` — theme.css:142-150; header.ejs:24-27  
**Why it matters:** .nav-link uses padding:6px 12px on ~16px text, giving roughly a 30px tall hit area — below the 44 CSS-px guidance (WCAG 2.5.5). The four guest tabs plus brand also wrap to a second row on a narrow phone (flex-wrap:wrap). Navigation is used on every screen one-handed at a party, so sub-44px wrapping pills cause mis-taps and a cramped header — the lens's explicit tap-target concern.  
**Fix:** Increase .nav-link to min-height:44px with vertical centering (e.g. display:inline-flex; align-items:center; padding:11px 14px) or convert the guest nav to an evenly-spaced bottom tab bar on narrow screens; verify no wrap at 360px.

---

## Minor (19)

### Minor-1 — Avatar upload paths are inconsistent (separate multer configs, no fileFilter parity, disk->buffer round trip)

`ARCHITECTURE` · `minor` · single-reviewer  
**Where:** `src/routes/auth.js` — auth.js:31-34,112; guest.js:375,424-435  
**Why it matters:** Onboarding uses a separate multer memory-storage instance with NO fileFilter (non-image fed straight to sharp). Profile edit uses photos.upload (disk storage, with fileFilter) then reads the file back into a Buffer via fs.readFileSync to call saveAvatar — a write-to-disk-then-read-back round trip purely because the paths chose different storage modes. Three field-name/storage combinations exist for conceptually one operation, increasing bug surface and giving avatar validation rules that differ by route.  
**Fix:** Unify on one avatar pipeline: single multer config (memory storage with the shared fileFilter) for both onboarding and profile-edit, normalize the field name, always call saveAvatar(buffer, guestId). Drop the disk-write-then-readback in guest.js.

### Minor-2 — Dead db.js data-access helpers duplicated by inline SQL elsewhere

`ARCHITECTURE` · `minor` · single-reviewer  
**Where:** `src/db.js` — 89-125  
**Why it matters:** db.js exports getCompletedCount, getGuestByToken, getGuestById but none are imported anywhere: scoring.js defines its own getCompletedCount, session.js queries the guest with inline SQL instead of getGuestByToken, guest.js/admin.js/community.js re-issue completed-count SQL inline. db.js is supposed to be the data-access layer but is bypassed — dead code plus duplicated logic that all must change together if the rule changes.  
**Fix:** Either delete the unused db.js helpers, or (better) make them the canonical data-access functions and have session.js/scoring.js/guest.js/community.js call them instead of inlining the same SELECTs.

### Minor-3 — attachGuest runs twice per community request (global + router-level)

`ARCHITECTURE` · `minor` · **confirmed ×2**  
**Where:** `src/app.js` — app.js:68-72; community.js:13  
**Why it matters:** app.js installs session.attachGuest globally for every request; community.js then calls router.use(attachGuest) again. For /gallery, /leaderboard, /u/:id the middleware (its guests-table SELECT, plus the flash cookie read/clear) runs twice on the same request. The second pass operates on an already-cleared flash cookie and re-sets res.locals.flash — a latent correctness smell and a sign of unclear middleware-composition ownership.  
**Fix:** Remove community.js:13 (router.use(attachGuest)); rely on the global mount in app.js. If community ever needs to run standalone, document that it depends on the global middleware, or make attachGuest a no-op when req.guest is already set.

### Minor-4 — makeThumb derives thumb filename from original, producing double/wrong extensions and tight coupling

`ARCHITECTURE` · `minor` · **confirmed ×2**  
**Where:** `src/services/photos.js` — 181-194  
**Why it matters:** makeThumb names the thumb ${originalBase}.jpg, so 'ab12-...-1719.jpg' -> '...jpg.jpg' and '.heic' -> '.heic.jpg', even though output is always JPEG. Stored verbatim in submissions.thumb_path and depended on by export/takedown/restore round-tripping. Filenames misrepresent content type and couple the thumb-naming scheme to the exact original filename across photos.js, the DB, and export.js; a future randomFilename change silently breaks the correlation.  
**Fix:** Derive the thumb name from the original's base WITHOUT its extension plus '.jpg' (path.basename(orig, path.extname(orig)) + '.jpg'), or store a single random stem in the DB and derive both paths. Ensure no collision with the original.

### Minor-5 — Flash message renders twice (header partial and several page bodies both print it)

`ARCHITECTURE` · `minor` · **confirmed ×2**  
**Where:** `src/views/partials/header.ejs` — header.ejs:33-37; guest-home.ejs:7-11; task.ejs:7-11; tasks.ejs:7-11; me-edit.ejs:7-11  
**Why it matters:** header.ejs renders the flash for every page that includes it; guest-home.ejs, task.ejs, tasks.ejs, and me-edit.ejs ALSO each render the same flash into a second .flash div in the page body. A single flash (e.g. 'Photo replaced!') is shown twice from two competing conventions for where flash lives.  
**Fix:** Render the flash in exactly one place. Since header.ejs already handles it for all pages, delete the flash blocks from guest-home.ejs, task.ejs, tasks.ejs, and me-edit.ejs.

### Minor-6 — Dead lowercase config aliases kept 'for backwards compatibility only'

`ARCHITECTURE` · `minor` · single-reviewer  
**Where:** `config.js` — 100-118  
**Why it matters:** config.js exports lowercase duplicates of every key 'for backwards compatibility ONLY', but the app reads only the UPPER_SNAKE_CASE keys, so the lowercase set is unused dead code that adds noise and implies a compatibility need that doesn't exist.  
**Fix:** Delete the lowercase alias block after confirming no consumer reads it.

### Minor-7 — Upload type validation trusts client-supplied Content-Type only; original stored and served verbatim

`SECURITY` · `minor` · **confirmed ×2**  
**Where:** `src/services/photos.js` — 135-143 (fileFilter on file.mimetype); 119-128 (ext from claimed mimetype)  
**Why it matters:** fileFilter accepts based solely on file.mimetype (browser-supplied, forgeable), and the stored extension is derived from the same forgeable value. The original is written and served directly by express.static while only the thumbnail is re-encoded. A guest can upload arbitrary bytes labeled image/jpeg, stored as .jpg; non-image payloads persist on disk and in the export ZIP, and the type guarantee the code claims is false. (Bounded by random filenames and image content-types, worse without nosniff.)  
**Fix:** After upload, verify the real type from magic bytes (the file-type package or sharp metadata) and reject anything not a genuine jpeg/png/webp/heic before keeping the original; derive the stored extension from the verified type. Combine with X-Content-Type-Options: nosniff.

### Minor-8 — All guest photos and personal data served publicly with no sign-in; /u/:id enumerable by integer id

`SECURITY` · `minor` · single-reviewer  
**Where:** `src/app.js` — 58-60 (static mounts); community.js:13,107,157,196  
**Why it matters:** /uploads and /thumbs are mounted with no auth, and /gallery, /leaderboard, /u/:guestId use only attachGuest (no requireGuest), so every guest's name, avatar, social links, points, and photos render to any unauthenticated visitor on the network or the public Cloudflare tunnel. /u/:guestId is enumerable by sequential integer id, enabling wholesale scraping of ~100 guests' PII and photos. (Partly intended as a shared gallery, but the exposure is total and unauthenticated.)  
**Fix:** Gate the community pages and the /uploads,/thumbs mounts behind requireGuest so a valid guest link is needed to view anyone's photos/profile, and restrict the Cloudflare tunnel (Cloudflare Access or non-guessable hostname). If fully public viewing is an explicit owner decision, document it; still address the integer-id enumeration.

### Minor-9 — Route handlers echo raw exception text (err.message) to users

`SECURITY` · `minor` · single-reviewer  
**Where:** `src/routes/guest.js` — 255, 379  
**Why it matters:** On a multer error the guest sees 'That photo could not be uploaded: ' + err.message (and the same for avatar), surfacing internal error strings to an attacker probing the upload endpoint. Low impact but below the bar of not echoing exception internals; the global handler is generic but these route-level handlers leak err.message.  
**Fix:** Map known multer error codes (LIMIT_FILE_SIZE, BAD_IMAGE_TYPE) to fixed user-facing strings; never concatenate raw err.message into responses; log the detail server-side.

### Minor-10 — Admin route's typeof-guarded scoring fallbacks are permanently dead and untestable

`TESTABILITY` · `minor` · single-reviewer  
**Where:** `src/routes/admin.js` — 81-107  
**Why it matters:** pointsForGuest/completedCount check typeof scoring.pointsForGuest/scoring.completedCount === 'function', but scoring.js exports getPoints/getCompletedCount (not those names), so the guard is ALWAYS false and the inline-SQL fallback ALWAYS runs. Two parallel point-computation implementations that can drift, and the guarded branch is dead code no test can ever cover as written.  
**Fix:** Delete the dead typeof guards and call scoring.getPoints(id)/scoring.getCompletedCount(id) directly — one implementation, one thing to test.

### Minor-11 — auth.js lazily require()s the photos service inside try/catch, swallowing load failures

`TESTABILITY` · `minor` · single-reviewer  
**Where:** `src/routes/auth.js` — 56-74  
**Why it matters:** trySaveAvatar does require('../services/photos') inside a try/catch that returns null on ANY require error, so a typo or load-time throw in photos.js is silently swallowed as 'no avatar service'. A test asserting onboarding saves an avatar would pass with NO avatar saved, hiding real failures and making the avatar path untestable in a trustworthy way.  
**Fix:** Require the photos service at the top of the module (or inject it). Reserve try/catch for the actual saveAvatar call, not the module require, so load failures surface.

### Minor-12 — config.js runs the .env loader and random-secret generator as import side effects (non-deterministic)

`TESTABILITY` · `minor` · single-reviewer  
**Where:** `config.js` — 45, 50-58  
**Why it matters:** loadDotEnv() runs at module top level writing into process.env, and if COOKIE_SECRET is unset crypto.randomBytes(32) generates a new secret on every import. Tests that import config (transitively, everything does) get whatever is in the real .env and a cookie secret that differs run-to-run, breaking any test that signs/verifies a cookie deterministically and coupling tests to the developer's machine.  
**Fix:** Wrap loading in buildConfig(env = process.env) returning a fresh object so tests pass a controlled env; at minimum let tests set process.env.COOKIE_SECRET before import and document it.

### Minor-13 — recomputeAutoBadges silently no-ops when the badge catalog is unseeded

`TESTABILITY` · `minor` · single-reviewer  
**Where:** `src/services/scoring.js` — 144-148  
**Why it matters:** Inside the threshold loop, const badge = stmtBadgeByCode.get(code); if (!badge) continue; — if BLOOM/BOUQUET/GARDEN rows are missing, the function returns normally having granted nothing, with no error/signal. A test that forgets to seed the catalog sees recomputeAutoBadges 'pass' while granting zero badges, masking regressions and making a missing precondition indistinguishable from a met-threshold state.  
**Fix:** Throw/log when an expected auto-badge code is absent, or return a result object ({granted, revoked, skippedMissing}) so callers/tests can assert the catalog was present.

### Minor-14 — Avatar file inputs exclude iPhone HEIC photos via a restrictive accept list

`UX` · `minor` · single-reviewer  
**Where:** `src/views/onboard.ejs` — onboard.ejs:25; me-edit.ejs ~47  
**Why it matters:** The avatar inputs use accept="image/jpeg,image/png,image/webp", which omits HEIC/HEIF — the default iPhone camera output — so most guests' existing photos are greyed out in the picker when setting a profile picture, a confusing dead end with no explanation. Inconsistent with the task input which uses accept="image/_".  
**Fix:** Use accept="image/_" for the avatar inputs in onboard.ejs and me-edit.ejs and rely on server-side validation/conversion; if HEIC must be excluded, show an explicit hint and a clear error rather than silently filtering.

### Minor-15 — Admin per-row action buttons are too small/dense for reliable tapping; destructive next to benign

`UX` · `minor` · single-reviewer  
**Where:** `src/views/admin-guests.ejs` — admin-guests.ejs:79-98; admin-tasks.ejs:57-73  
**Why it matters:** Each guest row packs several .btn-small forms (Apply, per-badge award/remove, Delete) and tasks rows have single-glyph ▲/▼ move buttons; .btn-small is undefined so they render at default size with no spacing, and a destructive Delete (permanently removes a guest's photos from disk) shares the cell with benign Save. Mis-tap risk on a touchscreen laptop. (Resolves with the admin CSS-mismatch fix.)  
**Fix:** Define .btn-small (alias .btn-sm) with min-height >=36px, add gap between sibling forms in a cell, and visually separate destructive actions.

### Minor-16 — Gallery figcaption emits two adjacent links to the same destination; task title links to the guest profile

`UX` · `minor` · single-reviewer  
**Where:** `src/views/gallery.ejs` — 33-37  
**Why it matters:** The figcaption renders <a href="/u/:guestId">task_title</a> followed by 'by <a href="/u/:guestId">guest_name</a>' — both anchors point to the same profile, and the task-title link is mislabeled (tapping the task name goes to the photographer's profile). Two redundant tap targets close together on a phone is a mis-tap hazard and confuses what each link does; public-profile.ejs already renders the task title as plain text.  
**Fix:** Make the task title plain text (or link it to /tasks/:taskId) and keep a single 'by <name>' link to the profile, mirroring public-profile.ejs.

### Minor-17 — No client-side file size/type feedback or submit-disabled state on photo upload

`UX` · `minor` · single-reviewer  
**Where:** `src/public/js/upload.js` — upload.js:30-34; task.ejs:43-50  
**Why it matters:** upload.js only generates a preview and does no size check; size/type rejection happens server-side after a multi-MB phone photo uploads over party wifi, then returns as a flash on reload. There is also no disabled/loading state on submit, so guests double-tap and may double-submit. Slow, frustrating, and no progress feedback.  
**Fix:** In upload.js validate file.size against the server limit and show an inline message before submit; on submit disable the button and show an 'Uploading…' state; display the max size as a hint under the input.

### Minor-18 — Onboarding page shows full guest navigation before the guest has set up their profile

`UX` · `minor` · single-reviewer  
**Where:** `src/views/partials/header.ejs` — header.ejs:23-28; onboard.ejs:1-3  
**Why it matters:** onboard.ejs includes the header, which renders the full guest nav (Tasks/Gallery/Leaderboard/My Profile) plus the brand link, so a first-time guest can tap away from the one required step (entering their name), producing blank names on the leaderboard/gallery. Onboarding's single job is to capture the name first.  
**Fix:** Suppress the primary nav on the onboard view (pass a hideNav flag to header or use a minimal brand-only header for pre-setup pages).

### Minor-19 — Lightbox has no focus trap and no dialog role/aria-modal

`UX` · `minor` · single-reviewer  
**Where:** `src/public/js/gallery.js` — gallery.js:63-115; gallery.ejs:67-73  
**Why it matters:** openLightbox focuses the close button and Escape closes, but Tab moves focus to the page content behind the dimmed overlay (no focus trap), and the overlay is a plain <div> without role="dialog"/aria-modal. For keyboard and screen-reader users the modal is not properly modal. Lower priority given the touch-heavy audience but a real accessibility gap.  
**Fix:** Add role="dialog" aria-modal="true" to the lightbox container and keep focus within it while open (cycle Tab between close and image, or set inert/aria-hidden on the page behind).

---

## Nit (7)

### Nit-1 — recomputeAutoBadges obligation scattered across call sites with no single enforcement point

`ARCHITECTURE` · `nit` · single-reviewer  
**Where:** `src/routes/admin.js` — admin.js:257-276,524,538; guest.js:327; scoring.js:140-166  
**Why it matters:** Badge correctness depends on every path that changes a guest's visible-submission count remembering to call recomputeAutoBadges (submit, takedown, restore each do it by hand). The obligation is duplicated across files with no enforcement; a future path that changes submission visibility and forgets will silently desync badges. Fragile cohesion around the scoring invariant.  
**Fix:** Centralize: have the submission-mutating helpers (hideSubmission/restoreSubmission, submit insert/replace) call recomputeAutoBadges themselves, or expose a single scoring.onSubmissionsChanged(guestId) that all mutators must use.

### Nit-2 — Inconsistent 404 render contract across routes

`ARCHITECTURE` · `nit` · single-reviewer  
**Where:** `src/app.js` — 126-140; guest.js:195; community.js:199  
**Why it matters:** app.js renders 404 with { url: req.originalUrl } while several routes render 404 with { title: 'Not found' }, so 404.ejs receives different locals depending on entry point and must defensively handle both being undefined or risk an EJS 'X is not defined' throw. Low-grade version of the 'pieces don't agree' problem.  
**Fix:** Standardize 404 render locals with a small render404(res) helper used everywhere, passing both title and url; guard every local in 404.ejs with typeof checks.

### Nit-3 — Per-guest N+1 badge queries; leaderboard fetches badges twice per guest

`ARCHITECTURE` · `nit` · single-reviewer  
**Where:** `src/services/scoring.js` — 251-288; community.js:157-191  
**Why it matters:** leaderboard() loops every guest issuing stmtBadgesForGuest per row, and the /leaderboard route ALSO calls loadGuestBadges(row.id) per guest a second time, so each guest is badge-queried twice per page load. Structural smell (redundant work, N+1) rather than a correctness/perf defect at the stated ~100-guest scale.  
**Fix:** Drop the badge attachment from scoring.leaderboard() (or stop re-fetching in community.js) so badges load once; optionally use a single GROUP BY guest badge query joined in.

### Nit-4 — COOKIE_SECRET fallback silently autogenerates instead of failing closed

`SECURITY` · `nit` · single-reviewer  
**Where:** `config.js` — 46-54  
**Why it matters:** If COOKIE_SECRET is unset the app generates a random secret at boot and only console.warns. Cookie signing 'works' but every restart invalidates all sessions and a real misconfiguration (lost .env) is hidden behind a warning nobody watches — should fail loudly in a security-sensitive setting.  
**Fix:** In non-dev environments, throw and refuse to start when COOKIE_SECRET is missing; keep autogenerate only behind an explicit DEV flag.

### Nit-5 — Long-lived 14-day auth cookies with no per-session revocation for a weekend event

`SECURITY` · `nit` · single-reviewer  
**Where:** `src/routes/auth.js` — 16 (COOKIE_MAX_AGE_MS = 14 days)  
**Why it matters:** Both gsid and admin cookies use a 14-day maxAge with no server-side session store, so a captured cookie stays valid for up to two weeks and a single compromised session cannot be revoked except by rotating the global secret. Unnecessarily long for a one-weekend event.  
**Fix:** Shorten maxAge to roughly the event duration (e.g. 3 days); consider a minimal server-side session table so individual sessions (especially admin) can be invalidated without rotating the secret.

### Nit-6 — Signed flash cookie is JSON.parsed and the whole object passed to the view

`SECURITY` · `nit` · single-reviewer  
**Where:** `src/middleware/session.js` — 28-37  
**Why it matters:** attachGuest does JSON.parse(rawFlash) on the signed flash cookie and assigns the parsed object to res.locals.flash, rendered escaped as _flash.msg. Signed + escaped so not exploitable today, but parsing a cookie into a rendered object is a sink that becomes dangerous if signing or escaping regresses; only type and msg are expected.  
**Fix:** After JSON.parse, whitelist the shape: read only parsed.type (coerced to 'ok'|'err') and parsed.msg (coerced to string, length-capped) rather than passing the whole parsed object to the view.

### Nit-7 — qrsheet localhost warning not hidden in the print @media rule

`UX` · `nit` · single-reviewer  
**Where:** `src/views/admin-qrsheet.ejs` — 31-38, 41-47  
**Why it matters:** The inline @media print block hides toolbar/header/footer/nav but not the .flash.flash-err localhost BASE_URL warning, so if the admin prints while BASE_URL is still localhost the red warning prints on the place-cards. (theme.css hides .flash in print, but this view's inline print rules are the authored ones for the page.)  
**Fix:** Add .flash (or a .no-print class on the warning) to the inline @media print hide list in admin-qrsheet.ejs.

---
