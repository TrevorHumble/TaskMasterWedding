# 07 — Shared Gallery, Leaderboard & Public Profiles

This section builds the three public community pages and the client-side gallery behavior:

- **GET /gallery** — one big shared photo wall (every visible submission, newest first).
- **GET /leaderboard** — all guests ranked by points, with avatars and badge icons.
- **GET /u/:guestId** — a public profile for any guest (avatar, name, social links, badges, photos).

You will create:

1. `src/routes/community.js` — the router with the three routes.
2. `src/views/gallery.ejs` — the gallery page.
3. `src/views/leaderboard.ejs` — the leaderboard page.
4. `src/views/public-profile.ejs` — a public guest profile page.
5. `src/public/js/gallery.js` — lazy-loading images + a click-to-enlarge lightbox.

Then you will wire the router into `src/app.js` with a small "ADD THIS" snippet, and verify everything with the Acceptance check at the bottom.

> **Important conventions you must follow (from the project foundation):**
> - The gallery and leaderboard are **public** (per the spec: "one big shared gallery everyone can see" and a "public leaderboard"). They use `attachGuest` so `res.locals.guest` is populated **when** a guest is signed in, but they do **not** require a guest. The public profile (`/u/:guestId`) is also public. `attachGuest` is exported from `src/middleware/session.js` (built in section 03).
> - `better-sqlite3` is **synchronous**. Use `db.prepare(...).all(...)` / `.get(...)` / `.run(...)`. There is **no `async`/`await`** for database calls.
> - The database handle is exported as a **named** export from `src/db.js`: `module.exports = { db, ... }`. Always import it with destructuring — `const { db } = require('../db');` — otherwise `db.prepare` is undefined and every query throws.
> - Photos that have been taken down (`submissions.taken_down = 1`) must be **hidden everywhere** — gallery, profiles, and the photo count. Every query below filters with `taken_down = 0`.
> - Thumbnails are served from `/thumbs/<filename>` and full-size originals from `/uploads/<filename>`. The database stores only the **relative filename** in `thumb_path` and `photo_path`; you prepend the route prefix in the view.
> - `photos.js` (section 05) generates **URL-safe filenames** (crypto-hex + digits + dot extension, e.g. `a1b2-1719.jpg` or `a1b2-1719.heic.jpg`). Because those names never contain characters that need escaping, this section does **not** wrap them in `encodeURIComponent` — and neither do sections 04 or 08. Keeping all views consistent (raw `<%= ... %>` in the path) means the whole app behaves the same way if the filename scheme ever changes.
> - Badge art lives at `/badges/<file>.svg` and the path is stored in `badges.art_path` (already including the leading `/badges/`).
> - Views use the shared partials: `partials/head`, `partials/header`, `partials/footer` (built in section 10). `res.locals.guest` and `res.locals.flash` are available to every view automatically.
> - `social_links` is stored as a **JSON string** in `guests.social_links` (e.g. `{"instagram":"...","website":"..."}`). You must `JSON.parse` it and render it as safe links.

---

## Step 1 — Create the community router

Create the file **`src/routes/community.js`** with the exact contents below.

This router:

- Imports the synchronous database handle from `src/db.js` (built in section 02) **with destructuring** (`const { db } = require('../db');`) and the `attachGuest` middleware from `src/middleware/session.js` (built in section 03).
- Imports `scoring.leaderboard()` and `scoring.getPoints()` from `src/services/scoring.js` (built in section 06) for the leaderboard ranking and the profile point total.
- Leaves the routes **public** (no `requireGuest`); `attachGuest` populates `res.locals.guest` when a guest cookie is present so the leaderboard can still mark the viewer's own row.
- Builds all gallery/profile data with plain SQL queries that filter out taken-down photos.
- Sanitizes social links so a guest cannot inject a dangerous URL (only `http:`, `https:`, and `mailto:` are allowed).

