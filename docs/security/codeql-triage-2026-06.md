# CodeQL Alert Triage — June 2026

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
