# Self-hosted fonts

## Bricolage Grotesque

`bricolage-grotesque-latin-600-800.woff2` is the display face used for
headlines (`--font-display` in `website/app/layout.tsx`, applied via the
`.font-display` utility). It is self-hosted so `next build` never depends on
a live fetch to Google's font CDN (see issue #684 — a Google Fonts fetch
failure at build time froze production deploys on 22 Sep 2026).

- **Font:** Bricolage Grotesque (variable font, weight axis 200–800; only the
  600/700/800 "latin" instance is used here, matching what
  `website/app/layout.tsx` requested from `next/font/google` before this
  change: `weight: ["600", "700", "800"]`, `subsets: ["latin"]`).
- **License:** SIL Open Font License, Version 1.1 (OFL) — permits
  self-hosting, bundling, and redistribution. Full text:
  https://scripts.sil.org/OFL
- **Copyright:** Copyright 2022 The Bricolage Grotesque Project Authors
  (https://github.com/ateliertriay/bricolage)
- **Source:** downloaded from Google Fonts' CDN
  (`https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&display=swap`,
  which resolved to a single `fonts.gstatic.com` file for the "latin" subset
  across all three requested weights — Google serves one pre-instanced
  variable-font file for that weight range, so one physical file here covers
  weights 600, 700 and 800). Upstream project:
  https://github.com/ateliertriay/bricolage. Google Fonts specimen:
  https://fonts.google.com/specimen/Bricolage+Grotesque
- **Google Fonts metadata:** designer Mathieu Triay, `license: OFL`,
  `ofl/bricolagegrotesque/OFL.txt` in
  https://github.com/google/fonts (commit `84745e5b96261ae5f8c6c856e262fe78d1d6efdd`
  of the upstream repo).

Referenced from `website/app/layout.tsx` via `next/font/local`, once per
weight (600/700/800), all pointing at this same file — reproducing the
`next/font/google` output exactly, without the build-time network fetch.
