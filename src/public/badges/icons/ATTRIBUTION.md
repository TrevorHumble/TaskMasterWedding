# Badge icons — attribution

The `*.svg` files in this directory are **Google Material Symbols** (rounded,
weight 400, filled), recolored to the app's primary green (`#467058`) and
stripped of their fixed pixel width/height so they scale inside the badge ring.

- Source: https://github.com/google/material-design-icons
- License: **Apache License 2.0** — see `LICENSE` in this directory.
- No runtime fetch: the icons are bundled as static files and served locally,
  so the app makes no external request to render a badge (per the offline
  constraint on #410).

The only modification to each source glyph is the `fill` color and the removal
of the `width`/`height` attributes. The path geometry is unchanged.
