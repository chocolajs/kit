---
title: Architecture
description: Technical architecture of ChocolaKit (developer-focused)
---

## Framework architecture

ChocolaKit is a full-stack web framework built as a cohesive unit. This document describes the internal architecture and component interactions.

## Core design principles

- **File-based routing**: Route mapping is determined by `.chjs` files in `src/pages/`, with no external router configuration required.
- **Explicit module graphs**: A page's dependency graph comes from its JavaScript imports. `src/lib/` is a convention, not an auto-discovery root.
- **Single framework**: ChocolaKit encompasses all layers — compilation, document assembly, dev server, SSR, and CLI — eliminating the need for third-party tooling.
- **Deterministic outputs**: CSS scope ids, stylesheet filenames, and runtime chunk names are derived deterministically from content and module ids.

## Three execution modes

ChocolaKit operates in three modes, sharing the same underlying architecture:

| Mode | CLI command | Purpose |
|---|---|---|
| Development | `chocola dev` | Hot-reloading dev server with file watching |
| Static generation | `chocola build` | SSG producing static output in `outDir` |
| Server-side rendering | `chocola serve` | Per-request SSR production server |

All modes use the same page discovery, graph mirror, and Chocola compilation pipeline.

## Build pipeline (SSG)

The static build process:

1. **Page discovery** — Find `.chjs` files under `src/pages/` and map them to routes. `pages/index.chjs` is required for `/`.
2. **Graph mirror** — Mirror `src/` under `.chocola/graph/` and remove page-only directives such as `<chocolakit:head>`.
3. **Module graph construction** — For each page, call Chocola's `buildModuleGraph(root, { entry })`, which follows explicit `.chjs` imports.
4. **Rendering** — Call Chocola's `render(graph, ctx)` for each route to produce a body fragment, scoped styles, runtime chunks, and a module-id hash map.
5. **Document assembly** — Insert the interpolated page head, generated `sc-<hash>.css` link, body fragment, and runtime ESM tags into `src/app.html`.
6. **Emission** — Write route HTML, scoped CSS, `run-<hash>.js` chunks, copied author assets, and `.chocola/hashes.json`.

The core compiler never reads Kit config, writes files, or assembles a document. Kit owns discovery, assembly, emission, and serving.

## Development server architecture

- **File watching** — Recursive `fs.watch` on `srcDir`, with a short debounce.
- **Atomic rebuild** — Rebuild the entire site state into temporary caches, then swap them only after a successful build. Failed rebuilds keep serving the previous state.
- **HMR delivery** — Inject a small client before `</body>`; the browser polls `/api/hot-reload` and reloads when `buildTime` changes.
- **No dist writes** — Dev serves rendered responses and virtual assets directly with `Cache-Control: no-store`.
- **Module delivery** — ES modules are served natively without a bundler.

## SSR production server architecture

Per-request rendering pipeline:

1. **Request reception** — Honor `PORT` environment variable for container binding.
2. **Handler creation** — Instantiate a handler via `createHandler` or `serve()`.
3. **Startup build** — Call `buildSiteState` once, warm every route, and write `.chocola/hashes.json`.
4. **Context construction** — Merge query params, `opts.ctx`, and middleware return values into render context `ctx`.
5. **Page rendering** — Call Kit's `renderRoute(state, route, ctx)`, which reuses the page's core graph and invokes Chocola's `render(graph, ctx)` per request.
6. **Asset serving** — Serve virtual `sc-<hash>.css`/`run-<hash>.js` files plus source and `src/static` assets with:
   - `ETag`/`Last-Modified` headers
   - `304` not-modified handling
   - `gzip` compression when compressible

## Configuration system

Configuration is read from `chocola.config.json` at startup with the following precedence:

```text
CLI flags > chocola.config.json > built-in defaults
```

`build` is accepted as an alias for `bundle`. Paths are resolved relative to the project root (and `pagesDir`, `appFile`, `staticDir` relative to `srcDir`).

### Configuration schema (internal)

```json
{
  "bundle": {
    "srcDir": "src",
    "outDir": "dist",
    "pagesDir": "pages",
    "appFile": "app.html",
    "staticDir": "static",
    "emptyOutDir": true,
    "treeShakeRuntime": true
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

- **`emptyOutDir`** — When true, the output directory is cleaned before each static build write. Dev mode never writes `outDir`.
- **`libDir`** — Deprecated and ignored. Components enter the graph only through explicit imports.
- **Middleware** — ESM file with a default export supporting short-circuit `(req, res)` or context merge `({ query, cookies, headers, url, pathname, route }) => ctx`.
- **PORT env** — `--port` wins over `PORT`; otherwise `PORT` wins over `server.port`. When `PORT` is set and no explicit hostname exists, the server binds to `0.0.0.0`.
