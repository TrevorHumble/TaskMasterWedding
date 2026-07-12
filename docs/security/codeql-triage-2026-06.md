# CodeQL Alert Triage — June 2026

> **Historical (hosting model changed 2026-07):** this document describes the original laptop + Cloudflare-tunnel deployment. Current hosting: see DESIGN.md § Hosted deployment and docs/deploy.md.

Surfaced by the CodeQL run on PR #57. Three rule classes, 34 alerts total.
Each verdict is grounded in the actual data flow; see the referenced files.

---

## js/path-injection

**Verdict: false positive**

**Alerts:** 5 — `src/services/photos.js:350` and the avatar handler in
`src/routes/guest.js`.

**Data flow.**
The flagged sinks are all `fs.unlinkSync` / `fs.readFileSync` calls that take
a filename derived from `submissions.photo_path`, `submissions.thumb_path`, or
`guests.avatar_path`.

The question is whether a client can control what gets written into those
columns. It cannot.

Every upload — task photos and profile avatars — goes through multer. The
disk-storage `filename` callback in `src/services/photos.js` (lines 123–127)
ignores `file.originalname` entirely:

```js
filename: function (req, file, cb) {
  const ext = ALLOWED_MIME_TO_EXT[file.mimetype] || '.jpg';
  cb(null, randomFilename(ext));
},
```

`randomFilename` (lines 107–111) returns
`crypto.randomBytes(8).toString('hex') + '-' + Date.now() + ext`, where `ext`
is taken from the server-side MIME allowlist, not from the client's filename.
A sample output: `a3f7b2c1d0e5f819-1751324000000.jpg`.

`req.file.filename` — and therefore `req.file.path` (multer's
`destination + filename`) — is set by this callback. The DB columns
`submissions.photo_path`, `submissions.thumb_path`, and `guests.avatar_path`
are only ever written from `req.file.filename` or the return value of
`makeThumb()` / `saveAvatar()`, both of which use `randomFilename` internally.

No client-controlled `../` segment can reach any `path.join` or `fs.*` call.

**Named sinks.**

- `src/services/photos.js:350` — `fs.unlinkSync(absOriginalPath(photoPath))` in
  `deleteOriginalFile`. `photoPath` comes from `req.file.filename` or a DB read
  of a row that was written from `req.file.filename`.
- `src/routes/guest.js` avatar handler (`POST /me/edit`, sinks at lines 427–440)
  — `fs.readFileSync(req.file.path)` and `fs.unlinkSync(req.file.path)`.
  The handler uses multer DISK storage; `req.file.path` equals `UPLOADS_DIR` +
  `randomFilename` — the path is constructed from the app-generated filename, not
  from anything the client supplied.

