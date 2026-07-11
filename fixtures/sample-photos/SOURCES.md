# Sources

Every JPEG in this directory is an original work generated for this repository
(gradient backgrounds composited with geometric shapes, rasterized with `sharp`).
None is a photograph or third-party asset. Each is released to the public domain
under CC0 — no attribution required, free to use, modify, or redistribute.

- `sample-01.jpg` — original generated artwork, released under CC0 / Public Domain.
- `sample-02.jpg` — original generated artwork, released under CC0 / Public Domain.
- `sample-03.jpg` — original generated artwork, released under CC0 / Public Domain.
- `sample-04.jpg` — original generated artwork, released under CC0 / Public Domain.
- `sample-05.jpg` — original generated artwork, released under CC0 / Public Domain.
- `sample-06.jpg` — original generated artwork, released under CC0 / Public Domain.
- `sample-07.jpg` — original generated artwork, released under CC0 / Public Domain.
- `avatar-01.jpg` — original generated artwork, released under CC0 / Public Domain.
- `avatar-02.jpg` — original generated artwork, released under CC0 / Public Domain.

## HEIC fixture (issue #281)

`sample-heic-01.heic` is the one exception to "generated for this repository": a
real HEVC-encoded HEIC file is needed to test HEIC-to-JPEG conversion at intake
(`heic-convert`'s pure-JS decoder has no synthetic/mock mode — `sharp` cannot
even create a fake one, since prebuilt `sharp` has no HEIC encoder either), so a
genuine third-party fixture is unavoidable here.

- `sample-heic-01.heic` — sourced verbatim, unmodified, from
  [`strukturag/libheif`](https://github.com/strukturag/libheif), file
  `tests/data/rainbow-451x461.heic` (commit `f1fd74a3a72c324c421005f896d5c87e3b976215`,
  "add unit-tests for HEIC/AVIF component population", authored by Dirk Farin,
  libheif's maintainer, as project-original conformance-test data — a synthetic
  rainbow gradient, not a photograph of any person or place). libheif's stated
  license split is LGPL-3.0 for the library and MIT for examples/wrappers; this
  file is neither — it is test data checked into the same repository, so it is
  redistributed here verbatim under LGPL-3.0 terms (verbatim, unmodified
  redistribution with this attribution notice retained, which LGPL-3.0
  permits). Confirmed to sniff as a real ISO-BMFF `ftyp` box with brand `heic`
  (`00000000: 0000 0018 6674 7970 6865 6963` — `ftyp` + `heic`) and to decode
  successfully via `heic-convert` into a valid 451x461 JPEG (verified with a
  one-off `node -e` script during implementation of issue #281).
