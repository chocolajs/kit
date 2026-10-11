---
title: Getting started
description: Set up a ChocolaKit project from scratch
---

## 1. Set up your directory

```
my-app/
├── src/
│   ├── lib/
│   ├── static/
│   ├── pages/
│   │   └── index.html
│   └── app.html
└── chocola.config.json    # optional
└── package.json           # optional
```

## 2. Install ChocolaKit

Install locally

```sh
npm i @chocolajs/kit
```

or globally

```sh
npm i -g @chocolajs/kit
```

## 3. Create `chocola.config.json` (optional)

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
    "middleware": "./middleware.js"
  }
}
```

## 4. Initialize `app.html`

```html
<!-- file: src/app.html -->
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

## 5. Create your index page

```html
<chocolakit:head>
  <title>My ChocolaKit App</title>
</chocolakit:head>

<template>
  <span>Hello World!</span>
</template>
```

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

For advanced use, programmatic APIs are available: `app.build(__dirname)`, `dev.server(__dirname)`, `serve(__dirname)`, `createHandler(__dirname)`.