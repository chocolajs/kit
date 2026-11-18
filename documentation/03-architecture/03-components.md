---
title: Components
description: Technical component architecture
---

## Component directories

ChocolaKit organizes `src/` into three distinct directories with different roles:

| Directory | Internal purpose | Route creation | Export type |
|---|---|---|---|
| `src/lib/` | Reusable component source (by convention) | No | Imported `.chjs` modules |
| `src/pages/` | Route entries | Yes | File path → URL path |
| `src/static/` | Static asset pass-through | No | File copy to output |

### `src/lib/` — Component source

Each `.chjs` file is a Single-File Component (SFC) processed by Chocola:

- **Template** — Required. Markup rendered for the component.
- **Script** — Optional. Exports define the component's public props and behavior.
- **Style** — Optional. Scoped CSS keyed by the component's module id.

`src/lib/` is not scanned at runtime or build time. A component is compiled only when a page or another component imports it explicitly:

```html
<script>
  import Card from "../lib/card.chjs";
</script>
<template>
  <Card title="Hello"></Card>
</template>
```

- **Deterministic scoping** — CSS class and attribute scopes are derived from the module id via `deterministicHash()`.
- **Hash tracking** — Module id → 8-letter scope id mapping is written to `.chocola/hashes.json`.
- **No auto-discovery** — Unimported components stay out of the module graph and the output.

### `src/pages/` — Route entries

File-based routing mechanism:

- Each `.chjs` file becomes a route whose path is derived from its location relative to `src/pages/`.
- `index.chjs` within a directory serves as the folder's root route.
- Nested directories create path segments (e.g. `blog/first-post.chjs` → `/blog/first-post`).
- `pages/index.chjs` is required and renders `/`.
- `.html` pages are rejected.
- The routing graph is constructed once when the dev or SSR server starts, or when a static build runs.

### `src/static/` — Asset pass-through

- Files copied as-is to `outDir` during build and served directly by dev/SSR.
- No compilation or transformation applied.
- The `static/` path segment is preserved: `src/static/hello.txt` → `dist/static/hello.txt` → `/static/hello.txt`.

### Component SFC internal structure

A component `.chjs` file may contain:

1. **`<template>`** — Required. Markup rendered in the browser.
2. **`<script>`** — Optional. JavaScript module exports. Exported properties define the component public API.
3. **`<style>`** — Optional. Scoped CSS. Scope ids are deterministic and stable across builds.

Page entries additionally support a top-level `<chocolakit:head>` block. Non-page components that contain `<chocolakit:*>` directives are rejected.

### Component lifecycle

1. **Page discovery** — Kit finds `.chjs` route entries under `src/pages/`.
2. **Graph mirror** — Kit mirrors source files and strips page-only directives.
3. **Graph construction** — Chocola follows explicit imports and builds one module graph per page.
4. **Rendering** — Chocola renders the graph into a body fragment, scoped styles, and runtime chunks.
5. **Assembly** — Kit inserts the result into `src/app.html` and emits or serves the generated assets.

Hash stability means the same module id and content produce the same scope ids and runtime chunk names across rebuilds.
