---
title: Components
description: Technical component architecture
---

## Component directories

ChocolaKit organizes `src/` into three distinct directories with different roles:

| Directory | Internal purpose | Route creation | Export type |
|---|---|---|---|
| `src/lib/` | Component compilation unit | No | SFC → JS/CSS modules |
| `src/pages/` | Route resolution unit | Yes | File path → URL path |
| `src/static/` | Static asset pass-through | No | File copy to output |

### `src/lib/` — Component compilation

Each `.html` file in `src/lib/` is a Single-File Component (SFC) processed by Chocola:

- **Compilation output** — Emits two module artifacts:
  - Scoped CSS module with deterministic 8-letter hash (`a-z`)
  - Vanilla JavaScript module with corresponding hash
- **Deterministic hashing** — CSS class names and JS scope identifiers are derived from the component filename via `deterministicHash()`, ensuring stability across rebuilds
- **Hash tracking** — Component filename → hash mapping written to `.chocola/hashes.json`

### `src/pages/` — Route resolution

File-based routing mechanism:

- Each `.html` file becomes a route whose path is derived from its location relative to `src/pages/`
- `index.html` within a directory serves as the folder's root route
- Nested directories create path segments (e.g., `blog/first-post.html` → `/blog/first-post`)
- The routing graph is constructed once at build/dev server startup and reused

### `src/static/` — Asset pass-through

- Files copied as-is to `outDir` during build
- No compilation or transformation applied
- Path preservation from `src/static/` to output root

### Component SFC internal structure

A component `.html` file may contain:

1. **`<template>`** — Required. Markup rendered in the browser. No `<chocolakit:head>` nesting allowed.
2. **`<script>`** — Optional. JavaScript module export. Exported properties define component public API.
3. **`<style>`** — Optional. Scoped CSS. Hash is deterministic based on filename, stable across builds.

### Component lifecycle

1. **Registration** — Component files are scanned at framework initialization
2. **Compilation** — SFC → CSS + JS modules during build/dev server update
3. **Inclusion** — Pages import components by filename; compiled modules are inlined or served as separate requests
4. **Hash stability** — Same filename always produces same hash; different filenames produce different hashes (probabilistic but collision-avoiding via 8-letter `a-z` space)