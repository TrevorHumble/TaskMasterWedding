# Lilly &amp; Axel — Wedding Web App Design System

A small, focused design system for a **mobile-first wedding website / web app**. The aesthetic is _quiet, elegant, clean white, all-serif, forest green_. One decorative motif only: the **heart**. No watercolor florals, no busy ornament — restraint is the brand.

> This file is portable. Another agent (or Claude Code) can read it top-to-bottom and build on-brand screens without seeing the originals. Concrete token values live in `styles.css`; this doc explains how to use them and why.

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

- The page background is **always white**. `--green-50` is the _only_ fill used to separate a region (cards, the password well, the RSVP panel).
- Text lives in the green family — `--green-700` for almost everything, `--green-500` for supporting copy. Avoid pure black.
- **Buttons** are solid `--green-700`, white label, hover to `--green-900`. That is the single call-to-action treatment everywhere.
- No gradients. No second accent hue. If you need emphasis, use _weight, size, and space_ — not a new color.

---

## 3. Typography

All-serif. Two families, both from Google Fonts (loaded by `styles.css`):

- **Display — `Cormorant Garamond`** (`--font-display`): high-contrast, elegant. Used for couple names, page titles, day headers, the countdown date. Often **UPPERCASE** with letter-spacing for names/titles; mixed-case for dates.
- **Body — `EB Garamond`** (`--font-body`): warm, readable. Paragraphs, event details, form labels, meta.

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
- **Hairlines** (`--green-300`) separate list rows and underline the active nav item. 1px only.
- **Shadows are rare.** Flat by default. Use `--shadow-card` for a lifted panel, `--shadow-raise` for a sheet/menu overlay. Never a heavy drop shadow.

---

## 6. Components (behaviour spec)

Build these with inline styles referencing the tokens. Keep them flat and centered.

- **Button (primary):** solid `--green-700`, label in `--font-body` weight 600, `--color-on-primary`, padding `14px 28px`, radius `--radius-input`. Hover/press → `--green-900`. Full-width on mobile forms; auto-width inline (e.g. "Map" / "Add to calendar" sit as an equal pair in a `gap` row). No icon needed.
- **Text input:** white fill, `--border-hairline`, radius `--radius-input`, 14px padding, 18px serif text. Placeholder in `--green-300`. Focus → border `--green-700`. Password field shows an eye/eye-off toggle on the right. Inputs sit inside a `--green-50` well on ceremonial screens.
- **Card / panel:** `--green-50` fill, radius `--radius-card`, padding `--space-5`–`--space-6`. Used for the password well and the RSVP block. Optional `--shadow-card`.
- **Nav:** centered wordmark "LILLIAN &amp; AXEL" (Cormorant uppercase) with a horizontal link row beneath on desktop; on mobile collapse to a **hamburger** opening a centered serif menu sheet. Active item is underlined with a 1px `--green-700` rule. Links: Home · Schedule · Travel · Registry · Things to Do · FAQs · RSVP.
- **Countdown:** four inline units "39 days 10 hours 19 minutes 28 seconds" in `--green-500`, centered, small caps-ish serif. Live-ticking.
- **Schedule item:** centered stack — day title (Cormorant uppercase) → small heart divider → event title (600) → time → venue name → italic-underline address → description (muted, centered) → button pair (Map / Add to calendar).
- **Section divider:** small centered heart (or outline-heart pair) with generous vertical space.

---

## 7. Content &amp; tone

- **Voice:** warm, gracious, first-person-plural ("Join us…", "we celebrate"). Speaks _to_ the guest. Never corporate, never cute-overload.
- **Casing:** UPPERCASE for names, page titles, day headers; Title Case for event names; sentence case for descriptions.
- **Dates:** "AUGUST 7 – 9, 2026" (display); "Friday, August 7, 2026" (day header). Place: "Priest Lake, ID".
- **Examples:**
  - Password gate: _"Check your invitation for the password. If you cannot find it, contact Lilly or Axel."_
  - Hero: _"Join us for a wedding weekend!"_
  - Schedule blurb: _"Join us for a relaxed lakeside welcome with drinks, light bites, and a campfire. Come comfortable — this is your chance to settle in, reconnect, and ease into the weekend."_
- **No emoji.** The heart motif is rendered as an SVG/glyph element, never the 🤍/❤️ emoji.

---

## 8. Motion

Subtle and soft. Use `--ease-soft`. Fades and short slides only (menu sheet, screen transitions). Countdown ticks without animation. Buttons transition `background-color` over `--dur-fast`. No bounce, no parallax, no auto-playing motion on ceremonial screens.

---

## 9. Files in this system

- `styles.css` — all design tokens + font imports. **Import this.**
- `DESIGN_SYSTEM.md` — this guide.
- `SKILL.md` — portable skill wrapper (for Claude Code / Agent Skills).
- `Wedding Screens.dc.html` — interactive example: the key mobile screens (password gate, home + live countdown, schedule, RSVP, FAQ) on a pannable canvas. Edit these together to refine the system.

---

## 10. Screen inventory (for build-out)

Password gate · Home/landing (hero + date + place + live countdown + RSVP) · Schedule (Fri/Sat/Sun events) · Travel · Registry · Things to Do at Priest Lake · FAQs · RSVP form. All mobile-first, white, centered, serif, heart-accented.