```javascript
// src/routes/community.js
'use strict';

const express = require('express');
const { db } = require('../db');
const { attachGuest } = require('../middleware/session');
const scoring = require('../services/scoring');

const router = express.Router();

// Community pages are public, but we still attach the guest (when signed in)
// so the leaderboard can highlight the viewer's own row.
router.use(attachGuest);

// How many gallery thumbnails to load per "page" (used for pagination links).
const GALLERY_PAGE_SIZE = 60;

/**
 * Parse a guest's social_links JSON string into a safe array of links.
 * Only http/https/mailto URLs are kept; everything else is dropped so a
 * guest cannot inject a "javascript:" or other dangerous URL.
 * Returns: [{ key, label, href, display }]
 */
function parseSocialLinks(raw) {
  let obj;
  try {
    obj = JSON.parse(raw || '{}');
  } catch (e) {
    obj = {};
  }
  if (!obj || typeof obj !== 'object') {
    return [];
  }

  const labels = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    twitter: 'Twitter / X',
    tiktok: 'TikTok',
    linkedin: 'LinkedIn',
    website: 'Website',
    email: 'Email'
  };

  const out = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      continue;
    }

    let href = trimmed;
    // Bare email address -> mailto link.
    if (key === 'email' && !/^mailto:/i.test(href) && href.includes('@')) {
      href = 'mailto:' + href;
    }
    // Bare domain/handle for non-email -> assume https.
    if (key !== 'email' && !/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
      href = 'https://' + href;
    }

    // Final safety check: only allow http, https, mailto.
    let ok = false;
    try {
      const proto = new URL(href).protocol;
      ok = proto === 'http:' || proto === 'https:' || proto === 'mailto:';
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      continue;
    }

    out.push({
      key,
      label: labels[key] || key,
      href,
      display: trimmed
    });
  }
  return out;
}

/**
 * Load the badges a guest currently holds, joined to the badge catalog so we
 * have name + art_path for display. Newest awards first.
 */
function loadGuestBadges(guestId) {
  return db
    .prepare(
      `SELECT b.code, b.name, b.art_path, b.type, gb.awarded_by, gb.created_at
         FROM guest_badges gb
         JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ?
        ORDER BY gb.created_at ASC, b.id ASC`
    )
    .all(guestId);
}

// ---------------------------------------------------------------------------
// GET /gallery  — the shared photo wall (all visible submissions, newest first)
// ---------------------------------------------------------------------------
router.get('/gallery', (req, res) => {
  // Total number of visible photos, used to compute pagination.
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0`)
    .get();
  const total = totalRow ? totalRow.n : 0;

  // Current page (1-based). Defaults to 1 if missing or invalid.
  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }
  const totalPages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
  if (page > totalPages) {
    page = totalPages;
  }
  const offset = (page - 1) * GALLERY_PAGE_SIZE;

  // One row per visible submission, joined to its uploader and task title.
  const photos = db
    .prepare(
      `SELECT s.id            AS submission_id,
              s.thumb_path    AS thumb_path,
              s.photo_path    AS photo_path,
              s.caption       AS caption,
              s.created_at    AS created_at,
              g.id            AS guest_id,
              g.name          AS guest_name,
              t.title         AS task_title
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         JOIN tasks  t ON t.id = s.task_id
        WHERE s.taken_down = 0
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(GALLERY_PAGE_SIZE, offset);

  res.render('gallery', {
    title: 'Gallery',
    photos,
    page,
    totalPages,
    total
  });
});

// ---------------------------------------------------------------------------
// GET /leaderboard  — all guests ranked by points
// ---------------------------------------------------------------------------
router.get('/leaderboard', (req, res) => {
  // scoring.leaderboard() returns rows already ordered best-first, each with:
  //   { id, name, avatar_path, points, completed }
  // NOTE: the completed-task count is keyed `completed` (not completed_count)
  // in section 06's query — read row.completed here.
  const rows = scoring.leaderboard();

  // Attach rank (with ties sharing a rank) and each guest's badge icons.
  let lastPoints = null;
  let lastRank = 0;
  const ranked = rows.map((row, index) => {
    let rank;
    if (lastPoints === null || row.points !== lastPoints) {
      rank = index + 1; // standard competition ranking (1,2,2,4,...)
      lastRank = rank;
      lastPoints = row.points;
    } else {
      rank = lastRank;
    }
    return {
      rank,
      id: row.id,
      name: row.name,
      avatar_path: row.avatar_path,
      points: row.points,
      completed_count: row.completed,
      badges: loadGuestBadges(row.id)
    };
  });

  res.render('leaderboard', {
    title: 'Leaderboard',
    rows: ranked
  });
});

// ---------------------------------------------------------------------------
// GET /u/:guestId  — public profile for any guest
// ---------------------------------------------------------------------------
router.get('/u/:guestId', (req, res, next) => {
  const guestId = parseInt(req.params.guestId, 10);
  if (!Number.isInteger(guestId) || guestId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const profileGuest = db
    .prepare(
      `SELECT id, name, avatar_path, social_links, bonus_points, created_at
         FROM guests
        WHERE id = ?`
    )
    .get(guestId);

  if (!profileGuest) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // This guest's score, for display on the profile header.
  // scoring.getPoints(guestId) is the real API from section 06.
  const score = { points: scoring.getPoints(guestId) };

  const badges = loadGuestBadges(guestId);
  const socialLinks = parseSocialLinks(profileGuest.social_links);

  // Visible photos by this guest, newest first, with the task title.
  const photos = db
    .prepare(
      `SELECT s.id         AS submission_id,
              s.thumb_path AS thumb_path,
              s.photo_path AS photo_path,
              s.caption    AS caption,
              s.created_at AS created_at,
              t.title      AS task_title
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
        WHERE s.guest_id = ? AND s.taken_down = 0
        ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(guestId);

  res.render('public-profile', {
    title: profileGuest.name || 'Guest',
    profileGuest,
    badges,
    socialLinks,
    photos,
    score
  });
});

