---
title: Routing
description: How ChocolaKit maps files to URLs
---

ChocolaKit uses **file-based routing**. Every `.html` file inside `src/pages/` becomes a route, and the file's path determines its URL. There is no router to configure.

## How it works

```
my-app/
└── src/
    ├── pages/
    │   ├── index.html          → /
    │   ├── about.html          → /about
    │   ├── contact.html        → /contact
    │   └── blog/
    │       ├── index.html      → /blog
    │       └── first-post.html → /blog/first-post
    └── app.html
```

Each page is rendered inside the `<chocolakit:body>` element of `src/app.html`, so the shared layout (head tags, wrappers, and so on) applies to every route.

## Creating a page

A page is a regular Chocola component file. Define its head contents with `<chocolakit:head>` and its markup with `<template>`:

```html
<!-- file: src/pages/about.html -->
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

## Index pages

A file named `index.html` represents the root of its folder:

| File | Route |
|---|---|
| `pages/index.html` | `/` |
| `pages/blog/index.html` | `/blog` |
| `pages/docs/guide/index.html` | `/docs/guide` |

If a folder contains both `blog.html` and `blog/index.html`, they resolve to the same route, so keep only one of them.

## Nested routes

Folders inside `src/pages/` become path segments. Nest as deeply as you need:

```
src/pages/
└── shop/
    ├── index.html              → /shop
    └── chocolate/
        ├── index.html          → /shop/chocolate
        └── dark.html           → /shop/chocolate/dark
```

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

Put your navigation in a component under `src/lib/` (for example `Navbar.html`) so you can reuse it across pages.

## Pages vs. components

Only files inside `src/pages/` create routes. Files in `src/lib/` are components: they are never reachable by URL and are meant to be used inside pages or other components. Files in `src/static/` are copied unchanged to the output directory and served as-is.

| Directory | Purpose | Creates a route? |
|---|---|---|
| `src/pages/` | Pages | Yes |
| `src/lib/` | Components | No |
| `src/static/` | Static assets | No (served as files) |

## Routing in each mode

The same `src/pages/` structure drives every mode:

```sh
chjs dev     # dev server, routes available as you create files
chjs build   # creates a static build into dist/
chjs serve   # serves routes with the SSR production server
```

To change where pages are read from or written to, adjust `srcDir` and `outDir` in `chocola.config.json`.