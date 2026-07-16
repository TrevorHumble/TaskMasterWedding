// tests/gallery-grid.test.js
//
// Issue #81: Instagram-style photo-wall grid — the flat/grouped grids show
// photos only. Per-thumbnail captions (task title, "by <guest>", caption
// text) are gone from #galleryGrid; group headings (view=task/view=user)
// stay, since they sit outside #galleryGrid.
'use strict';

const { loadApp, seed, signInGuest } = require('./helpers/testApp');
const request = require('supertest');

let agent;
let visibleSubmissionId;
const TAKENDOWN_THUMB = 'takendown-marcus.jpg';

/**
 * Strip every HTML tag (and, with it, every attribute — alt text included)
 * from a markup fragment, leaving only the visible text nodes. Used to
 * confirm "Marcus Bell" does not leak into #galleryGrid as visible text,
 * while still allowing it inside an img alt attribute (which this strip
 * removes along with the tag it lives on).
 */
function textOnly(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

/**
 * Pull out the inner markup of every id="galleryGrid" region in rendered
 * HTML. Grouped views (view=task/view=user) render one
 * <div class="gallery-grid" id="galleryGrid"> per group, so this walks the
 * whole document collecting each one's content up to its own closing
 * </div> — safe because a gallery-grid div only ever contains
 * <figure class="gallery-item"> children, never a nested <div>, so the
 * first </div> after the opening tag is always the matching one.
 */
function galleryGridRegions(html) {
  const results = [];
  const openTag = '<div class="gallery-grid" id="galleryGrid">';
  let searchFrom = 0;
  for (;;) {
    const start = html.indexOf(openTag, searchFrom);
    if (start === -1) break;
    const contentStart = start + openTag.length;
    const end = html.indexOf('</div>', contentStart);
    results.push(html.slice(contentStart, end === -1 ? contentStart : end));
    searchFrom = end === -1 ? contentStart : end + 6;
  }
  return results;
}

beforeAll(async () => {
  const { app, db } = loadApp();
  const ids = seed(db); // task "Selfie with the cake", guest "Seed Guest"

  // Visible submission by a guest named "Marcus Bell", on its own task so
  // grouped views (view=task/view=user) each produce a distinct group.
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Cut the cake').lastInsertRowid;
  const marcusId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('marcustoken', 'Marcus Bell').lastInsertRowid;
  visibleSubmissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, ?, ?, 0, datetime('now', '+1 second'))`
    )
    .run(marcusId, taskId, 'marcus.jpg', 'marcus-thumb.jpg').lastInsertRowid;

  // Taken-down submission with a distinct thumb_path — must never render.
  // Uses seed guest + the new task (not seed guest + seed task, which is
  // already taken by seed()'s own submission — submissions has a unique
  // constraint on (guest_id, task_id)).
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 1)`
  ).run(ids.guestId, taskId, 'takendown-photo.jpg', TAKENDOWN_THUMB);

  agent = request.agent(app);
  signInGuest(app, 'seedtoken', agent);
});

// ---------------------------------------------------------------------------
// AC2 — no per-thumbnail caption in the flat (recent) grid
// ---------------------------------------------------------------------------
describe('AC2: recent view — no per-thumbnail caption', () => {
  it('#galleryGrid has no gallery-caption element', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);

    const regions = galleryGridRegions(res.text);
    expect(regions.length).toBeGreaterThan(0);
    const combined = regions.join('\n');
    expect(combined).not.toContain('gallery-caption');
  });

  it('stripped #galleryGrid text does not contain "Marcus Bell"', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);

    const regions = galleryGridRegions(res.text);
    const combinedText = textOnly(regions.join('\n'));
    // Would fail if the caption (which named the guest) were still present.
    expect(combinedText).not.toContain('Marcus Bell');
  });
});

// ---------------------------------------------------------------------------
// AC4 — each thumbnail links into the feed at that photo (repointed by #84;
// #194 added the server-resolved ?from anchor so the bounded page has it)
// ---------------------------------------------------------------------------
describe('AC4: thumbnail links to the photo', () => {
  it('response body contains href="/feed?from=<id>#photo-<id>"', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      `href="/feed?from=${visibleSubmissionId}#photo-${visibleSubmissionId}"`
    );
  });
});

// ---------------------------------------------------------------------------
// AC6 — taken-down photos never appear
// ---------------------------------------------------------------------------
describe('AC6: taken-down photos absent', () => {
  it('takendown-marcus.jpg is absent from GET /gallery', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(TAKENDOWN_THUMB);
  });
});

// ---------------------------------------------------------------------------
// AC7 — no per-thumbnail caption in grouped views; group headings remain
// ---------------------------------------------------------------------------
describe('AC7: grouped views — no per-thumbnail caption, headings remain', () => {
  it('view=task: #galleryGrid has no gallery-caption, no "Marcus Bell" text, heading intact', async () => {
    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);

    // Group heading (outside #galleryGrid) must still name the task.
    expect(res.text).toContain('<h2 class="gallery-group-heading">');
    expect(res.text).toContain('Cut the cake');

    const regions = galleryGridRegions(res.text);
    expect(regions.length).toBeGreaterThan(0);
    const combined = regions.join('\n');
    expect(combined).not.toContain('gallery-caption');
    expect(textOnly(combined)).not.toContain('Marcus Bell');
  });

  it('view=user: #galleryGrid has no gallery-caption, no "Marcus Bell" text, heading intact', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);

    // Group heading (outside #galleryGrid) must still name the guest.
    expect(res.text).toContain('<h2 class="gallery-group-heading">');
    expect(res.text).toContain('Marcus Bell');

    const regions = galleryGridRegions(res.text);
    expect(regions.length).toBeGreaterThan(0);
    const combined = regions.join('\n');
    expect(combined).not.toContain('gallery-caption');
    // The name is allowed in the heading (outside #galleryGrid) but not as
    // visible text inside the grid region itself.
    expect(textOnly(combined)).not.toContain('Marcus Bell');
  });
});

// ---------------------------------------------------------------------------
// AC1 / AC3 — structural CSS assertions (theme.css literal rules)
// ---------------------------------------------------------------------------
describe('AC1/AC3: theme.css gallery grid rules', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css'),
    'utf8'
  );

  it('base .gallery-grid is a 3-column wall whose tiles can shrink (#251)', () => {
    // minmax(0, 1fr) — not bare 1fr — is what lets tiles shrink below their
    // intrinsic size so three columns fit a 375px viewport (issue #251 AC1).
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(css).toContain('gap: 2px');
    expect(css).toContain('object-fit: cover');
    expect(css).toContain('aspect-ratio: 1');
  });

  it('.gallery-item reserves height only — no fixed intrinsic width (#251)', () => {
    // A fixed px width component here re-creates the 522px overflow.
    expect(css).toContain('contain-intrinsic-size: auto');
    expect(css).not.toMatch(/contain-intrinsic-size:\s*\d+px\s+\d+px/);
  });

  it('base .gallery-grid is full-bleed on mobile', () => {
    expect(css).toContain('width: 100vw');
    expect(css).toContain('margin-inline: calc(50% - 50vw)');
  });

  it('a @media (min-width: 700px) block caps and centres the grid', () => {
    const match = css.match(/@media \(min-width: 700px\) \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('repeat(3, minmax(0, 1fr))');
  });
});