module.exports = router;
```

> **Note on the point total:** Section 06 (`src/services/scoring.js`) owns the scoring service and exposes `getPoints(guestId)` (returns a number) and `leaderboard()` (returns rows keyed `{ id, name, avatar_path, points, completed }`). The profile route above calls `scoring.getPoints(guestId)` and wraps it as `{ points }` so the view can show the total. The leaderboard maps `row.completed` into `completed_count` for the view. If section 06 ever renames these, update this file to match — the names must agree across both sections.

---

## Step 2 — Create the gallery view

Create **`src/views/gallery.ejs`** with the exact contents below.

Each thumbnail:

- Uses `loading="lazy"` and a `data-src` attribute (the real image URL). `gallery.js` swaps `data-src` into `src` as the image scrolls into view.
- Links the caption/task line to the uploader's public profile (`/u/:guestId`).
- Carries the full-size original URL in `data-full` so the lightbox can show the big version on click.

```html
<!-- src/views/gallery.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container gallery-page">
  <h1 class="display-heading">Gallery</h1>
  <p class="subtle">
    <%= total %> photo<%= total === 1 ? '' : 's' %> from the garden party.
  </p>

  <% if (photos.length === 0) { %>
    <p class="empty-state">No photos yet. Be the first to share one!</p>
  <% } else { %>
    <div class="gallery-grid" id="galleryGrid">
      <% photos.forEach(function (p) { %>
        <figure class="gallery-item">
          <button
            type="button"
            class="gallery-thumb-btn js-lightbox"
            data-full="/uploads/<%= p.photo_path %>"
            data-caption="<%= p.task_title %><%= p.caption ? ' — ' + p.caption : '' %>"
            aria-label="Enlarge photo for <%= p.task_title %>"
          >
            <img
              class="gallery-thumb js-lazy"
              data-src="/thumbs/<%= p.thumb_path %>"
              alt="<%= p.task_title %>"
              loading="lazy"
              width="400"
              height="400"
            />
          </button>
          <figcaption class="gallery-caption">
            <a class="gallery-task" href="/u/<%= p.guest_id %>"><%= p.task_title %></a>
            <span class="gallery-by">by
              <a href="/u/<%= p.guest_id %>"><%= p.guest_name || 'Guest' %></a>
            </span>
            <% if (p.caption) { %>
              <span class="gallery-text"><%= p.caption %></span>
            <% } %>
          </figcaption>
        </figure>
      <% }); %>
    </div>

    <% if (totalPages > 1) { %>
      <nav class="pagination" aria-label="Gallery pages">
        <% if (page > 1) { %>
          <a class="page-link" href="/gallery?page=<%= page - 1 %>">&larr; Newer</a>
        <% } else { %>
          <span class="page-link disabled">&larr; Newer</span>
        <% } %>

        <span class="page-status">Page <%= page %> of <%= totalPages %></span>

        <% if (page < totalPages) { %>
          <a class="page-link" href="/gallery?page=<%= page + 1 %>">Older &rarr;</a>
        <% } else { %>
          <span class="page-link disabled">Older &rarr;</span>
        <% } %>
      </nav>
    <% } %>
  <% } %>