**Proof.** `tests/upload-filename-safety.test.js` submits two payloads as an
authenticated guest — `../../../../etc/passwd.jpg` and `..\\..\\evil.jpg` —
and reads the stored `photo_path` and `thumb_path` back from the DB. Both
assertions confirm the stored name matches `^[0-9a-f]{16}-\d+\.[a-z0-9]+$`
and contains none of `/`, `\`, or `..`. If the `filename` callback ever passed
`originalname` through, these assertions would fail.

---

## js/xss-through-dom

**Verdict: false positive**

**Alerts:** 2 — `src/public/js/gallery.js:23` and `src/public/js/upload.js:37`.

**`gallery.js:23` — `lightboxImg.src = fullSrc`.**
`fullSrc` is read from the `data-full` attribute on a button element:

```js
var full = btn.getAttribute('data-full');
```

That attribute is server-rendered by EJS with `<%=` (HTML-entity escaping),
and its value is always a `/uploads/<random>.jpg` URL built by
`photos.urlForOriginal(submission.photo_path)` — a path whose filename is the
app-generated `randomFilename` output. Even if a `javascript:` URL were somehow
injected, assigning it to `<img>.src` does not execute script. Browsers do not
run `javascript:` protocol URLs on image `src` attributes; that vector only
applies to `href` on anchors and to `iframe.src`. There is no execution path.

Captions are written with `lightboxCaption.textContent = caption || ''` (line
25), which does not parse HTML.

**`upload.js:37` — `preview.src = lastObjectUrl`.**
`lastObjectUrl` is set by `URL.createObjectURL(file)` where `file` is the
user's own locally selected file (`input.files[0]`). A `blob:` URL generated
this way is scoped to the page origin, never leaves the device, and does not
expose the filename or path of the selected file to the server or to other
users. The alert treats a user assigning a blob URL to their own preview
element as a DOM XSS sink; it is not.

---

## js/missing-rate-limiting

**Verdict: dismiss with justification (won't fix)**

**Alerts:** ~27 handlers across `admin.js`, `guest.js`, `auth.js`,
`community.js`, and `app.js`.

**Admin login is already protected.**
The only credential-guessing surface in the app is `POST /admin/login`. That
handler (`src/routes/auth.js`, lines 166–210) implements an in-process lockout:
a correct password authenticates and clears the failure counter _before_ the
lockout check fires (issue #49 rationale), so the real admin cannot be locked
out by someone else's failed attempts. Ten wrong guesses within a 15-minute
window locks the endpoint. This is adequate for a single-admin, single-event
app hosted for a few hours.

**Other handlers carry low risk without a rate limiter.**
Handlers that CodeQL flags (guest home, gallery, task list, leaderboard) fall
into two buckets:

- _Auth-gated_: most guest and admin routes sit behind `requireGuest` /
  `requireAdmin`, so an unauthenticated attacker cannot reach them at all.
- _Public but bounded_: the community routes `/gallery`, `/leaderboard`, and
  `/u/:guestId` are not auth-gated, but they are bounded, indexed in-process
  SQLite reads with no side effects — cheap enough that saturating them would
  first exhaust the attacker's own bandwidth, not the server.

The upload and export endpoints are auth-gated and size-capped.

**Adding `express-rate-limit` here is riskier than not adding it.**
The app runs behind Cloudflare. `express-rate-limit` must be configured with
`trust proxy` pointing at the correct header to see real client IPs. If that
setting is wrong — even by one level — every guest on the same network or CDN
edge node is counted as a single IP. Under load at the reception (many guests
on the venue Wi-Fi), a misconfigured limiter trips on legitimate requests and
sidelines guests from playing. That outcome violates Goal A (easy in, solid
throughout). Fixing `trust proxy` correctly requires knowing the exact number
of Cloudflare proxy hops, which varies by plan and is not stable. The risk of
a misconfigured limiter breaking the event outweighs the marginal protection
it adds to already-gated endpoints.

---

## Disposition

No alert in any of the three classes was found to be exploitable at this
application's threat model.

- No application code change is required.
- The open alerts will be dismissed in GitHub code scanning (via `gh api`) with
  the per-class reason recorded:
  - `js/path-injection` — **false positive** (backed by
    `tests/upload-filename-safety.test.js`)
  - `js/xss-through-dom` — **false positive** (img.src does not execute
    javascript: URLs; blob: URLs are local-only)
  - `js/missing-rate-limiting` — **won't fix** (admin login already has a
    DoS-safe lockout; adding express-rate-limit with incorrect trust proxy
    breaks the event)

The dismissals are a post-merge action performed by the orchestrator using `gh
api`. They are not part of this diff.

---

## 2026-07-02 — re-surfaced instance (PR #138 / issue #119)

`js/missing-rate-limiting`, alert **#42**, `src/app.js:77` — `app.use(session.attachGuest)`.

Issue #119 removed the dead `if (fs.existsSync(...))` bootstrap scaffolding and
now installs `attachGuest` directly at `src/app.js:77`. CodeQL reports an alert on
a **moved** line as "new in this PR," so the `js/missing-rate-limiting` disposition
above did not carry over automatically and the PR check went red on one high alert.

**Verdict: unchanged — won't fix / not exploitable.** Confirmed by a fresh adversarial
security review (2026-07-02, independent of the prior triage). `attachGuest` performs
a single indexed point lookup `SELECT * FROM guests WHERE token = ?`
(`src/middleware/session.js:18`; `guests.token` is `TEXT NOT NULL UNIQUE` → indexed,
`src/db.js:30`) against a ~100-row single-event table (`docs/north-star.md`). The read
is **gated behind a valid HMAC-signed `gsid` cookie**: cookie-parser sets the value to
`false` for an unsigned/tampered cookie, and the `typeof token === 'string'` guard
(`src/middleware/session.js:17`) drops it before any DB access — so an unauthenticated
flood does **zero** database work and there is no amplification. This instance is
therefore weaker than the routes already dispositioned above (it is secret-gated). A
rate limiter here (global middleware, behind Cloudflare's variable proxy-hop count)
would sideline legitimate guests on shared venue Wi-Fi (Goal A) for no real gain.

Alert #42 dismissed in code scanning via `gh api` (reason `won't fix`), pre-merge here
because the "new alert" check blocked PR #138.

---

## 2026-07 re-triage: hosted deployment

Owner direction (2026-07-07): the app moves from a Windows laptop behind a
Cloudflare quick tunnel, reachable for a few hours around the event, to a
rented host reachable on the public internet for weeks — the deployment
window is now weeks, not a single evening. Every disposition above that
reasoned from "hosted for a few hours" is re-examined against that changed
exposure. The fixes below are tracked as #283 (rate limiting + persistent
admin-lockout storage).

**`js/missing-rate-limiting` — main entry: superseded.**
The original disposition rested on "adequate for a single-admin,
single-event app hosted for a few hours" and on the risk that a
misconfigured `express-rate-limit` behind an unpredictable Cloudflare
proxy-hop count would sideline guests. Both premises changed: the app is
public for weeks, not hours, which widens the window for credential-guessing
and scraping; and the reverse-proxy hop count is now fixed and known
(`TRUST_PROXY`, recorded in the `### Hosted deployment` ADR in `DESIGN.md`),
which removes the configuration risk that justified won't-fix. This
disposition is **superseded** by #283, which adds rate limiting with a
`trust proxy` setting derived from the actual reverse proxy, not guessed.

