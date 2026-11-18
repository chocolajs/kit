---
title: Routing
description: How ChocolaKit maps files to URLs
---

ChocolaKit uses **file-based routing**. Every `.chjs` file inside `src/pages/` becomes a route, and the file's path determines its URL. There is no router to configure.

## How it works

```text
my-app/
└── src/
    ├── pages/
    │   ├── index.chjs          → /
    │   ├── about.chjs          → /about
    │   ├── contact.chjs        → /contact
    │   └── blog/
    │       ├── index.chjs      → /blog
    │       └── first-post.chjs → /blog/first-post
    └── app.html
```

Each page is rendered inside the `<chocolakit:body>` element of `src/app.html`, so the shared layout (head tags, wrappers, and so on) applies to every route.

`src/pages/index.chjs` is required. It is the app entry point for `/`.

## Creating a page

A page is a Chocola component file. Define optional head contents with `<chocolakit:head>` and its markup with `<template>`:

```html
<!-- file: src/pages/about.chjs -->
<chocolakit:head>
  <title>About | My ChocolaKit App</title>
</chocolakit:head>

<template>
  <h1>About us</h1>
  <p>We make great chocolate apps.</p>
</template>
```

You can also add `<script>` and `<style>`. Save the file and `/about` is available immediately in the dev server:

```sh
chjs dev
# visit http://localhost:3000/about
```

### Page head

`<chocolakit:head>` is optional, may appear at most once, and must be a top-level block in the page. It supports head-only elements: `<title>`, `<meta>`, `<link>`, `<base>`, `<style>`, and `<noscript>`.

Head content is interpolated per request. Request context values such as query parameters take precedence over page prop defaults:

```html
<script>
  export let title = "Fallback title";
</script>

<chocolakit:head>
  <title>{title}</title>
</chocolakit:head>

<template>
  <main>About</main>
</template>
```

The `<chocolakit:head>` block is removed before the page reaches the Chocola compiler and inserted into the shell's head slot. If the shell has no head slot, Kit appends the page head before `</head>` and warns once.

## Index pages

A file named `index.chjs` represents the root of its folder:

| File | Route |
|---|---|
| `pages/index.chjs` | `/` |
| `pages/blog/index.chjs` | `/blog` |
| `pages/docs/guide/index.chjs` | `/docs/guide` |

If a folder contains both `blog.chjs` and `blog/index.chjs`, they resolve to the same route, so keep only one of them.

## Nested routes

Folders inside `src/pages/` become path segments. Nest as deeply as you need:

```text
src/pages/
└── shop/
    ├── index.chjs              → /shop
    └── chocolate/
        ├── index.chjs          → /shop/chocolate
        └── dark.chjs           → /shop/chocolate/dark
```

Files and folders whose names start with `_` are ignored by route discovery.

## Linking between pages

Use standard anchor tags with absolute paths:

```html
<template>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/blog">Blog</a>
  </nav>
</template>
```

Because navigation is plain HTML, links work with or without JavaScript, and they work the same in dev, in static builds, and under the SSR server.

Put your navigation in a component under `src/lib/` (for example `navbar.chjs`) and import it where needed:

```html
<script>
  import Navbar from "../lib/navbar.chjs";
</script>
<template>
  <Navbar></Navbar>
</template>
```

## Pages vs. components

Only files inside `src/pages/` create routes. Files in `src/lib/` are components: they are never reachable by URL, and they only enter the module graph when imported. Files in `src/static/` are copied unchanged to the output directory under the same `static/` path and served as-is.

| Directory | Purpose | Creates a route? |
|---|---|---|
| `src/pages/` | `.chjs` page entries | Yes |
| `src/lib/` | Reusable `.chjs` components | No |
| `src/static/` | Static assets | No (served as files) |

## Routing in each mode

The same `src/pages/` structure drives every mode:

```sh
chjs dev     # dev server, routes available as you create files
chjs build   # creates a static build into dist/
chjs serve   # serves routes with the SSR production server
```

In a static build, `/about` is written as `about.html`. The dev and SSR servers also accept the clean route, trailing-slash, and `.html` aliases.

To change where pages, the shell, or static files are read from, adjust `pagesDir`, `appFile`, and `staticDir` in `chocola.config.json`. `srcDir` and `outDir` control the source root and build destination.