</main>

<!-- Lightbox overlay (hidden until a thumbnail is clicked). -->
<div class="lightbox" id="lightbox" hidden>
  <button type="button" class="lightbox-close" id="lightboxClose" aria-label="Close">&times;</button>
  <figure class="lightbox-figure">
    <img class="lightbox-img" id="lightboxImg" alt="" />
    <figcaption class="lightbox-caption" id="lightboxCaption"></figcaption>
  </figure>
</div>

<%- include('partials/footer') %>
```

> **Why a `<button>` around the thumbnail?** It makes the click-to-enlarge keyboard-accessible (Enter/Space activate buttons) without extra JavaScript. The footer partial loads the page-specific script; see Step 5 for how to make sure `gallery.js` is loaded on these pages.

---

## Step 3 — Create the leaderboard view

Create **`src/views/leaderboard.ejs`** with the exact contents below.

```html
<!-- src/views/leaderboard.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container leaderboard-page">
  <h1 class="display-heading">Leaderboard</h1>

  <% if (rows.length === 0) { %>
    <p class="empty-state">No guests yet.</p>
  <% } else { %>
    <ol class="leaderboard-list">
      <% rows.forEach(function (r) { %>
        <li class="leaderboard-row<%= (guest && guest.id === r.id) ? ' is-me' : '' %>">
          <span class="rank rank-<%= r.rank <= 3 ? r.rank : 'n' %>">
            <%= r.rank %>
          </span>

          <a class="lb-guest" href="/u/<%= r.id %>">
            <% if (r.avatar_path) { %>
              <img class="lb-avatar"
                   src="/uploads/<%= r.avatar_path %>"
                   alt=""
                   width="48" height="48" />
            <% } else { %>
              <span class="lb-avatar lb-avatar-empty" aria-hidden="true">
                <%= (r.name || '?').trim().charAt(0).toUpperCase() || '?' %>
              </span>
            <% } %>
            <span class="lb-name"><%= r.name || 'Guest' %></span>
          </a>

          <span class="lb-badges">
            <% r.badges.forEach(function (b) { %>
              <img class="lb-badge-icon"
                   src="<%= b.art_path %>"
                   alt="<%= b.name %>"
                   title="<%= b.name %>"
                   width="28" height="28" />
            <% }); %>
          </span>

          <span class="lb-points">
            <strong><%= r.points %></strong>
            <span class="lb-points-label">pt<%= r.points === 1 ? '' : 's' %></span>
          </span>
        </li>
      <% }); %>
    </ol>
  <% } %>
</main>