**2026-07-02 re-surfaced instance (`js/missing-rate-limiting` alert #42,
`src/app.js:77`): superseded.**
The re-surfaced instance disposition (attachGuest's indexed, cookie-gated
lookup) held that a flood does zero DB work under the tunnel's few-hours
exposure. The lookup shape is unchanged, but weeks of public reachability
instead of hours materially raises the number of attempts an attacker can
throw at the signed-cookie guess, even though each individual request stays
cheap. This disposition is **superseded** by #283's rate limiting, which now
covers this route too rather than relying solely on the cookie gate.

**Admin login lockout adequacy note: superseded.**
The original note called the admin login lockout (ten wrong guesses per 15
minutes, counter cleared on success) adequate for "a single-admin,
single-event app hosted for a few hours." In-memory lockout state does not
survive a process restart, which was an acceptable gap for a few-hours run
and is not for a multi-week hosted run where the process may restart
(deploys, host maintenance) mid-event. This adequacy claim is **superseded**
by #283, which persists the lockout counter to SQLite so a restart does not
reset an attacker's guess budget.

**Changed exposure, summarized:** every disposition above was written
against an exposure window of hours, behind a tunnel URL that changed on
every run. The hosted deployment is reachable at a stable, public hostname
for weeks. None of the three findings were reclassified as exploitable — the
data-flow reasoning in each still holds — but the exposure window each was
scored against no longer applies, which is why each is marked superseded
rather than reaffirmed.

---

## 2026-07-10 — alert #70 (PR #391 / issue #241)

## js/user-controlled-bypass

**Verdict: false positive**

**Alerts:** 1 — `src/routes/auth.js:145`.

**Data flow.**
The flagged line is the required-field guard at the top of `POST /join`
(issue #240):

```js
if (!name) {
  setFlash(res, 'error', 'Please enter your name.');
  res.redirect('/join');
  return;
}
```

`js/user-controlled-bypass` looks for a user-controlled condition that
short-circuits a security-sensitive check — e.g. a client-supplied flag that
skips authentication or an authorization decision. `name` is exactly that: a
value the client controls. But the check it guards is not a security or
trust-boundary decision. It rejects an empty signup name before continuing
on to the fields that actually matter for identity — `normalizeContact`
(line 151) and `isValidPin` (line 158) both still run, and only after all
three pass does the handler reach the guest `INSERT`. There is no privileged
path, no authentication bypass, and no alternate branch this check unlocks;
it is ordinary required-field validation on a public signup form, gating
nothing more sensitive than "did the guest type a name."

**Provenance.** This alert did not originate in issue #241's diff — `POST
/join` and its `if (!name)` guard were introduced by issue #240, before
#241 existed. It surfaced against PR #391 (issue #241, guest login) via
CodeQL's touched-file re-attribution: #241 touches other lines in
`src/routes/auth.js`, and CodeQL attributes pre-existing alerts on that file
to whichever PR most recently modified it, not to the PR that introduced
the flagged line.

**Disposition.** Alert #70 dismissed in code scanning via `gh api` (reason
`false positive`). This entry is the durable written record; the GitHub
alert itself was already dismissed at the time of writing.

---

## 2026-07-11 — alert #71 (issue #338 comment routes)

## js/missing-rate-limiting

**Verdict:** won't fix

**Alerts:** 1 — `src/routes/community.js:527`.

**Data flow.**
The flagged handler is `POST /p/:submissionId/comments/:commentId/delete`
(lines 527–577), added by issue #338 alongside its sibling
`POST /p/:submissionId/comments` (lines 456–499). Both routes are gated by
`requireGuest`, which 403s an anonymous caller before either handler body
runs — the same auth-gated shape the original `js/missing-rate-limiting`
disposition above already covers for "most guest and admin routes." This is
not a new code defect; it is a fresh instance of that already-accepted rule
class, surfaced because CodeQL scores each new route independently rather
than recognizing it as the same shape as the routes already dispositioned.

The delete handler adds nothing that changes the calculus: it does one
indexed lookup (`SELECT id, guest_id FROM comments WHERE id = ? AND
submission_id = ?`), one ownership check, and one `DELETE ... WHERE id = ?
AND guest_id = ?` scoped to the caller's own `guest_id`. There is no
unbounded write, no cross-guest side effect, and no path an unauthenticated
caller can reach at all.

The current disposition for this rule class is **superseded** by #283 (see
the `## 2026-07 re-triage: hosted deployment` section above) — the app is
now hosted for weeks at a stable public hostname, not hours behind a
rotating tunnel URL, and #283 adds `express-rate-limit` with a `trust proxy`
setting derived from the real reverse proxy, plus persistent admin-lockout
storage. Alert #71 follows the same superseded-by-#283 path as alert #42
and the main-entry disposition: not reclassified as exploitable, just
carried by the fix already tracked and scheduled there rather than
re-litigated here.

**Disposition.** Alert #71 dismissed in code scanning via `gh api` (reason
`won't fix`), with a dismissal comment referencing #283. This entry is the
durable written record.
