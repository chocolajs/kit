---
title: Migration guide
description: Migrate a ChocolaKit app from the retired .html compiler pipeline to .chjs imports
---

ChocolaKit now uses Chocola's import-based compiler API. Pages and components are `.chjs` single-file components, dependencies come from explicit imports, and `src/app.html` is a required document shell.

This guide covers every breaking change and shows before/after examples.

## Project layout

```text
# before
src/
├── index.html          # entry, wrapped in <app>
├── pages/
│   └── about.html
└── lib/
    └── Greeting.html   # discovered implicitly

# after
src/
├── app.html            # required document shell
├── pages/
│   ├── index.chjs      # required / route
│   └── about.chjs
└── lib/
    └── greeting.chjs   # included only through imports
```

- Files previously ending in `.html` in `src/pages/` and `src/lib/` must now be renamed to `.chjs`.
- A `.html` file in `src/pages/` is rejected with an error. There is no automatic wrapping or fallback.
- `src/pages/index.chjs` is required and renders `/`. `bundle.entry` is removed.

## The root page and `<app>`

Before, `src/index.html` was the entry and used `<app>`:

```html
<!-- before: src/index.html -->
<app><Greeting name="World" /></app>
```

After, the root route is `src/pages/index.chjs`, `<app>` is removed, and the component is imported explicitly:

```html
<!-- after: src/pages/index.chjs -->
<script>
  import Greeting from "../lib/greeting.chjs";
</script>
<template>
  <Greeting name="World" />
</template>
```

`<app>` is no longer supported in pages or the document shell.

## Components

Components are plain `.chjs` modules with a required `<template>` and optional `<script>` and `<style>` blocks:

```html
<!-- before: src/lib/Greeting.html -->
<template>
  <p>Hello {name}!</p>
</template>
<script>
  export let name = "World";
</script>
```

```html
<!-- after: src/lib/greeting.chjs -->
<script>
  export let name = "World";
</script>
<template>
  <p>Hello {name}!</p>
</template>
```

Key changes:

- **Explicit imports** — `src/lib/` is a convention, not a discovery root. A component is compiled only when a page or another component imports it. Unimported files stay out of the module graph and the build output.
- **No implicit component names** — `Greeting` must be imported from its file path.
- **Kit directives stay in pages** — Components must not contain `<chocolakit:*>` tags. Only page entries may use `<chocolakit:head>`.

## Pages and head content

Page head content stays in the page and is still preprocessed by Kit:

```html
<!-- before: src/pages/about.html -->
<chocolakit:head><title>About</title></chocolakit:head>
<main>About</main>
```

```html
<!-- after: src/pages/about.chjs -->
<chocolakit:head><title>About</title></chocolakit:head>
<template><main>About</main></template>
```

The `<chocolakit:head>` block is removed before the page reaches the Chocola compiler and is inserted into the shell's head slot. It remains optional, may appear at most once, and must be a top-level block.

## The document shell (`src/app.html`)

`src/app.html` is required for every mode. It must contain exactly one `<chocolakit:body>` slot, may contain at most one `<chocolakit:head>` inside `<head>`, and must not contain `<app>`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles.css">
    <chocolakit:head></chocolakit:head>
  </head>
  <body>
    <chocolakit:body></chocolakit:body>
  </body>
</html>
```

Rules enforced by Kit:

- Exactly one `<chocolakit:body>`.
- At most one `<chocolakit:head>`, and it must be inside `<head>`.
- Both slots must be closed.
- Closing `</head>` and `</body>` tags are required.
- `<app>` is rejected.

## Global styles

`bundle.globalStyles` and the generated `css-<hash>.css` output are gone. Global CSS is author-managed and linked from `app.html`:

```html
<!-- src/app.html -->
<link rel="stylesheet" href="/styles.css">
```

Kit copies `src/styles.css` unchanged. It only generates content-hashed scoped stylesheets (`sc-<hash>.css`) for component `<style>` blocks.

There is no replacement for `bundle.globalStyles`; do not add one to `chocola.config.json`.

## Configuration

Remove settings that no longer exist:

| Before | After |
|---|---|
| `bundle.entry` | Removed. `src/pages/index.chjs` is the `/` route. |
| `bundle.globalStyles` | Removed. Link styles from `app.html`. |
| `bundle.libDir` | Deprecated and ignored. Use explicit `.chjs` imports. |
| `src/index.html` | `src/pages/index.chjs` + required `src/app.html`. |

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
  }
}
```

`build` is accepted as an alias for `bundle`. If `libDir` is still present, Kit prints a deprecation warning and ignores it.

## Output artifacts

Runtime and style output names changed:

| Before | After |
|---|---|
| `css-<hash>.css` | Removed. Global CSS is author-managed. |
| `sc-<hash>.css` | Still emitted for scoped component styles. |
| `js-<hash>.js` | Removed. |
| `run-<hash>.js` | Still emitted; runtime chunks are ESM served at `/run-*.js`. |
| `hashes.json` keyed by component filename | `.chocola/hashes.json` keyed by module id, for example `pages/index.chjs`. |

Hash keys now use module ids relative to `srcDir`, not component filenames.

## Programmatic API

The old core pipeline helpers are gone. Use the Kit site API or Chocola's new compiler functions:

| Before | After |
|---|---|
| `renderPage(graph, ctx)` | `renderRoute(state, route, ctx)` from `@chocolajs/kit/routing` |
| `buildMultipageGraph(...)` | `buildSiteState(root, ...)` / `buildModuleGraph(root, { entry })` |
| `emit(...)` / `emitMultipage(...)` | `emitSite(state, ...)` / default `compileMultipage(root)` |

```js
import compileMultipage, {
  buildSiteState,
  renderRoute,
  emitSite,
} from "@chocolajs/kit/routing";
import { buildModuleGraph, render } from "chocola/compiler";

// Static build
await compileMultipage(process.cwd());

// Lower-level site state
const state = await buildSiteState(process.cwd());
const result = await renderRoute(state, "/about", { user: null });
await emitSite(state, { ctx: {} });
```

`renderPage` is no longer exported. SSR handlers share the page graph and call `render(graph, ctx)` per request.

## Breaking-change checklist

- [ ] Rename every page under `src/pages/` from `.html` to `.chjs`.
- [ ] Rename every component under `src/lib/` from `.html` to `.chjs`.
- [ ] Add a `<template>` wrapper to every page and component body.
- [ ] Replace implicit component tags with explicit imports from `../lib/<name>.chjs`.
- [ ] Move the old `src/index.html` entry to `src/pages/index.chjs`.
- [ ] Remove `<app>` from all files.
- [ ] Create `src/app.html` with one `<chocolakit:body>` and an optional `<chocolakit:head>` inside `<head>`.
- [ ] Move global styles into `<link rel="stylesheet">` tags in `src/app.html` and delete `bundle.globalStyles`.
- [ ] Remove `bundle.entry` from `chocola.config.json`.
- [ ] Remove `libDir` from config, scripts, and CLI invocations.
- [ ] Update any code calling `renderPage`, `buildMultipageGraph`, or `emit`.
- [ ] Update build scripts that reference `css-*` or `js-*` output files.
- [ ] Add `.chocola/` to `.gitignore`.
- [ ] Run `npm test` / `chjs build` and verify every route.
