---
name: lilly-axel-wedding-design
description: Use this skill to generate on-brand interfaces and assets for the Lilly & Axel wedding web app — a mobile-first, clean-white, all-serif, forest-green wedding site with a single heart motif. Contains the design guide, color/type/spacing tokens, and example mobile screens for prototyping or production.
user-invocable: true
---

Read `DESIGN_SYSTEM.md` for the full guide (color, typography, the heart motif, components, copy tone, motion), and link `styles.css` to inherit the design tokens and fonts. See `Wedding Screens.dc.html` for worked example screens.

If creating visual artifacts (mocks, prototypes, additional screens), copy `styles.css` in and build static HTML/Design-Component files that reference its custom properties. If working on production code, read the rules here to design accurately on-brand.

Core constraints to never break:

- Background is always white; `#f0f4f2` is the only fill used to separate regions.
- Everything green: `#467058` primary, `#2a4335` button hover/press, `#6e8478` muted text.
- All serif: Cormorant Garamond (display/titles) + EB Garamond (body).
- One ornament only: the solid green heart. No watercolor florals, no other icons-as-decoration, no emoji.
- Mobile-first, centered, generous white space.

If invoked with no other guidance, ask what screen or asset to build, ask a few clarifying questions, then act as an expert designer outputting on-brand HTML.