<%- include('partials/footer') %>
```

> `guest` here is `res.locals.guest` (the currently signed-in guest, set by `attachGuest` middleware) and may be `undefined` if the visitor has not scanned a link — the `guest && ...` guard handles that. The row for the viewer themselves gets the `is-me` class so the theme (section 10) can highlight it.
>
> The `completed_count` value (mapped from section 06's `row.completed`) is available on each row if you want to display a task count; this view shows points only, but the data is there.

---

## Step 4 — Create the public profile view

Create **`src/views/public-profile.ejs`** with the exact contents below.

```html
<!-- src/views/public-profile.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container profile-page">
  <header class="profile-header">
    <% if (profileGuest.avatar_path) { %>
      <img class="profile-avatar"
           src="/uploads/<%= profileGuest.avatar_path %>"
           alt="<%= profileGuest.name || 'Guest' %>"
           width="120" height="120" />
    <% } else { %>
      <span class="profile-avatar profile-avatar-empty" aria-hidden="true">
        <%= (profileGuest.name || '?').trim().charAt(0).toUpperCase() || '?' %>
      </span>
    <% } %>

    <div class="profile-meta">
      <h1 class="display-heading profile-name"><%= profileGuest.name || 'Guest' %></h1>
      <% if (score && typeof score.points === 'number') { %>
        <p class="profile-points">
          <strong><%= score.points %></strong>
          pt<%= score.points === 1 ? '' : 's' %>
        </p>
      <% } %>

      <% if (socialLinks.length > 0) { %>
        <ul class="profile-socials">
          <% socialLinks.forEach(function (s) { %>
            <li>
              <a class="social-link social-<%= s.key %>"
                 href="<%= s.href %>"
                 target="_blank"
                 rel="noopener noreferrer nofollow">
                <%= s.label %>
              </a>
            </li>
          <% }); %>
        </ul>
      <% } %>
    </div>
  </header>

  <section class="profile-badges">
    <h2 class="section-heading">Badges</h2>
    <% if (badges.length === 0) { %>
      <p class="subtle">No badges yet.</p>
    <% } else { %>
      <ul class="badge-grid">
        <% badges.forEach(function (b) { %>
          <li class="badge-item">
            <img class="badge-art"
                 src="<%= b.art_path %>"
                 alt="<%= b.name %>"
                 title="<%= b.name %>"
                 width="72" height="72" />
            <span class="badge-name"><%= b.name %></span>
          </li>
        <% }); %>
      </ul>
    <% } %>
  </section>

  <section class="profile-photos">
    <h2 class="section-heading">Photos</h2>
    <% if (photos.length === 0) { %>
      <p class="subtle">No photos shared yet.</p>
    <% } else { %>
      <div class="gallery-grid" id="galleryGrid">
        <% photos.forEach(function (p) { %>
          <figure class="gallery-item">
            <button
              type="button"
              class="gallery-thumb-btn js-lightbox"
              data-full="/uploads/<%= p.photo_path %>"
              data-caption="<%= p.task_title %><%= p.caption ? ' — ' + p.caption : '' %>"
              aria-label="Enlarge photo for <%= p.task_title %>"
            >
              <img
                class="gallery-thumb js-lazy"
                data-src="/thumbs/<%= p.thumb_path %>"
                alt="<%= p.task_title %>"
                loading="lazy"
                width="400"
                height="400"
              />
            </button>
            <figcaption class="gallery-caption">
              <span class="gallery-task"><%= p.task_title %></span>
              <% if (p.caption) { %>
                <span class="gallery-text"><%= p.caption %></span>
              <% } %>
            </figcaption>
          </figure>
        <% }); %>
      </div>
    <% } %>
  </section>
</main>

<!-- Lightbox overlay (shared markup with the gallery page). -->
<div class="lightbox" id="lightbox" hidden>
  <button type="button" class="lightbox-close" id="lightboxClose" aria-label="Close">&times;</button>
  <figure class="lightbox-figure">
    <img class="lightbox-img" id="lightboxImg" alt="" />
    <figcaption class="lightbox-caption" id="lightboxCaption"></figcaption>
  </figure>
</div>

<%- include('partials/footer') %>
```

---

## Step 5 — Make sure `gallery.js` loads on these pages

The footer partial (`src/views/partials/footer.ejs`, owned by section 10) is responsible for loading the page-specific client script. The convention there is `<script src="/js/<%= pageScript %>">` — the footer does **not** append `.js` itself, so the value you pass **must already include the `.js` extension**. If you pass `'gallery'` you get `src="/js/gallery"`, which 404s.

There are two acceptable ways to satisfy this. **Use whichever matches how section 10 wrote the footer**; do not rewrite the footer here.

**Option A (preferred) — the footer already loads a script named after the view.** If section 10's footer loads `/js/<viewName>.js` automatically, no change is needed for the gallery, but the profile page's script name will not match. In that case use Option B.

**Option B — pass a `pageScript` local.** If section 10's footer loads `<script src="/js/<%= typeof pageScript !== 'undefined' ? pageScript : '' %>">` (no extension appended by the footer), then add the local — **with the `.js` extension** — in the render calls. **ADD THIS** to the relevant render calls in `src/routes/community.js` (add `pageScript: 'gallery.js'` to each):

```javascript
// ADD THIS to src/routes/community.js — include pageScript in each res.render
// In the /gallery handler:
res.render('gallery', {
  title: 'Gallery',
  pageScript: 'gallery.js',
  photos,
  page,
  totalPages,
  total
});

