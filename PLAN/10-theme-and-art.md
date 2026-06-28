# 10 — Theme and Art (Garden Party Pastels)

This section delivers the visual skin for the whole app: the three shared EJS partials every page includes (`head.ejs`, `header.ejs`, `footer.ejs`), the complete stylesheet `theme.css` with the pastel palette and every styled component, and the seven placeholder badge SVGs.

You are a junior developer. Do exactly what is written, in order. Copy each file verbatim. Do not invent file names, colors, fonts, or libraries. Every path is relative to the project root `garden-party-pastels/`.

These files are owned by THIS section (per the file tree): `src/views/partials/head.ejs`, `src/views/partials/header.ejs`, `src/views/partials/footer.ejs`, `src/public/css/theme.css`, and all seven files in `src/public/badges/`. Create only these. Do not touch files owned by other sections.

---

## Step 1 — Create the folders

Open PowerShell at the project root (`garden-party-pastels/`). Run each line on its own (PowerShell does not chain with `&&`):

```powershell
# run from the project root: garden-party-pastels/
New-Item -ItemType Directory -Force -Path "src/views/partials"
New-Item -ItemType Directory -Force -Path "src/public/css"
New-Item -ItemType Directory -Force -Path "src/public/badges"
```

`-Force` makes the command safe to run even if the folder already exists; it will not delete anything.

---

## Step 2 — Create `src/views/partials/head.ejs`

This partial opens `<html>`, `<head>`, and `<body>`. Every view includes it as its first line with `<%- include('partials/head') %>`. It sets the mobile viewport, loads the two Google Fonts (Dancing Script for the script display headings, Quicksand for the rounded body), and links the stylesheet.

`title` is supplied by `res.locals` in some views; the `typeof` guard prints a sensible default when a view does not set it, so this never throws.

Create the file with exactly this content:

```ejs
<%# src/views/partials/head.ejs %>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#fbeff2">
  <title><%= (typeof title !== 'undefined' && title) ? title : 'Garden Party Pastels' %></title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500;600;700&family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/theme.css">
</head>
<body>
```

Notes for you (do not add them to the file):
- The block intentionally ends with an open `<body>` tag. `footer.ejs` closes it.
- `/css/theme.css` resolves because `app.js` (section 01) serves `src/public` as static, so `src/public/css/theme.css` is reachable at `/css/theme.css`.

---

## Step 3 — Create `src/views/partials/header.ejs`

This is the top bar plus the flash-message area. It shows the guest nav (Tasks, Gallery, Leaderboard, My Profile) on normal pages and a different nav on admin pages.

How it decides which nav to show: a view that is an admin page sets `isAdmin` to a truthy value in `res.locals` (section 08 does this). When `isAdmin` is not set we treat it as a guest/public page. We use `typeof` guards so the partial never crashes if a variable is missing.

The flash message uses `res.locals.flash` (the project's flash convention from the contract). **This is the canonical flash shape for the entire project:** it is an object like `{ type: 'ok', msg: '...' }` (where `type` is either `'ok'` for success or `'err'` for error, and `msg` is the string to display), or it may be undefined. We guard for both. Every flash producer (the `setFlash` helper in section 04's `guest.js`) and every flash consumer (the guest views in section 04, plus the flash-reading middleware in `session.js`) must use this same `{ type, msg }` shape so the message actually renders. **Note:** the admin routes (section 08) use a separate, simpler approach — they pass a plain string via `?msg=` and render it inline as `msg`; admin views do NOT read `res.locals.flash`. Those two systems are independent and must not be mixed.

Create the file with exactly this content:

```ejs
<%# src/views/partials/header.ejs %>
<%
  var _isAdmin = (typeof isAdmin !== 'undefined' && isAdmin);
  var _flash = (typeof flash !== 'undefined' && flash) ? flash : null;
  var _flashType = (_flash && _flash.type === 'err') ? 'flash-err' : 'flash-ok';
%>
<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="<%= _isAdmin ? '/admin' : '/' %>">
      <span class="brand-mark">&#10047;</span>
      <span class="brand-text">Garden Party</span>
    </a>
    <nav class="site-nav" aria-label="Primary">
      <% if (_isAdmin) { %>
        <a class="nav-link" href="/admin">Dashboard</a>
        <a class="nav-link" href="/admin/tasks">Tasks</a>
        <a class="nav-link" href="/admin/guests">Guests</a>
        <a class="nav-link" href="/admin/photos">Photos</a>
        <a class="nav-link" href="/admin/qrsheet">QR Sheet</a>
        <form class="nav-logout" method="post" action="/admin/logout">
          <button type="submit" class="nav-link nav-link-button">Log out</button>
        </form>
      <% } else { %>
        <a class="nav-link" href="/tasks">Tasks</a>
        <a class="nav-link" href="/gallery">Gallery</a>
        <a class="nav-link" href="/leaderboard">Leaderboard</a>
        <a class="nav-link" href="/">My Profile</a>
      <% } %>
    </nav>
  </div>
</header>

<% if (_flash && _flash.msg) { %>
  <div class="flash <%= _flashType %>" role="status">
    <%= _flash.msg %>
  </div>
<% } %>

<main class="page">
```

