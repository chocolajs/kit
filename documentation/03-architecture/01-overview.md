---
title: Architecture
description: Technical architecture of ChocolaKit (developer-focused)
---

## Framework architecture

ChocolaKit is a full-stack web framework built as a cohesive unit. This document describes the internal architecture and component interactions.

## Core design principles

- **File-based routing**: Route mapping is determined by file paths in `src/pages/`, with no external router configuration required.
- **Single framework**: ChocolaKit encompasses all layers — compilation, dev server, SSR, and CLI — eliminating the need for third-party tooling.
- **Deterministic outputs**: Component hashes and asset filenames are derived deterministically from content, ensuring stability across builds.

## Three execution modes

ChocolaKit operates in three modes, sharing the same underlying architecture:

| Mode | CLI command | Purpose |
|---|---|---|
| Development | `chocola dev` | Hot-reloading dev server with file polling |
| Static generation | `chocola build` | SSG producing static output in `outDir` |
| Server-side rendering | `chocola serve` | Per-request SSR production server |

All modes use the same routing graph and component compilation pipeline.

## Build pipeline (SSG)

The static build process:

1. **Component scanning** — Scan `src/lib/` for `.html` component files
2. **Chocola compilation** — Each component is compiled into scoped CSS and vanilla JS with deterministic hashes
3. **Route resolution** — Resolve `.html` files in `src/pages/` to URL paths via file-based routing
4. **Page rendering** — Render each page inside `<chocolakit:body>` of `src/app.html`
5. **Hash generation** — Write deterministic 8-letter `a-z` hashes to `.chocola/hashes.json`
6. **Asset finalization** — Output files with deterministic names (`sc-<hash>.css`, `css-<hash>.css`, `js-<hash>.js`, `run-<hash>.js`)

## Development server architecture

- **File watching** — Polling-based file change detection
- **Incremental rebuild** — Recompile only affected components on change
- **HMR delivery** — Update browser via polling `/api/hot-reload`
- **Module federation** — ES module delivery to browser without bundler dependencies

## SSR production server architecture

Per-request rendering pipeline:

1. **Request reception** — Honor `PORT` environment variable for container binding
2. **Handler creation** — Instantiate handler via `createHandler` or `serve()`
3. **Context construction** — Merge query params and middleware return values into render context `ctx`
4. **Page rendering** — Render route via `renderPage(graph, ctx)` per request
5. **Asset serving** — Serve virtual assets (`sc-*`/`run-*`/`css-*`/`js-*`) and `src/static` with:
   - `ETag`/`Last-Modified` headers
   - `304` not-modified handling
   - `gzip` compression when compressible

## Configuration system

Configuration is read from `chocola.config.json` at startup with the following precedence:

```
CLI flags > chocola.config.json > built-in defaults
```

### Configuration schema (internal)

```json
{
  "bundle": {
    "srcDir": "src",
    "outDir": "dist",
    "libDir": "lib",
    "emptyOutDir": true
  },
  "dev": {
    "hostname": "localhost",
    "port": 3000
  },
  "server": {
    "port": 8080,
    "hostname": "localhost",
    "middleware": null
  }
}
```

### Key internal behaviors

- **`emptyOutDir`** — When true, the output directory is cleaned before each build write
- **Middleware** — ESM file with default export supporting short-circuit `(req, res)` or context merge `({ query, cookies, headers, url }) => ctx`
- **PORT env** — When set and no explicit host flag/config exists, hostname defaults to `0.0.0.0` for container binding