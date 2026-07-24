# Lilly &amp; Axel — Wedding Web App Design System

A small, focused design system for a **mobile-first wedding website / web app**. The aesthetic is _quiet, elegant, clean white, all-serif, forest green_. One decorative motif only: the **heart**. No watercolor florals, no busy ornament — restraint is the brand.

> This file is portable. Another agent (or Claude Code) can read it top-to-bottom and build on-brand screens without seeing the originals. Concrete token values live in `styles.css`; this doc explains how to use them and why.

> **Reconciled against the shipped app (2026-07-24, #833).** The shipped app (`src/public/css/theme.css`) is Wedding Master, a photo-task scavenger-hunt game — a different product shape than the RSVP/Schedule/Travel/Registry marketing-site sketch this document originally described (§ 10 below). Sections 1–9 (color, type, motif, spacing, components) are the real, shipped, owner-approved system; corrections below bring their specifics in line with `theme.css` as built. § 10's screen inventory is retitled as an out-of-scope sketch — this build does not include those screens (per `docs/north-star.md`, the shift here is guests playing a game at the reception, not RSVP/Travel/Registry planning pages).

---

## 1. Brand at a glance

- **Couple:** Lilly &amp; Axel (formal: _Lillian &amp; Axel_)
- **Event:** August 7–9, 2026 · Priest Lake, ID
- **Feel:** garden-formal, calm, warm-but-restrained, grown-up. Think a single sprig of green on heavy cream paper — not a flower wall.
- **One rule above all:** _when in doubt, remove something._ White space is the primary design element.

---

## 2. Color

| Token                                 | Hex       | Role                                                            |
| ------------------------------------- | --------- | --------------------------------------------------------------- |
| `--green-700` `--color-primary`       | `#467058` | **Primary.** Names, headings, body text, buttons, links, icons. |
| `--green-900` `--color-primary-hover` | `#2a4335` | Button **hover / press**, strongest ink.                        |
| `--green-500` `--color-text-muted`    | `#6e8478` | Muted body, secondary labels, captions.                         |
| `--green-300` `--color-hairline`      | `#aebbb2` | Hairlines, dividers, placeholder text, disabled.                |
| `--green-50` `--color-surface`        | `#f0f4f2` | **Accent.** Card / panel / input-well fills on white.           |
| `--white` `--color-bg`                | `#ffffff` | **Background** and secondary color.                             |

**Usage rules**

- The page background is **always white**. `--green-50` is the _only_ fill used to separate a region (cards, input wells — the "RSVP panel" from the § 10 sketch does not exist in this app).
- Text lives in the green family — `--green-700` for almost everything, `--green-500` for supporting copy. Avoid pure black.
- **Buttons** are solid `--green-700`, white label, hover to `--green-900`. That is the primary call-to-action treatment; the shipped app also has owner-approved secondary treatments for lower-emphasis or destructive actions — see § 6 Components.
- No gradients. **Gold and ember are the two owner-approved exceptions** to "no second accent hue" — both are intentional, scoped additions, not omissions: gold marks a 1st-place/winner moment (leaderboard rank, slideshow champion), ember marks a live flash-task countdown. Each is scoped to its one meaning, never used as a general decorative accent. See `styles.css` for the hex values and scoping note. Outside of those two cases, use _weight, size, and space_ for emphasis — not a new color.

---

## 3. Typography

All-serif, self-hosted (see `styles.css` — the app never fetches a font over the network at the venue). Three families:

- **Display — `Cormorant Garamond`** (`--font-display`): high-contrast, elegant. Used for couple names, page titles, day headers, and dates (the "countdown date" use is from the § 10 sketch — this app has no countdown). Often **UPPERCASE** with letter-spacing for names/titles; mixed-case for dates.
- **Body — `EB Garamond`** (`--font-body`): warm, readable. Paragraphs, event details, form labels, meta.
- **Wordmark — `Wedding Script`** (`--font-script`): an owner-approved third family, scoped to exactly one use — the "Wedding Master" site wordmark (`.brand-script`). Never used for headings, body copy, or any other text; the display/body pair above still governs everything else.

**Scale** (`--fs-*`): display 56 · h1 34 · h2 24 · h3 19 · body 18 · small 15 · eyebrow 13.

**Conventions**

- **Couple names / hero:** Cormorant, uppercase, `--tracking-display`, weight 500–600, flanked by hearts (see Motif).
- **Page &amp; day titles** (e.g. "FRIDAY, AUGUST 7, 2026"): Cormorant, uppercase, centered, weight 500. Numerals read beautifully in this face — don't avoid them.
- **Event titles** (e.g. "Welcome Dinner and Campfire"): EB Garamond or Cormorant, weight 600, mixed case, centered.
- **Eyebrows / nav / meta:** uppercase, 13px, `--tracking-eyebrow` (0.22em), `--green-500`.
- **Body:** EB Garamond 18px, line-height 1.6, `--green-700`. Centered for ceremonial content (hero, schedule); left-aligned for dense reading (FAQ answers).
- **Addresses / links inline:** italic + underline, `--green-700`.
- Never use a sans-serif. Never use Inter/Roboto/Arial.

---

## 4. The heart motif (the only ornament)

A solid forest-green heart is the brand's signature. Use it as:

1. **Name flankers** — a heart on each side of "LILLY" and "AXEL" (hero, password gate).
2. **Section glyphs** — a small heart (or a thin pair of overlapping outline hearts) centered above a section as a divider.
3. **The ampersand line** — a small "&amp;" in Cormorant italic sits between the two name rows.

Solid heart SVG (24×24), fill with `currentColor` in `--green-700`:

```html
<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor">
  <path
    d="M12 21s-8.5-5.3-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 15.7 12 21 12 21z"
  />
</svg>
```

Rules: hearts are **solid green** at name-scale, or **thin-stroke outline** when used as a small section divider. Never red. Never more than a pair together. No other emoji or icon-as-decoration.

---

## 5. Spacing, radius, layout

- **8pt spacing scale** (`--space-1`…`--space-9`). Be generous: ceremonial screens breathe with `--space-8`/`--space-9` between blocks.
- **Mobile-first.** Design canvas is `--app-max-width` (430px); side gutter `--gutter` (24px). On wider screens, center the column and keep the white margins.
- **Radius:** inputs &amp; buttons `--radius-input` (4px, barely rounded); cards/panels `--radius-card` (14px); pills only for chips/toggles.
- **Hairlines** (`--green-300`) separate list rows, 1px only. (The active nav-item underline is a heavier 2px `--color-primary` rule, not a hairline — see § 6 Components.)
- **Shadows are rare.** Flat by default. Use `--shadow-card` for a lifted panel, `--shadow-raise` for a sheet/menu overlay. Never a heavy drop shadow.

---

## 6. Components (behaviour spec)

Build these with inline styles referencing the tokens. Keep them flat and centered.

- **Button (primary):** solid `--green-700`, label in `--font-body` weight 600, `--color-on-primary`, padding `14px 28px`, radius `--radius-input`. Hover/press → `--green-900`. Full-width on mobile forms; auto-width inline. No icon needed.
- **Button variants (owner-approved, shipped beyond the original primary-only spec):** `.btn-secondary` (lower emphasis, non-destructive alternative action), `.btn-ghost` (borderless/tertiary), `.btn-danger` (destructive actions — delete, take-down), `.btn-sm` (compact, dense admin rows), `.btn-block` (full-width), `.btn-sage` (a muted secondary accent). Each is a deliberate addition for a real recurring need (an admin row needs a small destructive action next to a benign one, a dense table needs a compact button) — not a departure from "one call-to-action treatment": the primary green button is still the only _emphasis_ treatment; the variants exist to de-emphasize or warn.
- **Text input:** white fill, `--border-hairline`, radius `--radius-input`, **13px 16px padding** (as shipped — the original `styles.css` spec said 14px on all sides; corrected here), 18px serif text. Placeholder in `--green-300`. Focus → border `--green-700`. A PIN/password field shows an eye/eye-off reveal toggle (`.pin-reveal`) on the right — masked (green-tinted dots) by default, tap to reveal in place; the input itself always renders as real, readable text server-side so the field works with JavaScript off (progressive enhancement, `src/public/js/pin-field.js`). Inputs sit inside a `--green-50` well on ceremonial screens.
- **Card / panel:** `--green-50` fill, radius `--radius-card`, padding `--space-5`–`--space-6`. Optional `--shadow-card`.
- **Nav:** centered wordmark (Cormorant/script uppercase) with a horizontal link row beneath on desktop; on mobile collapse to a **hamburger** opening a centered serif menu sheet. The active item's underline is **2px** solid `--color-primary` (corrected from the original 1px spec). The link set is app-specific — see the shipped nav in `src/views/partials/header.ejs`, not a fixed list here (§ 10 below explains why the original Home/Schedule/Travel/Registry/RSVP link set does not apply to this app).
- **Countdown** and **Schedule item** — OUT OF SCOPE SKETCH (see § 10): neither a live event countdown nor a Schedule page exists in this app; these two component specs describe the RSVP-style companion-site sketch, not anything built here.
- **Section divider:** small centered heart (or outline-heart pair) with generous vertical space.

---

## 7. Content &amp; tone

- **Voice:** warm, gracious, first-person-plural ("Join us…", "we celebrate"). Speaks _to_ the guest. Never corporate, never cute-overload.
- **Casing:** UPPERCASE for names, page titles, day headers; Title Case for event names; sentence case for descriptions.
- **Dates:** "AUGUST 7 – 9, 2026" (display); "Friday, August 7, 2026" (day header). Place: "Priest Lake, ID".
- **Examples** (voice/tone reference; the "Password gate" and "Schedule blurb" examples below are from the § 10 out-of-scope sketch — this app's actual sign-in is a name/contact/PIN join-and-login flow, not a single shared invitation password):
  - Password gate: _"Check your invitation for the password. If you cannot find it, contact Lilly or Axel."_
  - Hero: _"Join us for a wedding weekend!"_
  - Schedule blurb: _"Join us for a relaxed lakeside welcome with drinks, light bites, and a campfire. Come comfortable — this is your chance to settle in, reconnect, and ease into the weekend."_
- **No emoji.** The heart motif is rendered as an SVG/glyph element, never the 🤍/❤️ emoji.

---

## 8. Motion

Subtle and soft. Use `--ease-soft`. Fades and short slides only (menu sheet, screen transitions). Countdown ticks without animation. Buttons transition `background-color` over `--dur-fast`. No bounce, no parallax, no auto-playing motion on ceremonial screens.

---

## 9. Files in this system

- `styles.css` — all design tokens + self-hosted `@font-face` declarations. **Import this.**
- `DESIGN_SYSTEM.md` — this guide.
- `SKILL.md` — portable skill wrapper (for Claude Code / Agent Skills).
- `Wedding Screens.dc.html` — interactive example: the key mobile screens (password gate, home + live countdown, schedule, RSVP, FAQ) on a pannable canvas. Edit these together to refine the system.

---

## 10. Screen inventory — OUT OF SCOPE SKETCH, not built

The list below (password gate, home/landing with RSVP, Schedule, Travel, Registry, Things to
Do, FAQs, RSVP form) was the original screen inventory for a wedding **marketing/information
site**. **This build is a different product — a photo scavenger-hunt game (Wedding Master:
tasks, points, badges, gallery, leaderboard, admin) — and does not include any of these
screens**, per `docs/north-star.md`: the shift this app designs for is a guest playing a game
at the reception, not planning travel or RSVPing on a wedding website. None of the screens
below exist in `src/views/`; do not build against this list. It is kept only as a sketch of
what a _different_, RSVP-style companion site could look like on this same visual system, in
case one is ever scoped as its own project:

Password gate · Home/landing (hero + date + place + live countdown + RSVP) · Schedule
(Fri/Sat/Sun events) · Travel · Registry · Things to Do at Priest Lake · FAQs · RSVP form. All
mobile-first, white, centered, serif, heart-accented.
