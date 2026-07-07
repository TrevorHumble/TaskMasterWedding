# Design Philosophy — Worked Examples

**As the reviewer applying `standards/design-philosophy.md`, I need one worked Flag/Clean pair per red flag, so that I match findings to real patterns instead of over-flagging style or missing genuine defects.**

Each section: a `Flag` block (a **hypothetical counter-design** in this repo's idiom — the shape the repo avoids; its file and column names are illustrative, not the app's schema), a `Clean` block (the corrected shape — where the repo's real code has this shape, the real file is named), and a `Not a finding:` guard naming a nearby pattern that does NOT qualify.

---

### shallow module

Flag — the interface is as complex as what it hides; every internal knob is a parameter:

```js
function saveThumb(srcPath, dstDir, width, height, fit, quality, format) {
  return sharp(srcPath)
    .resize(width, height, { fit })
    .toFormat(format, { quality })
    .toFile(path.join(dstDir, path.basename(srcPath)));
}
```

Clean — one decision the caller cares about; the sizing policy lives inside (the repo's real shape, simplified: `makeThumb(originalPath)` in `src/services/photos.js`, whose `THUMB_WIDTH` and `THUMB_JPEG_QUALITY` are module-private constants and only the directory comes from config):

```js
// Sizing policy is this module's decision: callers say what, not how.
const THUMB_WIDTH = 400;
const THUMB_JPEG_QUALITY = 78;
function makeThumb(originalPath) {
  const absThumb = path.join(THUMBS_DIR, path.basename(originalPath) + '.jpg');
  return sharp(originalPath)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_JPEG_QUALITY })
    .toFile(absThumb);
}
```

Not a finding: a function with several parameters is not automatically shallow — flag it only when the parameters re-expose decisions the module exists to own (sizing policy above), not when they carry genuinely caller-owned data (the source path).

---

### information leakage

Flag — a hypothetical counter-design: two routes each re-derive the "visible submission" rule instead of asking the module that owns it:

```js
// hypothetical routeA.js
const rows = db.prepare('SELECT * FROM submissions WHERE taken_down = 0 AND guest_id = ?').all(id);
// hypothetical routeB.js — the same visibility decision, re-stated and free to drift
const rows = db
  .prepare('SELECT * FROM submissions WHERE taken_down = 0 AND task_id = ?')
  .all(taskId);
```

Clean — the repo's real shape: the visibility rule (`taken_down = 0`) is applied inside the scoring/badge services (`src/services/badges.js` — "restricted to VISIBLE rows … matching the canonical visibility rule used everywhere else in scoring"), and callers consume the computed result, never the rule:

```js
// src/services/badges.js owns "visible"; callers consume computed holder sets
// from its registry (TRANSFERABLE_BADGES: code -> () => Set<guestId>).
const holders = TRANSFERABLE_BADGES[code]();
```

Not a finding: two modules both importing `config.js` is not leakage — config is the sanctioned shared surface. Leakage requires an _internal representation decision_ (storage format, encoding, a filter rule like visibility) reappearing outside its owner.

---

### temporal decomposition

Flag — modules named for when they run, so one format decision smears across all three:

```js
// step1-load.js, step2-transform.js, step3-write.js
// step2 must know step1 returned CSV rows; step3 must know step2 kept the header row.
```

Clean — modules named for what they hide; order of operations is an implementation detail:

```js
// guest-import.js — owns the file format end to end
function importGuests(csvPath) {
  /* parse, normalize, insert; format never escapes */
}
```

Not a finding: a pipeline that genuinely IS sequential (multer → sharp → disk) may be written as ordered steps inside one module; the flag is structure that forces _knowledge_ of one step's internals into another module, not the mere existence of an order.

---

### pass-through

Flag — a layer that renames the layer below and adds nothing:

```js
function getGuest(id) {
  return db.getGuestById(id);
}
```

Clean — the layer earns its place by changing the abstraction (error contract, shape, policy):

```js
// Returns a guest or throws (NotFound is an illustrative error type) —
// callers never see undefined.
function requireGuest(id) {
  const g = db.getGuestById(id);
  if (!g) throw new NotFound(`No guest with id ${id}`);
  return g;
}
```

Not a finding: a thin wrapper that fixes an argument, narrows a type, or exists to be the single future seam for a policy (and says so) adds abstraction; the flag is forwarding with a new name and nothing else.

---

### vague name

Flag — the name forces the reader to trace the data flow to learn what it holds:

```js
const data = getData(req);
const tmp = process(data);
res.json(tmp);
```

Clean — the names state what the things are:

```js
const uploadMeta = parseUploadFields(req);
const savedPhoto = storePhoto(uploadMeta);
res.json(savedPhoto);
```

Not a finding: a short name with a one-line scope and an obvious source (`for (const row of rows)`) is fine — the flag is genericness that survives past the point a reader needs to know the meaning, not brevity itself.