Notes for you (do not add them to the file):
- The block ends with an open `<main class="page">`. `footer.ejs` closes it.
- Admin views (section 08) set `isAdmin = true` in their render data. Guest views do not, so the else-branch (guest nav) runs.
- This partial is the reference implementation for the flash shape. It reads `flash.type` (`'ok'` or `'err'`) to pick the CSS class and `flash.msg` for the text. If you are building section 04, make sure `setFlash` writes `{ type, msg }` and the guest views read `flash.type` / `flash.msg` to match.

---

## Step 4 — Create `src/views/partials/footer.ejs`

This closes `<main>`, prints the footer text, optionally loads one page-specific client script, then closes `<body>` and `<html>`. Per the contract, a view that needs a page script sets `pageScript` to the script's **file name including the `.js` extension** (for example `pageScript = 'upload.js'` or `pageScript = 'gallery.js'`); the partial then loads `/js/<pageScript>`. If a view sets no `pageScript`, no extra script is loaded.

Create the file with exactly this content:

```ejs
<%# src/views/partials/footer.ejs %>
</main>

<footer class="site-footer">
  <p class="footer-line">Axel &amp; Lily &#183; Garden Party Scavenger Hunt</p>
</footer>

<% if (typeof pageScript !== 'undefined' && pageScript) { %>
  <script src="/js/<%= pageScript %>"></script>
<% } %>
</body>
</html>
```

