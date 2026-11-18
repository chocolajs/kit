---
title: Testing and development
description: Dev server, SSR server, and testing
---

## Dev server with hot reload

To run your app with hot reload:

```sh
chjs dev
```

This starts the dev server from `@chocolajs/kit/dev` (default `http://localhost:3000`). It watches `srcDir` recursively with `fs.watch`, debounces changes by 300 ms, and rebuilds the whole site state atomically. Successful rebuilds advance a `buildTime` value; the injected browser client polls `/api/hot-reload` and reloads the page when that value changes.

Dev mode never writes `dist`. It serves rendered HTML, virtual `sc-<hash>.css` / `run-<hash>.js` assets, and source/static files with `Cache-Control: no-store`. Use it for development only.

## SSR server (production)

For server-side rendering in production, use `@chocolajs/kit/server`:

```sh
chjs serve
```

Or programmatically with `createHandler` / `serve` from `@chocolajs/kit/server`:

```js
import { serve, createHandler } from "@chocolajs/kit/server";
import http from "http";

// option 1: serve() honors chocola.config.json -> server.port/hostname/middleware
await serve(__dirname);

// option 2: bare HTTP handler
const handler = await createHandler(__dirname);
http.createServer(handler).listen(8080);
```

`createHandler` builds the site state once at startup, warms every route with an empty context, and writes `.chocola/hashes.json`. Each request is rendered via `renderRoute(state, route, ctx)`, where `ctx` merges query parameters, optional `opts.ctx`, and middleware return values. Middleware context wins over earlier values.

Virtual assets (`sc-*` and `run-*`), source assets, and `src/static` files are served with `ETag` and `Last-Modified` headers, `304` handling via `If-None-Match`, and `gzip` when the client accepts it and the content type is compressible.

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

Port precedence is `--port` > `PORT` env > `server.port` > `8080`.

Middleware is an ESM file whose default export is an array, a function, or an object of functions. A function declared with two parameters is called as `(req, res)`; a function with fewer parameters receives the context object.

Short-circuit:

```js
// receives (req, res)
export default async function logRequests(req, res) {
  console.log(req.method, req.url);
}
```

Context merge:

```js
// receives a single context object
export default function addUser({ query }) {
  return { user: query.user ?? null };
}
```

Multiple context functions:

```js
export default {
  addUser({ query }) {
    return { user: query.user ?? null };
  },
  addLocale({ headers }) {
    return { locale: headers["accept-language"] ?? "en" };
  },
};
```

A configured middleware file that does not exist throws at startup.

## Testing

```sh
npm test
```

Runs `node --test "tests/**/*.test.js"` — the SSG, routing, dev server, and SSR server suites (111 tests across 24 suites). See [CONTRIBUTING.md](https://github.com/chocolajs/kit/blob/main/CONTRIBUTING.md).
