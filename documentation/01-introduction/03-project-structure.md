---
title: Project structure
description: The anatomy of a ChocolaKit project
---

Here is the typical layout of a ChocolaKit project:

```text
my-app/
├── src/
│   ├── app.html           # required document shell
│   ├── pages/
│   │   ├── index.chjs     # /
│   │   └── about.chjs     # /about
│   ├── lib/
│   │   ├── button.chjs
│   │   ├── card.chjs
│   │   └── ...
│   ├── static/
│   │   ├── images/
│   │   ├── fonts/
│   │   └── ...
│   └── styles.css
├── .chocola/              # auto-generated, not committed
│   ├── hashes.json
│   ├── graph/
│   └── runtime/
├── chocola.config.json    # optional
├── package.json           # optional
└── .gitignore
```

## `src/` — Source directory

The main folder where you build your app.

### `src/app.html` — Document shell

The required shell for every route. All page content renders inside a single `<chocolakit:body>` element:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="/favicon.svg">
    <link rel="stylesheet" href="/styles.css">
    <chocolakit:head></chocolakit:head>
  </head>
  <body>
    <chocolakit:body></chocolakit:body>
  </body>
</html>
```

Rules:

- Exactly one `<chocolakit:body>` is required.
- At most one `<chocolakit:head>` is allowed, and it must be inside `<head>`.
- `<chocolakit:body>` and `<chocolakit:head>` must be closed.
- Closing `</head>` and `</body>` tags are required.

Global styles are normal author-managed `<link>` tags in `src/app.html`. Kit does not hash or rewrite them. Component styles are scoped and emitted separately as `sc-<hash>.css`.

### `src/pages/` — Pages

Every `.chjs` file here becomes a route. `src/pages/index.chjs` is required and renders `/`; nested folders become path segments.

```text
src/pages/
├── index.chjs             → /
├── about.chjs             → /about
└── blog/
    ├── index.chjs         → /blog
    └── first-post.chjs    → /blog/first-post
```

Pages are Chocola components plus optional Kit directives.

### `src/lib/` — Components

Reusable Chocola components live here by convention. Each component is a single `.chjs` file with a `<template>`, and optionally `<script>` and `<style>` tags:

```text
src/lib/
├── button.chjs
├── card.chjs
├── navbar.chjs
└── ...
```

`src/lib/` is not auto-discovered. A component is included only when a page or another component imports it:

```html
<script>
  import Navbar from "../lib/navbar.chjs";
</script>
<template>
  <Navbar></Navbar>
</template>
```

Unused `.chjs` files remain in the source tree but do not enter the module graph or the build output.

### `src/static/` — Static assets

Files placed here are copied unchanged to the output directory with the `static/` path preserved, and served at the same path:

```text
src/static/hello.txt   → dist/static/hello.txt   → /static/hello.txt
```

Use it for images, fonts, PDFs, or any other static files your app needs.

## `chocola.config.json` — Configuration (optional)

Defines paths and server settings:

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

| Key | Default | Description |
|---|---|---|
| `srcDir` | `"src"` | Source directory |
| `outDir` | `"dist"` | Build output directory |
| `pagesDir` | `"pages"` | Pages directory, relative to `srcDir` |
| `appFile` | `"app.html"` | Document shell, relative to `srcDir` |
| `staticDir` | `"static"` | Static assets directory, relative to `srcDir` |
| `emptyOutDir` | `true` | Clean `outDir` before each build |
| `treeShakeRuntime` | `true` | Let the compiler omit unused intra-module `$runtime` code |
| `dev.hostname` | `"localhost"` | Dev server hostname |
| `dev.port` | `3000` | Dev server port |
| `server.hostname` | `"localhost"` | SSR server hostname (`server.host` also accepted) |
| `server.port` | `8080` | SSR server port |
| `server.middleware` | `null` | Path to an ESM middleware file, relative to the project root |

`libDir` is deprecated and ignored. Components enter the graph only through explicit `.chjs` imports.

## Other files

### `.chocola/hashes.json`

Auto-generated reference file that maps module ids to their deterministic scoped CSS ids (8-letter `a-z` from `deterministicHash(moduleId, 8)`, stable across builds):

```json
{
  "lib/card.chjs": "fkffxyip",
  "lib/greeting.chjs": "lrvymjnv",
  "pages/index.chjs": "zfamaczj"
}
```

Kit writes this file after each static build and after SSR handler warm-up. Dev mode keeps the mapping in memory only. Use it to identify which component rendered a given element when inspecting generated HTML.

### `.chocola/graph/` and `.chocola/runtime/`

- `.chocola/graph/` is a source mirror the compiler reads. Page directives such as `<chocolakit:head>` are removed from the mirror before the core compiler sees them.
- `.chocola/runtime/` is the disk fallback for runtime chunks kept outside the in-memory dev/SSR store.

Both are generated artifacts. Do not commit `.chocola/`.

### Generated output names

Build output uses deterministic names:

- Route HTML: `index.html`, `about.html`, `blog/index.html`
- Scoped component CSS: `sc-<hash>.css`
- Runtime ESM chunks: `run-<hash>.js`
- Author assets and `src/static/` files: copied with their original paths

Global CSS is not emitted as `css-<hash>.css`; it stays an author-managed file linked from `app.html`.

### `.gitignore`

Should include at least:

```text
node_modules/
dist/
.chocola/
```