// In the /u/:guestId handler:
res.render('public-profile', {
  title: profileGuest.name || 'Guest',
  pageScript: 'gallery.js',
  profileGuest,
  badges,
  socialLinks,
  photos,
  score
});
```

> The leaderboard page does **not** need `gallery.js` (no thumbnails to lazy-load or enlarge), so leave its render call without `pageScript`.
>
> **If you are unsure which option section 10 used:** the simplest guaranteed approach is to add a single line at the very bottom of `src/views/gallery.ejs` and `src/views/public-profile.ejs`, *just before* `<%- include('partials/footer') %>`:
> ```html
> <script src="/js/gallery.js" defer></script>
> ```
> This always works because `gallery.js` is written to be safe when its target elements are absent (it checks for them first). Do this only if the footer does not already load the script; loading it twice is harmless but unnecessary.

---

## Step 6 — Create the client-side gallery script

Create **`src/public/js/gallery.js`** with the exact contents below. It does two independent things and is safe to load on any page (it checks for its elements before acting):

1. **Lazy-load** — uses `IntersectionObserver` to swap `data-src` into `src` only when a thumbnail nears the viewport. Falls back to loading everything immediately if `IntersectionObserver` is unavailable.
2. **Lightbox** — clicking (or pressing Enter/Space on) a thumbnail button shows the full-size image in an overlay; Escape, the close button, or clicking the backdrop closes it.

```javascript
// src/public/js/gallery.js
(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // 1) LAZY-LOADING THUMBNAILS
  // -----------------------------------------------------------------------
  function loadImage(img) {
    var src = img.getAttribute('data-src');
    if (src) {
      img.src = src;
      img.removeAttribute('data-src');
    }
  }

  function initLazyLoad() {
    var lazyImages = document.querySelectorAll('img.js-lazy[data-src]');
    if (lazyImages.length === 0) {
      return;
    }

    // No IntersectionObserver support -> just load them all now.
    if (typeof window.IntersectionObserver !== 'function') {
      for (var i = 0; i < lazyImages.length; i++) {
        loadImage(lazyImages[i]);
      }
      return;
    }

    var observer = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            loadImage(entry.target);
            obs.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '200px 0px', threshold: 0.01 }
    );

    lazyImages.forEach(function (img) {
      observer.observe(img);
    });
  }

  // -----------------------------------------------------------------------
  // 2) LIGHTBOX (click-to-enlarge)
  // -----------------------------------------------------------------------
  function initLightbox() {
    var lightbox = document.getElementById('lightbox');
    var lightboxImg = document.getElementById('lightboxImg');
    var lightboxCaption = document.getElementById('lightboxCaption');
    var closeBtn = document.getElementById('lightboxClose');

    // If this page has no lightbox markup, do nothing.
    if (!lightbox || !lightboxImg || !lightboxCaption) {
      return;
    }

    var lastFocused = null;

    function openLightbox(fullSrc, caption) {
      lastFocused = document.activeElement;
      lightboxImg.src = fullSrc;
      lightboxImg.alt = caption || '';
      lightboxCaption.textContent = caption || '';
      lightbox.hidden = false;
      document.body.classList.add('lightbox-open');
      if (closeBtn) {
        closeBtn.focus();
      }
    }

    function closeLightbox() {
      lightbox.hidden = true;
      lightboxImg.src = '';
      lightboxImg.alt = '';
      lightboxCaption.textContent = '';
      document.body.classList.remove('lightbox-open');
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
    }

    // Open when any thumbnail button is activated.
    var buttons = document.querySelectorAll('.js-lightbox');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var full = btn.getAttribute('data-full');
        var caption = btn.getAttribute('data-caption') || '';
        if (full) {
          openLightbox(full, caption);
        }
      });
    });

    // Close on the close button.
    if (closeBtn) {
      closeBtn.addEventListener('click', closeLightbox);
    }

    // Close when clicking the dark backdrop (but not the image/caption).
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) {
        closeLightbox();
      }
    });

    // Close on Escape.
    document.addEventListener('keydown', function (e) {
      if (!lightbox.hidden && (e.key === 'Escape' || e.key === 'Esc')) {
        closeLightbox();
      }
    });
  }

  // -----------------------------------------------------------------------
  // BOOTSTRAP
  // -----------------------------------------------------------------------
  function init() {
    initLazyLoad();
    initLightbox();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

---

## Step 7 — Wire the router into the app

The community router must be mounted in `src/app.js` (owned by section 01). **ADD THIS** to `src/app.js`, alongside the other router mounts (after the auth/guest routers are mounted, before the 404 handler). Mount it at the root path `/` because its routes already include their full paths (`/gallery`, `/leaderboard`, `/u/:guestId`):

```javascript
// NO CHANGE NEEDED in src/app.js — section 01's app.js auto-mounts
// routes/community.js at '/' as soon as the file exists. Do NOT add an
// explicit app.use here (it would double-mount the community router).
```

> Order matters only relative to the 404 handler: the community router must be mounted **before** the catch-all 404. It can be mounted in any order relative to the guest/auth routers because their paths do not collide (`/gallery`, `/leaderboard`, `/u/...` are unique to this router).

---

## Step 8 — Run the app

From the project root in **PowerShell** (do not chain with `&&`):

```powershell
npm install
node scripts/set-admin-password.js ButtMonster
node scripts/seed.js
npm start
```

The app listens on `http://localhost:3000`.

To have data to look at, you need at least one guest with a photo. If sections 03–06 are in place: open `/admin`, log in with `ButtMonster`, create a guest, open that guest's link (`/j/<token>`), onboard, and submit a photo on a task. Then test the community pages below.

---

## Acceptance check

Do each of these and confirm the expected result. The gallery, leaderboard, and public profiles are **public** — you do not need to be signed in as a guest to view them. (Signing in as a guest does add the `is-me` highlight on your own leaderboard row.)

1. **Gallery loads and shows visible photos.**
   - Visit `http://localhost:3000/gallery`.
   - **Expected:** A responsive grid of thumbnails, newest first. Each tile shows the task title and uploader name, and the names/titles link to `/u/<guestId>`. If there are no photos yet, you see "No photos yet. Be the first to share one!"

2. **Lazy-load works.**
   - Open the browser dev tools **Network** tab, filter to **Img**, and reload `/gallery` with many photos present.
   - Scroll down slowly.
   - **Expected:** Thumbnail requests fire as you scroll (not all at once on load). Each `img.js-lazy` loses its `data-src` and gains a real `src` as it appears.

3. **Lightbox works (mouse + keyboard).**
   - Click any thumbnail.
   - **Expected:** A dark overlay appears showing the **full-size** image (`/uploads/...`, not the thumbnail) with the task title (and caption if any) underneath.
   - Press **Escape**, click the **×**, or click the dark area around the image.
   - **Expected:** The overlay closes each way. Pressing **Tab** to a thumbnail and pressing **Enter** also opens it.

4. **Taken-down photos are hidden.**
   - In `/admin/photos` (section 08), take down one photo, then reload `/gallery`.
   - **Expected:** That photo is gone from the grid and the total count drops by one. It is also gone from the uploader's `/u/<id>` profile.

5. **Leaderboard ranks correctly.**
   - Visit `http://localhost:3000/leaderboard`.
   - **Expected:** Guests listed best-first with rank number, avatar (or a letter placeholder), name, their badge icons, and point total. Guests with equal points share the same rank. If you are signed in as a guest, your own row is marked (has the `is-me` class — visible once section 10's CSS styles it).

6. **Public profile renders.**
   - From the gallery or leaderboard, click a guest to reach `http://localhost:3000/u/<guestId>`.
   - **Expected:** The page shows that guest's avatar, name, point total (from `scoring.getPoints`), any social links as clickable external links (opening in a new tab), their badges with art, and their visible photos in the same lazy/lightbox grid.

7. **Bad profile id is handled.**
   - Visit `http://localhost:3000/u/999999` (an id that does not exist) and `http://localhost:3000/u/abc`.
   - **Expected:** A 404 page (the shared `404.ejs`), not a server error or a blank page.

8. **Social links are safe.**
   - As a guest, edit your profile (section 04) and set a website to something like `javascript:alert(1)`, save, then view your `/u/<id>`.
   - **Expected:** The dangerous link is **dropped** (not rendered). A normal value like `instagram.com/you` renders as `https://instagram.com/you`.

9. **Public access works without a guest cookie.**
   - Open a private/incognito window (no guest cookie) and visit `/gallery` and `/leaderboard`.
   - **Expected:** Both pages render normally — they are public per the spec. The leaderboard simply shows no `is-me` highlight because there is no signed-in guest.
