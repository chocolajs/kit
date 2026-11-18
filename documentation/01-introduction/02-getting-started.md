---
title: Getting started
description: Set up a ChocolaKit project from scratch
---

## 1. Set up your directory

```text
my-app/
├── src/
│   ├── app.html           # required document shell
│   ├── pages/
│   │   └── index.chjs     # / route
│   ├── lib/
│   │   └── greeting.chjs
│   └── static/
├── chocola.config.json    # optional
└── package.json           # optional
```

Every page is a `.chjs` component under `src/pages/`. Components under `src/lib/` are reusable only when a page or another component imports them explicitly.

## 2. Install ChocolaKit

```sh
npm i -g @chocolajs/kit
```

## 3. Create `chocola.config.json` (optional)

```json
{
  "bundle": {
    "srcDir": "src",
    "outDir": "dist",
    "pagesDir": "pages",
    "appFile": "app.html",
    "staticDir": "static",
    "emptyOutDir": true
  },
  "dev": {
    "hostname": "localhost",
    "port": 3000
  },
  "server": {
    "port": 8080,
    "hostname": "localhost",
    "middleware": "./middleware.js"
  }
}
```

`pagesDir`, `appFile`, and `staticDir` are resolved inside `srcDir`. `libDir` is deprecated and ignored; components enter the graph only through explicit imports.

## 4. Initialize `app.html`

`src/app.html` is required. It must contain exactly one `<chocolakit:body>` slot, and may contain at most one `<chocolakit:head>` slot inside `<head>`.

```html
<!-- file: src/app.html -->
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

Global styles are author-managed links in `app.html` (for example, `src/styles.css`). Kit copies them unchanged and adds a generated scoped stylesheet for component styles.

## 5. Create your index page

Create `src/pages/index.chjs`. Pages support a `<chocolakit:head>` block, a `<script>`, a required `<template>`, and an optional `<style>`.

```html
<!-- file: src/pages/index.chjs -->
<script>
  import Greeting from "../lib/greeting.chjs";

  export let title = "My ChocolaKit App";
</script>

<chocolakit:head>
  <title>{title}</title>
</chocolakit:head>

<template>
  <main>
    <h1>{title}</h1>
    <Greeting name="World"></Greeting>
  </main>
</template>
```

```html
<!-- file: src/lib/greeting.chjs -->
<script>
  export let name = "World";
</script>

<template>
  <p>Hello {name}!</p>
</template>

<style>
  p {
    color: #6b3f1d;
  }
</style>
```

`src/pages/index.chjs` is required and renders `/`. Additional pages such as `src/pages/about.chjs` render `/about`. Files ending in `.html` are not accepted as pages.

## 6. Run ChocolaKit

ChocolaKit ships a CLI that handles everything. Use `chocola` or `chjs`:

```sh
# Start dev server on port 3000
chjs dev

# Build for production
chjs build

# Start SSR production server
chjs serve

# Override defaults with flags
chjs dev --port 5173 --host 0.0.0.0
chjs build --outDir ./tmp/build --srcDir ./src
chjs serve --port $PORT --host 0.0.0.0
```

With a `chocola.config.json`, CLI flags take precedence:

```json
{
  "bundle": { "outDir": "build" },
  "dev": { "port": 5173 },
  "server": { "middleware": "./middleware.js" }
}
```

```sh
chjs dev --port 4000   # flag wins over config (4000), config wins over default (5173 vs 3000)
```

For advanced use, the package exposes programmatic APIs:

```js
import compileMultipage from "@chocolajs/kit/routing";
import { serve as startDev } from "@chocolajs/kit/dev";
import { serve, createHandler } from "@chocolajs/kit/server";

await compileMultipage(process.cwd()); // static build
await startDev(process.cwd());         // dev server
await serve(process.cwd());            // SSR server
const handler = await createHandler(process.cwd());
```