Notes for you (do not add them to the file):
- `/js/<name>` resolves through the same static mount as the CSS (`src/public/js/...`).
- **The `pageScript` value MUST include the `.js` extension.** This partial builds the `src` as `/js/<%= pageScript %>` with no extension added — so you must pass `pageScript: 'gallery.js'` (not `'gallery'`, which would yield `/js/gallery` and 404) and `pageScript: 'upload.js'`. Every caller across the plan (section 07's gallery and public-profile views, etc.) must pass the name **with** `.js`.
- Avoid double-loading: a view should pick ONE mechanism. If a view already hardcodes its own `<script src="/js/upload.js" defer></script>` tag (as section 04's `task.ejs` / `me-edit.ejs` do), it must NOT also set `pageScript` for that same script, or the browser would load it twice. Either rely on the hardcoded tag and leave `pageScript` unset, or remove the hardcoded tag and set `pageScript` instead — not both.
- `&amp;` and `&#183;` are HTML entities for `&` and a middle dot. Leave them exactly as written.

---

## Step 5 — Create `src/public/css/theme.css`

This is the complete stylesheet. It defines the palette as CSS variables in `:root`, the typography (Dancing Script for headings, Quicksand for body), and mobile-first styles for every component the other sections render: buttons, cards, the task list with its done state, forms and inputs, the badge chip and badge grid, the gallery grid and lightbox, the leaderboard table, the progress bar, the nav, and print rules for the QR sheet.

Copy the entire block verbatim into the file. Do not trim, reorder, or "clean up" anything.

```css
/* src/public/css/theme.css */

/* ===========================================================
   Garden Party Pastels — theme
   Palette variables, typography, and all shared components.
   Mobile-first: base rules target phones; a single min-width
   media query widens layout on tablets/desktops.
   =========================================================== */

:root {
  /* --- Palette (soft pastels on warm cream) --- */
  --blush:    #f7c8d6;   /* blush pink   */
  --blush-deep:#ef9fb6;  /* darker blush for accents/buttons */
  --sky:      #bfe0f2;   /* sky blue     */
  --sky-deep: #8ec5e6;
  --lavender: #d7c9ef;   /* lavender     */
  --lavender-deep:#b69fe0;
  --butter:   #fbedb0;   /* butter yellow*/
  --peach:    #fbd9bf;   /* peach        */
  --peach-deep:#f3b68b;
  --sage:     #c6dcc0;   /* sage green   */
  --sage-deep:#9bc191;
  --cream:    #fdf8f1;   /* warm cream (page background) */
  --cream-soft:#fbeff2;  /* very pale pink wash */
  --card:     #ffffff;   /* card surface */
  --ink:      #5a4a55;   /* primary text — soft plum-brown, gentle on cream */
  --ink-soft: #8a7a85;   /* secondary text */
  --line:     #efe2e8;   /* hairline borders */

  /* --- Functional accents --- */
  --ok-bg:    #e3f1de;   /* success flash background (pale sage) */
  --ok-ink:   #4d7a45;
  --err-bg:   #fbe0e6;   /* error flash background (pale blush) */
  --err-ink:  #b14a64;
  --done:     var(--sage-deep);

  /* --- Type --- */
  --font-display: 'Dancing Script', 'Segoe Script', cursive;
  --font-body: 'Quicksand', 'Segoe UI', system-ui, -apple-system, sans-serif;

  /* --- Shape & shadow --- */
  --radius: 18px;
  --radius-sm: 12px;
  --shadow: 0 6px 18px rgba(160, 120, 140, 0.15);
  --shadow-soft: 0 3px 10px rgba(160, 120, 140, 0.10);

  /* --- Layout --- */
  --maxw: 760px;
  --gap: 16px;
}

/* ----------------------- Reset-ish ----------------------- */
*, *::before, *::after { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  font-family: var(--font-body);
  font-size: 17px;
  line-height: 1.5;
  color: var(--ink);
  background: var(--cream);
  background-image:
    radial-gradient(circle at 12% 8%, rgba(247,200,214,0.30), transparent 38%),
    radial-gradient(circle at 88% 4%, rgba(191,224,242,0.30), transparent 38%),
    radial-gradient(circle at 50% 100%, rgba(215,201,239,0.25), transparent 45%);
  background-attachment: fixed;
  -webkit-text-size-adjust: 100%;
}

img { max-width: 100%; display: block; }

a { color: var(--blush-deep); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ----------------------- Typography ----------------------- */
h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--ink);
  line-height: 1.15;
  margin: 0 0 0.4em;
}
h1 { font-size: 2.4rem; }
h2 { font-size: 1.9rem; }
h3 { font-size: 1.45rem; }

p { margin: 0 0 1em; }

.muted { color: var(--ink-soft); }
.center { text-align: center; }

/* ----------------------- Layout shell ----------------------- */
.page {
  display: block;
  max-width: var(--maxw);
  margin: 0 auto;
  padding: 20px 16px 48px;
}

.section { margin-bottom: 28px; }

/* ----------------------- Header / nav ----------------------- */
.site-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: rgba(253, 248, 241, 0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.site-header-inner {
  max-width: var(--maxw);
  margin: 0 auto;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
}
.brand:hover { text-decoration: none; }
.brand-mark { color: var(--blush-deep); font-size: 1.2rem; }
.brand-text {
  font-family: var(--font-display);
  font-size: 1.7rem;
  font-weight: 700;
  color: var(--ink);
}
.site-nav {
  display: flex;
  align-items: center;
  gap: 6px 10px;
  flex-wrap: wrap;
}
.nav-link {
  display: inline-block;
  padding: 6px 12px;
  border-radius: 999px;
  color: var(--ink);
  font-weight: 600;
  font-size: 0.95rem;
  white-space: nowrap;
}
.nav-link:hover {
  background: var(--cream-soft);
  text-decoration: none;
}
.nav-logout { margin: 0; }
.nav-link-button {
  border: none;
  background: var(--blush);
  color: var(--ink);
  cursor: pointer;
  font-family: var(--font-body);
}
.nav-link-button:hover { background: var(--blush-deep); }

/* ----------------------- Flash messages ----------------------- */
.flash {
  max-width: var(--maxw);
  margin: 14px auto -6px;
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  font-weight: 600;
}
.flash-ok  { background: var(--ok-bg);  color: var(--ok-ink);  }
.flash-err { background: var(--err-bg); color: var(--err-ink); }

/* ----------------------- Buttons ----------------------- */
.btn {
  display: inline-block;
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 1rem;
  line-height: 1;
  padding: 13px 22px;
  border: none;
  border-radius: 999px;
  background: var(--blush-deep);
  color: #fff;
  cursor: pointer;
  text-align: center;
  box-shadow: var(--shadow-soft);
  transition: transform 0.05s ease, filter 0.15s ease;
}
.btn:hover { filter: brightness(1.05); text-decoration: none; }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary { background: var(--sky-deep); }
.btn-sage      { background: var(--sage-deep); }
.btn-ghost {
  background: transparent;
  color: var(--ink);
  box-shadow: none;
  border: 2px solid var(--line);
}
.btn-ghost:hover { background: var(--cream-soft); }
.btn-danger { background: var(--err-ink); }
.btn-block { display: block; width: 100%; }
.btn-sm { padding: 8px 14px; font-size: 0.9rem; }

/* ----------------------- Cards ----------------------- */
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-soft);
  padding: 18px;
  margin-bottom: var(--gap);
}
.card-title { margin-top: 0; }
.card-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* ----------------------- Stat / points ----------------------- */
.stat {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 18px;
  background: var(--cream-soft);
  border-radius: var(--radius-sm);
  min-width: 90px;
}
.stat-num {
  font-family: var(--font-display);
  font-size: 2.2rem;
  font-weight: 700;
  color: var(--blush-deep);
  line-height: 1;
}
.stat-label { font-size: 0.85rem; color: var(--ink-soft); }

/* ----------------------- Progress bar ----------------------- */
.progress {
  width: 100%;
  height: 16px;
  background: var(--cream-soft);
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--blush), var(--lavender), var(--sky));
  border-radius: 999px;
  transition: width 0.4s ease;
}
.progress-caption {
  font-size: 0.85rem;
  color: var(--ink-soft);
  margin-top: 6px;
}

/* ----------------------- Task list ----------------------- */
.task-list { list-style: none; margin: 0; padding: 0; }
.task-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-bottom: 12px;
  box-shadow: var(--shadow-soft);
  text-decoration: none;
  color: var(--ink);
}
.task-item:hover { text-decoration: none; filter: brightness(0.99); }
.task-check {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid var(--line);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  color: transparent;
}
.task-body { flex: 1 1 auto; min-width: 0; }
.task-title { font-weight: 700; margin: 0; }
.task-desc {
  margin: 2px 0 0;
  font-size: 0.9rem;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-item.done {
  background: var(--ok-bg);
  border-color: var(--sage);
}
.task-item.done .task-check {
  background: var(--done);
  border-color: var(--done);
  color: #fff;
}
.task-item.done .task-title { color: var(--ok-ink); }

/* ----------------------- Forms ----------------------- */
.form-group { margin-bottom: 16px; }
label {
  display: block;
  font-weight: 600;
  font-size: 0.95rem;
  margin-bottom: 6px;
  color: var(--ink);
}
input[type="text"],
input[type="password"],
input[type="url"],
input[type="number"],
input[type="email"],
textarea,
select {
  width: 100%;
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--ink);
  background: #fff;
  border: 2px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 11px 13px;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--lavender-deep);
  box-shadow: 0 0 0 3px rgba(182, 159, 224, 0.25);
}
textarea { min-height: 90px; resize: vertical; }
input[type="file"] {
  width: 100%;
  font-family: var(--font-body);
  font-size: 0.95rem;
  padding: 8px 0;
}
.field-hint { font-size: 0.82rem; color: var(--ink-soft); margin-top: 4px; }

/* ----------------------- Avatar ----------------------- */
.avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 3px solid #fff;
  box-shadow: var(--shadow-soft);
  background: var(--cream-soft);
}
.avatar-lg { width: 110px; height: 110px; }
.avatar-sm { width: 40px; height: 40px; border-width: 2px; }

/* ----------------------- Badges ----------------------- */
.badge-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.badge-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 12px 8px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-soft);
}
.badge-chip img {
  width: 74px;
  height: 74px;
}
.badge-chip .badge-name {
  font-weight: 700;
  font-size: 0.85rem;
  line-height: 1.2;
}
.badge-chip.locked {
  opacity: 0.45;
  filter: grayscale(0.7);
}
.badge-chip .badge-by {
  font-size: 0.72rem;
  color: var(--ink-soft);
}

/* small inline badge row (e.g. on leaderboard / profile teaser) */
.badge-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.badge-row img { width: 30px; height: 30px; }

/* ----------------------- Gallery ----------------------- */
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
.gallery-item {
  position: relative;
  display: block;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--cream-soft);
  box-shadow: var(--shadow-soft);
  aspect-ratio: 1 / 1;
}
.gallery-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gallery-caption {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 6px 8px;
  font-size: 0.78rem;
  color: #fff;
  background: linear-gradient(transparent, rgba(90,74,85,0.7));
}

/* lightbox (gallery.js toggles .open) */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(90, 74, 85, 0.85);
}
.lightbox.open { display: flex; }
.lightbox img {
  max-width: 100%;
  max-height: 86vh;
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
}
.lightbox-close {
  position: absolute;
  top: 14px; right: 16px;
  font-size: 2rem;
  color: #fff;
  background: none;
  border: none;
  cursor: pointer;
  line-height: 1;
}

/* ----------------------- Leaderboard table ----------------------- */
.leaderboard {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow-soft);
}
.leaderboard th, .leaderboard td {
  padding: 12px 12px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.leaderboard th {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--ink-soft);
  background: var(--cream-soft);
}
.leaderboard tr:last-child td { border-bottom: none; }
.leaderboard .rank {
  font-family: var(--font-display);
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--blush-deep);
  width: 48px;
  text-align: center;
}
.leaderboard tr:nth-child(2) .rank { color: var(--peach-deep); }
.leaderboard .pts {
  text-align: right;
  font-weight: 700;
  white-space: nowrap;
}
.leaderboard .who {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ----------------------- Tables (admin generic) ----------------------- */
.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow-soft);
}
.data-table th, .data-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  font-size: 0.95rem;
}
.data-table th {
  background: var(--cream-soft);
  font-weight: 700;
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--ink-soft);
}

/* ----------------------- Footer ----------------------- */
.site-footer {
  text-align: center;
  padding: 24px 16px 40px;
  color: var(--ink-soft);
}
.footer-line {
  font-family: var(--font-display);
  font-size: 1.2rem;
  margin: 0;
}

/* ----------------------- Social links ----------------------- */
.social-links {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.social-links a {
  display: inline-block;
  padding: 6px 12px;
  background: var(--lavender);
  color: var(--ink);
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
}
.social-links a:hover { background: var(--lavender-deep); text-decoration: none; }

/* ----------------------- QR sheet (admin print) ----------------------- */
.qr-sheet {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.qr-card {
  border: 1px dashed var(--ink-soft);
  border-radius: var(--radius);
  padding: 16px;
  text-align: center;
  background: #fff;
  break-inside: avoid;
}
.qr-card img { width: 180px; height: 180px; margin: 0 auto; }
.qr-card .qr-name {
  font-family: var(--font-display);
  font-size: 1.6rem;
  font-weight: 700;
  margin-top: 8px;
}
.qr-card .qr-hint { font-size: 0.8rem; color: var(--ink-soft); }

@media print {
  /* Hide everything chrome-y so only the cards print */
  .site-header, .site-footer, .flash, .no-print { display: none !important; }
  body {
    background: #fff !important;
    background-image: none !important;
  }
  .page { max-width: none; padding: 0; }
  .qr-sheet { grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .qr-card { border-color: #999; }
}

/* ----------------------- Wider screens ----------------------- */
@media (min-width: 620px) {
  body { font-size: 18px; }
  h1 { font-size: 3rem; }
  h2 { font-size: 2.3rem; }
  .gallery-grid { grid-template-columns: repeat(3, 1fr); }
  .badge-grid { grid-template-columns: repeat(4, 1fr); }
  .qr-sheet { grid-template-columns: repeat(3, 1fr); }
}
```

---

## Step 6 — Create the seven badge SVG files

Each badge is a self-contained circular floral medallion drawn with the palette colors. They are placeholders but charming and distinct: a different flower shape and color scheme per badge. Each file is a single `<svg>` element with `viewBox="0 0 120 120"` so it scales cleanly to any size (the CSS sizes them to 74px etc.).

The file names MUST match the contract's `art_path` values exactly (the seed script in section 02 writes these paths into the database, and the views load them from `/badges/<name>.svg`). Confirmed mapping:

| Badge code | DB `art_path` | File you create |
|------------|---------------|-----------------|
| BLOOM | `/badges/bloom.svg` | `src/public/badges/bloom.svg` |
| BOUQUET | `/badges/bouquet.svg` | `src/public/badges/bouquet.svg` |
| GARDEN | `/badges/garden.svg` | `src/public/badges/garden.svg` |
| EARLYBIRD | `/badges/earlybird.svg` | `src/public/badges/earlybird.svg` |
| SHUTTERBUG | `/badges/shutterbug.svg` | `src/public/badges/shutterbug.svg` |
| CROWDFAV | `/badges/crowdfav.svg` | `src/public/badges/crowdfav.svg` |
| CHOICE | `/badges/choice.svg` | `src/public/badges/choice.svg` |

`/badges/...` resolves because `src/public` is served static, so `src/public/badges/bloom.svg` is reachable at `/badges/bloom.svg`.

Create each file below with exactly the content shown.

### 6.1 — `src/public/badges/bloom.svg` (First Bloom — single blush blossom)

```xml
<!-- src/public/badges/bloom.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="First Bloom badge">
  <circle cx="60" cy="60" r="56" fill="#fdf8f1" stroke="#f7c8d6" stroke-width="4"/>
  <circle cx="60" cy="60" r="44" fill="none" stroke="#d7c9ef" stroke-width="2" stroke-dasharray="3 5"/>
  <g transform="translate(60 60)">
    <g fill="#f7c8d6" stroke="#ef9fb6" stroke-width="1.5">
      <ellipse cx="0" cy="-22" rx="11" ry="18"/>
      <ellipse cx="0" cy="-22" rx="11" ry="18" transform="rotate(72)"/>
      <ellipse cx="0" cy="-22" rx="11" ry="18" transform="rotate(144)"/>
      <ellipse cx="0" cy="-22" rx="11" ry="18" transform="rotate(216)"/>
      <ellipse cx="0" cy="-22" rx="11" ry="18" transform="rotate(288)"/>
    </g>
    <circle cx="0" cy="0" r="11" fill="#fbedb0" stroke="#f3b68b" stroke-width="1.5"/>
  </g>
</svg>
```

### 6.2 — `src/public/badges/bouquet.svg` (Bouquet Builder — three flowers tied)

```xml
<!-- src/public/badges/bouquet.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Bouquet Builder badge">
  <circle cx="60" cy="60" r="56" fill="#fdf8f1" stroke="#bfe0f2" stroke-width="4"/>
  <circle cx="60" cy="60" r="44" fill="none" stroke="#c6dcc0" stroke-width="2" stroke-dasharray="3 5"/>
  <g stroke="#9bc191" stroke-width="3" stroke-linecap="round" fill="none">
    <path d="M60 86 L44 50"/>
    <path d="M60 86 L60 46"/>
    <path d="M60 86 L76 50"/>
  </g>
  <g>
    <g transform="translate(44 44)" fill="#f7c8d6" stroke="#ef9fb6" stroke-width="1.2">
      <circle cx="0" cy="-9" r="6"/><circle cx="8" cy="4" r="6"/><circle cx="-8" cy="4" r="6"/>
      <circle cx="0" cy="0" r="5" fill="#fbedb0" stroke="#f3b68b"/>
    </g>
    <g transform="translate(60 38)" fill="#d7c9ef" stroke="#b69fe0" stroke-width="1.2">
      <circle cx="0" cy="-9" r="6"/><circle cx="8" cy="4" r="6"/><circle cx="-8" cy="4" r="6"/>
      <circle cx="0" cy="0" r="5" fill="#fbedb0" stroke="#f3b68b"/>
    </g>
    <g transform="translate(76 44)" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="1.2">
      <circle cx="0" cy="-9" r="6"/><circle cx="8" cy="4" r="6"/><circle cx="-8" cy="4" r="6"/>
      <circle cx="0" cy="0" r="5" fill="#fbedb0" stroke="#f3b68b"/>
    </g>
  </g>
  <path d="M50 84 Q60 92 70 84" fill="none" stroke="#f3b68b" stroke-width="4" stroke-linecap="round"/>
</svg>
```

### 6.3 — `src/public/badges/garden.svg` (Full Garden — row of flowers on grass)

```xml
<!-- src/public/badges/garden.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Full Garden badge">
  <circle cx="60" cy="60" r="56" fill="#fdf8f1" stroke="#c6dcc0" stroke-width="4"/>
  <path d="M14 78 Q60 70 106 78 L106 92 Q60 86 14 92 Z" fill="#c6dcc0"/>
  <g stroke="#9bc191" stroke-width="2.5" stroke-linecap="round" fill="none">
    <path d="M38 80 L38 56"/><path d="M60 82 L60 50"/><path d="M82 80 L82 56"/>
  </g>
  <g transform="translate(38 50)" fill="#f7c8d6" stroke="#ef9fb6" stroke-width="1.2">
    <circle cx="0" cy="-8" r="5"/><circle cx="7" cy="3" r="5"/><circle cx="-7" cy="3" r="5"/>
    <circle cx="0" cy="0" r="4.5" fill="#fbedb0" stroke="#f3b68b"/>
  </g>
  <g transform="translate(60 44)" fill="#fbedb0" stroke="#f3b68b" stroke-width="1.2">
    <circle cx="0" cy="-9" r="6"/><circle cx="9" cy="3" r="6"/><circle cx="-9" cy="3" r="6"/>
    <circle cx="5" cy="-5" r="6"/><circle cx="-5" cy="-5" r="6"/>
    <circle cx="0" cy="0" r="5" fill="#f3b68b" stroke="#ef9fb6"/>
  </g>
  <g transform="translate(82 50)" fill="#d7c9ef" stroke="#b69fe0" stroke-width="1.2">
    <circle cx="0" cy="-8" r="5"/><circle cx="7" cy="3" r="5"/><circle cx="-7" cy="3" r="5"/>
    <circle cx="0" cy="0" r="4.5" fill="#fbedb0" stroke="#f3b68b"/>
  </g>
  <circle cx="92" cy="34" r="7" fill="#fbedb0" stroke="#f3b68b" stroke-width="1.5"/>
</svg>
```

### 6.4 — `src/public/badges/earlybird.svg` (Early Bird — sunrise + little bird)

```xml
<!-- src/public/badges/earlybird.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Early Bird badge">
  <circle cx="60" cy="60" r="56" fill="#fbedb0" stroke="#f3b68b" stroke-width="4"/>
  <path d="M14 72 A46 46 0 0 1 106 72 Z" fill="#fbd9bf"/>
  <circle cx="60" cy="72" r="16" fill="#fbedb0" stroke="#f3b68b" stroke-width="2"/>
  <g stroke="#f3b68b" stroke-width="3" stroke-linecap="round">
    <path d="M60 50 L60 40"/><path d="M38 60 L30 54"/><path d="M82 60 L90 54"/>
    <path d="M46 53 L40 46"/><path d="M74 53 L80 46"/>
  </g>
  <line x1="14" y1="74" x2="106" y2="74" stroke="#9bc191" stroke-width="3" stroke-linecap="round"/>
  <g transform="translate(78 40)">
    <ellipse cx="0" cy="0" rx="11" ry="8" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="1.5"/>
    <circle cx="6" cy="-3" r="5" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="1.5"/>
    <circle cx="7" cy="-4" r="1.4" fill="#5a4a55"/>
    <path d="M11 -3 L17 -1 L11 1 Z" fill="#f3b68b"/>
    <path d="M-2 -1 Q-10 -8 -8 2 Z" fill="#8ec5e6"/>
  </g>
</svg>
```

### 6.5 — `src/public/badges/shutterbug.svg` (Shutterbug — pastel camera)

```xml
<!-- src/public/badges/shutterbug.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Shutterbug badge">
  <circle cx="60" cy="60" r="56" fill="#fdf8f1" stroke="#bfe0f2" stroke-width="4"/>
  <rect x="30" y="46" width="60" height="38" rx="8" fill="#d7c9ef" stroke="#b69fe0" stroke-width="2"/>
  <rect x="48" y="38" width="24" height="12" rx="4" fill="#d7c9ef" stroke="#b69fe0" stroke-width="2"/>
  <circle cx="60" cy="65" r="14" fill="#fdf8f1" stroke="#8ec5e6" stroke-width="3"/>
  <circle cx="60" cy="65" r="7" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="2"/>
  <circle cx="60" cy="65" r="2.5" fill="#fdf8f1"/>
  <circle cx="80" cy="54" r="3" fill="#fbedb0" stroke="#f3b68b" stroke-width="1.5"/>
  <g fill="#fbedb0" stroke="#f3b68b" stroke-width="1">
    <circle cx="40" cy="34" r="2.2"/><circle cx="86" cy="40" r="2.2"/><circle cx="34" cy="58" r="2"/>
  </g>
</svg>
```

### 6.6 — `src/public/badges/crowdfav.svg` (Crowd Favorite — heart in floral wreath)

```xml
<!-- src/public/badges/crowdfav.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Crowd Favorite badge">
  <circle cx="60" cy="60" r="56" fill="#fdf8f1" stroke="#ef9fb6" stroke-width="4"/>
  <g>
    <circle cx="60" cy="14" r="5" fill="#f7c8d6" stroke="#ef9fb6" stroke-width="1.2"/>
    <circle cx="93" cy="27" r="5" fill="#d7c9ef" stroke="#b69fe0" stroke-width="1.2"/>
    <circle cx="106" cy="60" r="5" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="1.2"/>
    <circle cx="93" cy="93" r="5" fill="#fbedb0" stroke="#f3b68b" stroke-width="1.2"/>
    <circle cx="60" cy="106" r="5" fill="#f7c8d6" stroke="#ef9fb6" stroke-width="1.2"/>
    <circle cx="27" cy="93" r="5" fill="#c6dcc0" stroke="#9bc191" stroke-width="1.2"/>
    <circle cx="14" cy="60" r="5" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="1.2"/>
    <circle cx="27" cy="27" r="5" fill="#fbd9bf" stroke="#f3b68b" stroke-width="1.2"/>
  </g>
  <path d="M60 84 C40 68 36 54 48 48 C56 44 60 52 60 52 C60 52 64 44 72 48 C84 54 80 68 60 84 Z"
        fill="#f7c8d6" stroke="#ef9fb6" stroke-width="2"/>
</svg>
```

### 6.7 — `src/public/badges/choice.svg` (Task Master's Choice — ribbon rosette with star)

```xml
<!-- src/public/badges/choice.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Task Master's Choice badge">
  <circle cx="60" cy="60" r="56" fill="#fdf8f1" stroke="#d7c9ef" stroke-width="4"/>
  <path d="M48 70 L40 104 L54 96 L58 108 L66 80 Z" fill="#bfe0f2" stroke="#8ec5e6" stroke-width="1.5"/>
  <path d="M72 70 L80 104 L66 96 L62 108 L54 80 Z" fill="#f7c8d6" stroke="#ef9fb6" stroke-width="1.5"/>
  <g>
    <circle cx="60" cy="50" r="30" fill="#fbedb0" stroke="#f3b68b" stroke-width="2"/>
    <circle cx="60" cy="50" r="22" fill="#fdf8f1" stroke="#f3b68b" stroke-width="1.5" stroke-dasharray="2 4"/>
  </g>
  <path d="M60 33 L65 46 L79 46 L68 54 L72 67 L60 59 L48 67 L52 54 L41 46 L55 46 Z"
        fill="#f3b68b" stroke="#ef9fb6" stroke-width="1.2"/>
</svg>
```

---

## Acceptance check

Do these steps exactly and confirm each expected result.

1. Confirm all ten files exist. From the project root in PowerShell, run:

   ```powershell
   Get-ChildItem -Path `
     "src/views/partials/head.ejs", `
     "src/views/partials/header.ejs", `
     "src/views/partials/footer.ejs", `
     "src/public/css/theme.css", `
     "src/public/badges/bloom.svg", `
     "src/public/badges/bouquet.svg", `
     "src/public/badges/garden.svg", `
     "src/public/badges/earlybird.svg", `
     "src/public/badges/shutterbug.svg", `
     "src/public/badges/crowdfav.svg", `
     "src/public/badges/choice.svg" | Select-Object Name, Length
   ```

   Expected: all eleven names listed, every `Length` greater than 0. (Eleven items: the three partials, the stylesheet, and the seven badges.) If any line errors with "Cannot find path", you missed that file — create it.

2. Confirm the badge file names match the contract exactly (lowercase, no typos). List the badges folder:

   ```powershell
   Get-ChildItem -Path "src/public/badges" -Name
   ```

   Expected, exactly these seven names: `bloom.svg`, `bouquet.svg`, `choice.svg`, `crowdfav.svg`, `earlybird.svg`, `garden.svg`, `shutterbug.svg`. No extras, no capital letters.

3. Confirm each SVG is valid XML (it parses without error). Run:

   ```powershell
   Get-ChildItem "src/public/badges/*.svg" | ForEach-Object {
     try { [xml](Get-Content $_.FullName -Raw) | Out-Null; "OK  $($_.Name)" }
     catch { "BAD $($_.Name): $($_.Exception.Message)" }
   }
   ```

   Expected: seven lines, every one starting with `OK`. Any line starting with `BAD` means you altered that SVG's text — re-copy it verbatim.

4. Visual check in the running app (this depends on sections 01–04 being built so a page exists to render the partials). Once `npm start` is running (`http://localhost:3000`), open a guest or admin page in a browser and confirm:
   - The page background is warm cream with faint pastel corner glows.
   - Headings render in the flowing script font (Dancing Script); body text is the rounded Quicksand font. If both look like a plain default serif/sans, the Google Fonts `<link>` in `head.ejs` did not load — recheck Step 2.
   - The sticky top bar shows the brand and the nav links (Tasks / Gallery / Leaderboard / My Profile on guest pages; Dashboard / Tasks / Guests / Photos / QR Sheet / Log out on admin pages).

5. Quick badge render check without the full app: open any badge file directly in a browser. In PowerShell run:

   ```powershell
   Start-Process "src/public/badges/bloom.svg"
   ```

   Expected: a circular blush-pink five-petal flower medallion on a cream disc. Repeat for the others if you want; each should look distinct (bouquet = three tied flowers, garden = flower row on grass, earlybird = sunrise with a small blue bird, shutterbug = lavender camera, crowdfav = heart in a flower wreath, choice = star rosette with ribbon tails).
