---
title: Testing and development
description: Dev server, SSR server, testing and benchmarks
---

## Dev Server with Hot-Reload

To test your ChocolaKit app with hot-reload, run:

```sh
chocola dev
```

This starts a local dev server (`chocola/dev`) that rebuilds and live-reloads on file changes (polling `/api/hot-reload`). Use it for development — not for production.

## SSR Server (production)

For server-side rendering in production, use `chocola/server`:

```sh
chocola serve
```

Or programmatically with `createHandler`/`serve` from `@chocolajs/kit/server`.
```js
import { serve, createHandler } from "@chocolajs/kit/server";
import http from "http";

// option 1: serve() honors chocola.config.json -> server.port/hostname/middleware
serve(__dirname);

// option 2: bare handler
const handler = await createHandler(__dirname);
http.createServer(handler).listen(8080);
```

Routes are SSR-rendered per request via `renderPage(graph, ctx)` where `ctx` merges query params and middleware returns. Virtual assets (`sc-*`/`run-*`/`css-*`/`js-*`) and `src/static` are served with `ETag`/`Last-Modified`, `304` handling, and `gzip` when compressible.

Configure via `chocola.config.json`:

```json
{
  "server": {
    "port": 8080,
    "hostname": "localhost",
    "middleware": "./middleware.js"
  }
}
```

Middleware is an ESM file with a default export of `Array | Function | Object` supporting `(req, res)` short-circuit or `({ query, cookies, headers, url }) => ctx` merging.

## Testing

```sh
npm test
```

Runs `node --test \"tests/**/*.test.js\"` (SSG + SSR server, ~88 tests). See [CONTRIBUTING.md](https://github.com/chocolajs/kit/blob/main/CONTRIBUTING.md).