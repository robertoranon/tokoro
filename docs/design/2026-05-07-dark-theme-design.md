# Dark Theme Design — public-web

**Date:** 2026-05-07  
**Scope:** All pages in `public-web/` — `index.html`, `it.html`, `map.html`, `publish.html`  
**Approach:** In-place CSS variable update (no new files, no shared stylesheet)

## Palette

### Core variables (`:root`)

| Variable | Old value | New value | Role |
|---|---|---|---|
| `--bg` | `#f8f5f0` | `#111a24` | Page background |
| `--surface` | `#ffffff` | `#192534` | Card / surface background |
| `--header-dark` | `#18155e` | `#0a1520` | Header gradient start |
| `--header` | `#1e1b6e` | `#cce8f4` | Card title text color (also referenced in gradient, but gradient hardcodes its own stops) |
| `--accent` | `#6366f1` | `#22d3ee` | Primary accent (cyan) |
| `--accent-hover` | `#4f46e5` | `#0891b2` | Accent hover state |
| `--text` | `#1a1827` | `#e8f4fb` | Primary text |
| `--text-2` | `#4b4869` | `#8aafc4` | Secondary text |
| `--text-muted` | `#9491b0` | `#5a7a8e` | Muted / metadata text |
| `--border` | `#e8e6f0` | `#243445` | Borders and dividers |

### Header gradient

Replace the three-stop gradient in the header:

```css
/* old */
background: linear-gradient(
  ...,
  var(--header-dark) 0%,
  #2d1a6e 50%,
  #1e3a8a 100%
);

/* new */
background: linear-gradient(
  ...,
  var(--header-dark) 0%,
  #142030 50%,
  #0c1a30 100%
);
```

A subtle radial glow is added to the header via `::before` pseudo-element:

```css
header::before {
  content: '';
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse at 30% 50%, rgba(34,211,238,0.08) 0%, transparent 70%),
    radial-gradient(ellipse at 80% 20%, rgba(8,145,178,0.06) 0%, transparent 60%);
}
```

### Category colors (brightened for dark backgrounds)

| Category | Old | New |
|---|---|---|
| music | `#7c3aed` | `#a78bfa` |
| food | `#d97706` | `#fbbf24` |
| sports | `#059669` | `#34d399` |
| art | `#db2777` | `#f472b6` |
| theater | `#dc2626` | `#f87171` |
| film | `#2563eb` | `#60a5fa` |
| nightlife | `#9333ea` | `#c084fc` |
| community | `#0891b2` | `#22d3ee` |
| outdoor | `#16a34a` | `#4ade80` |
| learning | `#0d9488` | `#2dd4bf` |
| wellness | `#65a30d` | `#a3e635` |
| talks | `#ea580c` | `#fb923c` |
| other | `#6b7280` | `#94a3b8` |

## Per-file changes

### `index.html` and `it.html`

- Replace all `:root` variables above.
- Replace header gradient mid-stop (`#2d1a6e` → `#142030`) and end-stop (`#1e3a8a` → `#0c1a30`).
- Add header `::before` glow pseudo-element.
- Replace hardcoded `rgba(99, 102, 241, …)` accent shadow/glow values with `rgba(34, 211, 238, …)`.
- Replace `#fafaf8` input background with `#192534`.
- Replace `#a5b4fc` link/highlight color with `#67e8f9` (light cyan).
- Replace `background: white` on focus with `background: #192534`.

### `map.html`

- Replace all `:root` variables above.
- Replace header gradient stops (same as index.html).
- Add header `::before` glow pseudo-element.
- Replace hardcoded light-mode colors in the filter/control panel:
  - `#fff` backgrounds → `#192534`
  - `#e0e0e0` borders → `#243445`
  - `#888` / `#ccc` text → `#5a7a8e`
  - `#e0e7ff` active pill bg → `rgba(34,211,238,0.15)`
  - `#c7d2fe` active pill hover → `rgba(34,211,238,0.25)`
  - `#f0f0f0` disabled → `#1e2e3e`
  - `#bbb` disabled text → `#3a5060`

### `publish.html`

This file has no CSS variables. All colors are hardcoded and replaced as follows:

| Old | New | Usage |
|---|---|---|
| `#fff` / `white` | `#111a24` | Page background |
| `#f9f9f9` | `#192534` | Section backgrounds |
| `#111` | `#e8f4fb` | Primary text |
| `#333` | `#e8f4fb` | Headings |
| `#555` / `#666` | `#8aafc4` | Secondary / label text |
| `#ddd` / `#ccc` | `#243445` | Borders |
| `#0066cc` / `#1976d2` | `#22d3ee` | Links and primary button bg |
| `#1565c0` | `#0891b2` | Button hover |
| `#4caf50` | `#22d3ee` | Submit/publish button bg |
| `#c00` | `#f87171` | Error text |
| `#060` | `#4ade80` | Success text |
| `#e3f2fd` | `rgba(34,211,238,0.1)` | Info badge bg |
| `#e8f5e9` | `rgba(74,222,128,0.1)` | Success badge bg |
| `#ffebee` | `rgba(248,113,113,0.1)` | Error badge bg |
| `#a5d6a7` | `rgba(74,222,128,0.25)` | Success badge border |
| `#ef9a9a` | `rgba(248,113,113,0.25)` | Error badge border |
| `#ccc` (disabled btn) | `#1e2e3e` | Disabled button bg |
| `#999` (disabled btn text) | `#3a5060` | Disabled button text |
| `#fff3cd` | `rgba(251,191,36,0.1)` | Warning banner bg |
| `#ffc107` | `rgba(251,191,36,0.3)` | Warning banner border |

Primary action buttons in publish.html use `#22d3ee` background with `#0a1520` (dark) text for maximum contrast.

## What does not change

- Border radii (`--radius`, `--radius-sm`) — unchanged.
- Box shadows — the existing `rgba(0,0,0,…)` shadows work well on dark and are kept as-is.
- Category color usage pattern (left-border accent on cards, badge with translucent bg) — unchanged, only the color values update.
- JavaScript, markup, and all non-color CSS — unchanged.
