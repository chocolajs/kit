---
title: Project structure
description: The anatomy of a ChocolaKit project
---

Here is the typical layout of a ChocolaKit project:

```
my-app/
├── src/
│   ├── lib/
│   │   ├── Button.html
│   │   ├── Card.html
│   │   └── ...
│   ├── static/
│   │   ├── images/
│   │   ├── fonts/
│   │   └── ...
│   ├── pages/
│   │   └── index.html
│   └── app.html
├── .chocola/              # auto-generated
│   └── hashes.json
├── chocola.config.json    # optional
├── package.json           # optional
└── .gitignore
```

## `src/` — Source directory

The main folder where you build your app.

### `src/app.html`

The entry point of your app. All content renders inside a `<chocolakit:body>` element:

```html
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="./favicon.svg">
    <chocolakit:head></chocolakit:head>
  </head>
  <body>
    <chocolakit:body></chocolakit:body>
  </body>
</html>
```

This is the general wrapper for all your pages. To include dynamic head contents, use `<chocolakit:head>`.

### `src/lib/` — Components

Place your Chocola components here. Each component is a single `.html` file with a `<template>`, and optionally `<script>` and `<style>` tags:

```
src/lib/
├── Button.html
├── Card.html
├── Navbar.html
└── ...
```

### `src/static/` — Static assets

Files placed here are copied unchanged to the output directory. Use it for images, fonts, PDFs, or any other static files your app needs.

## `chocola.config.json` — Configuration (optional)

Defines the paths and dev server settings:

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

| Key | Default | Description |
|---|---|---|
| `srcDir` | `"src"` | Source directory |
| `outDir` | `"dist"` | Build output directory |
| `libDir` | `"lib"` | Components directory (inside `srcDir`) |
| `emptyOutDir` | `true` | Clean output before each build |
| `dev.hostname` | `"localhost"` | Dev server hostname |
| `dev.port` | `3000` | Dev server port |
| `server.hostname` | `"localhost"` | SSR server hostname (`server.host` also accepted) |
| `server.port` | `8080` | SSR server port |
| `server.middleware` | `null` | Path to ESM middleware file (relative to project root) |

## Other files

### `.chocola/hashes.json`

Auto-generated reference file that maps component filenames to their deterministic CSS scope hashes (8-letter `a-z` from `deterministicHash(componentName)`, stable across builds):

```json
{
  "button.html": "xqkfybnh",
  "card.html": "mptzrwxj"
}
```

This file is written after every build. Use it to identify which component rendered a given element when inspecting the output in the browser. It is a build artifact and should not be committed to version control. Asset filenames are also deterministic (`sc-<hash>.css`, `css-<hash>.css`, `js-<hash>.js`, `run-<hash>.js` — hash of content).

### `package.json`

Your Node.js project manifest. The ChocolaKit global CLI lets you create web apps without using Node.js, so it's optional, but you will probably use Node.js unless prototyping. Chocola is listed here as a dependency.

### `.gitignore`

Should include at least:

```
node_modules/
dist/
.chocola/
```