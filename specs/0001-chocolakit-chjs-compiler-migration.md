# ChocolaKit migration to the Chocola `.chjs` compiler API

Status: Proposed — implementation runbook for an AI coding agent in §13

## 1. Objective

Move ChocolaKit off the retired compiler pipeline (`buildMultipageGraph`, `getComponents`, `renderPage`, `emitMultipage`) and onto Chocola core's import-based `.chjs` API:

```js
import { buildModuleGraph, render, compile } from "chocola/compiler";
import { deterministicHash } from "chocola/compiler/utils.js";
import { compileExpr } from "chocola/parser/index.js";
```

Kit uses `buildModuleGraph` + `render` because it needs to keep graphs alive and render per request. `compile` remains available for single-module smoke checks or small integrations, but it is not used for Kit's multipage rendering. `deterministicHash` is **not** exported from `chocola/compiler`; it lives in `chocola/compiler/utils.js`, which is reachable through the package's `./compiler/*` export.

After this migration:

- ChocolaKit owns `chocola.config.json`, page routing, document assembly, preprocessing, styles/output, runtime chunk serving, hash persistence, and static assets.
- Chocola core only builds a module graph from an explicit page `.chjs` entry and renders that graph to a fragment.
- Kit pages are `.chjs` files with explicit component imports.
- Pages are discovered from `src/pages/**/*.chjs`; `src/pages/index.chjs` is the `/` route and the app entry point. There is no separate `bundle.entry` mode.
- The document shell is a required `src/app.html` with `<chocolakit:head>` and `<chocolakit:body>` slots. Missing `app.html` is an error.
- Kit pre-processes page sources before handing them to core, so `<chocolakit:head>` works as an in-page directive instead of leaking into core as an unknown component.
- Global styles are plain source stylesheets linked directly from `app.html` (for example `<link rel="stylesheet" href="/styles.css">`); Kit does not bundle or hash them.
- Runtime descriptors are served as ESM chunks at stable URLs.
- `.chocola/hashes.json` is written and exposed by Kit, keyed by root-relative module ids.

This plan is intentionally a hard break. Legacy `src/index.html`, plain `.html` page discovery, `<app>`, implicit `src/lib` component discovery, `bundle.entry`, sidecar head files, and `bundle.globalStyles` are removed with migration errors and documentation.

## 2. Non-goals

- No changes to Chocola core in this repository or in this migration. Kit adapts to the published core API.
- No general-purpose bundler, Node resolution, import maps, or npm bare-specifier support. Kit serves source files and rewrites relative non-`.chjs` imports to stable URLs.
- No incremental graph rebuild. Dev performs a full site rebuild on source changes.
- No server-side streaming, body parsing, or route parameters beyond the existing file-based routes.

## 3. Target architecture

```
chocola.config.json
        │
        ▼
Kit config loader  ──►  pages / shell / static paths
        │
        ▼
Kit page preprocessor  ──►  .chocola/graph mirror (extract <chocolakit:*>, strip directives)
        │
        ▼
buildModuleGraph(graphRoot, { entry, config })   (one graph per page)
        │
        ▼
render(graph, ctx) ──► { html, styles, runtime, hashMap }
        │
        ├──► Kit document assembler (shell + head + scoped styles + runtime tags)
        ├──► Kit runtime rewriter  (non-.chjs imports → stable source URLs)
        ├──► Kit asset store / output writer (sc-*, run-*)
        └──► Kit hash persistence (.chocola/hashes.json)
```

Core contract relied on:

- `buildModuleGraph(rootDir, { entry, config })`
  - `rootDir` must be absolute.
  - `entry` is required, relative to `rootDir` (absolute also accepted), and must end in `.chjs`.
  - There is no implicit `index.chjs` lookup.
- `render(graph, ctx)` returns exactly:
  - `html`: root fragment, no `<html>`, `<head>`, `<body>`, or `<app>`;
  - `styles`: scoped CSS for the graph;
  - `runtime`: ordered `{ name, content }` ESM chunks;
  - `hashMap`: module id → CSS id.
- Core module ids are root-relative POSIX paths (`pages/index.chjs`, `lib/card.chjs`).
- Kit passes an absolute graph mirror root as core `rootDir`. The mirror reproduces the `paths.src` `.chjs` tree with page directives removed, so module ids and `hashMap` keys stay source-relative (`pages/index.chjs`, `lib/card.chjs`) while core never sees Kit-only tags.
- Core preserves non-`.chjs` import statements verbatim in runtime chunks.
- Core never reads config, discovers files, writes output, copies assets, or persists hashes.
- Core no longer ships removed modules such as `chocola/compiler/chalk.js` or `chocola/compiler/pipeline.js`. Kit must stop importing them. Instead of adding a `chalk` dependency, copy the previously shipped implementation from `specs/assets/chalk.js` into Kit as `chalk.js` and import that local module for CLI/server logging. Update the copied module if additional color/style helpers are needed later.

## 4. Configuration

### 4.1 New Kit-owned loader

Core's `loadConfig`/`resolvePaths` no longer exist (only `normalizeConfig` remains). Add a Kit-owned `config.js` at the repository root.

Proposed defaults and schema:

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
  "dev": { "hostname": "localhost", "port": 3000 },
  "server": { "hostname": "localhost", "port": 8080, "middleware": null }
}
```

Rules:

- `srcDir` and `outDir` are resolved against the project root (`rootDir`).
- `pagesDir`, `appFile`, and `staticDir` are resolved against `srcDir`.
- `bundle` and legacy `build` are both accepted as the bundle block; `bundle` wins if both exist.
- `pagesDir` defaults to `pages` under `srcDir`. Pages are discovered under this directory; `index.chjs` is the `/` route.
- `appFile` defaults to `app.html` under `srcDir`. It is required: a missing shell throws `[chocola/routing]` with the expected path. There is no built-in fallback.
- `staticDir` defaults to `static` under `srcDir`.
- Global styles are author-managed: put `<link rel="stylesheet" href="/styles.css">` in `app.html`. There is no `globalStyles`.
- `treeShakeRuntime` is forwarded to core's `config` object unchanged.
- `libDir` is deprecated. It is ignored with a one-time warning: components now enter the graph only through explicit `.chjs` imports in pages.
- Unknown keys pass through to core untouched and remain available to Kit.
- CLI overrides are applied after file loading.

`config.js` exports:

- `DEFAULT_CONFIG`
- `loadConfig(rootDir, { silent, customPath, overrides })` — reads JSON (including `--config`), merges defaults and overrides, normalizes paths, and returns `{ config, paths, raw }`.
- `resolvePaths(rootDir, config)` — absolute `srcDir`, `outDir`, `pagesDir`, `appFile`, and `staticDir`.
- `isMissingConfigFile`, `getConfig`, and warning helpers stay in `utils.js`.

`utils.js` keeps raw config reading and hierarchical warnings (`bundle`, `dev`, `server`), but no longer depends on core `loadConfig`.

### 4.2 CLI flags

Update `bin/chocola.js`:

- `--srcDir`, `--outDir`, `--no-emptyOutDir` keep working.
- Add `--pagesDir <dir>`, `--appFile <file>`, `--staticDir <dir>`.
- `--libDir` is accepted but emits a deprecation warning and has no effect.
- `--config` continues to select an alternate config file.
- `build` calls Kit's `emitSite`; `dev` and `serve` call the updated dev/server modules.

## 5. Page discovery and multipage routing

### 5.1 Discovery

New `routing.js` discovery rules:

- Every `.chjs` file under `<srcDir>/<pagesDir>` is a page entry.
- Each page's core entry is its src-relative path, e.g. `pages/index.chjs` or `pages/blog/post.chjs`.
- `index.chjs` maps to its directory route and is required at the pages root (`pages/index.chjs` → `/`) as the app entry point.
- `blog/index.chjs` → `/blog`, `blog/post.chjs` → `/blog/post`.
- Files/directories beginning with `_` or `.` are ignored for routing but may still be imported from pages.
- Duplicate routes are an error.
- If the shell (`src/app.html` by default) is missing, throw `[chocola/routing]` with the expected path. There is no fallback shell.
- If `pages/` contains `.html` page files, throw a migration error telling the user to rename them to `.chjs` and import components explicitly.
- If `src/index.html` exists and no page `.chjs` files exist, throw a migration error instead of entering legacy mode.
- A page `.chjs` must contain a `<template>` section. A page without one throws a clear error.
- A page may contain a top-level `<chocolakit:head>` block; Kit extracts and removes it before core sees the source. Any other `<chocolakit:*>` tag, or an `<app>` tag, throws a migration/validation error.

### 5.2 Route/output helpers

Keep the existing public helpers where they still make sense, adapted to `.chjs`:

- `filePathToRoute(relPosix)` strips `.chjs`.
- `routeAliases(route, outRel)` keeps clean, trailing-slash, `.html`, and file-style aliases.
- `normalizePathname`, `matchRoute`, `buildRouteTable` keep their behavior.
- `srcRelToOutputRel` maps:
  - `index.chjs` → `index.html`
  - `about.chjs` → `about.html`
  - `blog/index.chjs` → `blog/index.html`
  - `blog/post.chjs` → `blog/post.html`

### 5.3 Site state

Replace `buildMultipageGraph` with `buildSiteState(rootDir, { overrides, config })` (name may be `buildSiteGraph`). It returns:

```js
{
  rootDir,       // project root (config, output, .chocola)
  graphRoot,     // absolute .chocola/graph mirror root, passed to buildModuleGraph
  config,
  paths,
  shell: { source, file, headSlot, bodySlot }, // app.html is required
  pages: Map<route, {
    route,
    srcRel,          // pages/index.chjs
    entry,           // pages/index.chjs (src-relative, passed to buildModuleGraph)
    outRel,          // index.html
    filePath,
    headSource,      // extracted <chocolakit:head> content or null
    graph,           // buildModuleGraph result
    chunkOrigins     // runtime chunk name → module id
  }>,
  routeTable: Map<alias, page>,
  hashMap: {}
}
```

`buildSiteState` builds every page graph once:

```js
const graph = await buildModuleGraph(graphRoot, {
  entry,                       // e.g. "pages/index.chjs"
  config: coreConfig           // { treeShakeRuntime, ...host keys }
});
```

Before building graphs, Kit materializes the preprocessed source mirror:

1. Recreate `<rootDir>/.chocola/graph/`.
2. Walk `<srcDir>` (skipping `<staticDir>`, dot-directories, and `node_modules`) and copy every `.chjs` file into the mirror at the same relative path.
3. For page entries, run the `<chocolakit:*>` preprocessor first and write the processed source. The extracted head HTML is kept in state, not written back.
4. Leave non-page `.chjs` files unchanged after validating that they contain no `<chocolakit:*>` tags.
5. Build each page graph from `graphRoot`, with `entry` set to the page's src-relative path.

Because the mirror preserves the source tree layout, core module ids remain `pages/index.chjs`, `lib/card.chjs`, and so on. Core only reads `.chjs` files; non-`.chjs` imports stay in chunks and are rewritten by Kit using those same ids.

Core's public `buildModuleGraph` only reads files from disk, so the mirror is the injection point for source preprocessing. If core later accepts in-memory source overrides, Kit can drop the mirror without changing the rest of the pipeline.

Dev and SSR keep this state in memory and only call `render(page.graph, ctx)` per request. The mirror is disposable and rebuilt on each site rebuild.

## 6. Document shell and head handling

### 6.1 Shell

`src/app.html` is a required Kit-owned document shell. It is not a core input and is not discovered as a page.

The shell must contain:

- exactly one `<chocolakit:body>` where the rendered fragment is inserted;
- at most one `<chocolakit:head>` inside `<head>` for per-page head content;
- no `<app>` tag;
- a `</head>` and `</body>`.

Global styles are ordinary links written directly in the shell:

```html
<link rel="stylesheet" href="/styles.css">
```

They are source assets served/copied by Kit; Kit does not read, concatenate, or hash them. A missing `appFile` throws `[chocola/routing]` with the expected path. There is no built-in fallback shell.

Shell validation errors use `[chocola/routing]` and include the shell path and the migration hint.

### 6.2 In-page `<chocolakit:head>` preprocessing

Pages keep head metadata in a top-level `<chocolakit:head>` block:

```html
<script>
  import Greeting from "../lib/greeting.chjs";
</script>

<chocolakit:head>
  <title>{title}</title>
  <meta name="description" content="About">
</chocolakit:head>

<template>
  <main>...</main>
</template>
```

Kit intercepts page sources before core:

1. Read the raw page `.chjs` file.
2. Find a top-level `<chocolakit:head>...</chocolakit:head>` block. Nested blocks, multiple blocks, or a block inside `<template>` throw.
3. Extract the inner head HTML into `page.headSource` and remove the whole block from the source before writing it to the graph mirror.
4. Validate the extracted HTML against head-only tags (`<title>`, `<meta>`, `<link>`, `<base>`, `<style>`, `<noscript>`).
5. Reject any other `<chocolakit:*>` tag, and reject `<app>`.
6. Pass the cleaned source to core; core never sees `<chocolakit:head>`.

Head interpolation uses `compileExpr` from `chocola/parser/index.js` against the per-request `ctx` merged with the root module's parsed prop defaults (`page.graph.root.compProps`, each `{ name, defaultValue }`).

If the shell has a head slot, the interpolated page head replaces it. If the shell has no head slot, page head content is appended before `</head>` and a warning is emitted. A page without `<chocolakit:head>` leaves the shell head untouched.

### 6.3 Assembly order

`assembleDocument({ state, page, ctx, result, runtime })`:

1. Start with the shell source (prepend `<!doctype html>` if missing).
2. Replace `<chocolakit:head>` with the interpolated `page.headSource`, if any.
3. Insert the scoped stylesheet link (`sc-*.css`) before `</head>` when `result.styles` is non-empty.
4. Replace `<chocolakit:body>` with `result.html`.
5. Insert runtime tags before `</body>`:
   ```html
   <script type="module" src="/run-<hash>.js"></script>
   ```
   in the order returned by core (base, module chunks, hydration chunk).
6. In dev, inject the hot-reload script before `</body>` after the runtime tags.

The fragment from core is inserted verbatim; Kit does not wrap it in `<app>`.

## 7. Runtime ESM serving

### 7.1 Core chunk shapes

Core emits:

- base chunk: `run-<deterministicHash(baseSource, 6)>.js` — exports `ChocolaComponent`;
- module chunks: `run-<deterministicHash("module:" + module.id, 6)>.js` — import each other via `./run-*.js`, preserve non-`.chjs` imports verbatim, export the module's `$runtime` function and CSR class;
- hydration chunk: `run-<contentHash, 6>.js` — imports runtime functions via `./run-*.js` and calls them on `DOMContentLoaded` with embedded per-request ctx JSON.

### 7.2 Serving strategy

Serve chunks individually, not bundled:

- All chunks are served from a flat root namespace: `/run-<hash>.js`.
- Base and hydration chunk names are content-addressed (`deterministicHash(baseSource, 6)` and `deterministicHash(content, 6)`); module chunk names hash the root-relative module id (`deterministicHash("module:" + id, 6)`). All names are deterministic, so identical chunks deduplicate across pages.
- Module chunk names include the root-relative module id hash, so multipage chunks do not collide.
- Serve with `Content-Type: text/javascript; charset=utf-8`.
- Reuse the server's existing `ETag`, `Last-Modified`, `If-None-Match`, `If-Modified-Since`, and gzip behavior. Because module chunk names are id-addressed rather than content-addressed, keep `Cache-Control: public, max-age=0, must-revalidate` so edited module sources revalidate even when the URL is unchanged; do not mark `run-*.js` immutable.
- Reject path traversal and only serve names present in the runtime store.

### 7.3 Non-`.chjs` imports

Core preserves imports such as:

```js
import { fmt } from "./format.js";
```

Because module chunks are served flat at `/run-*.js`, a verbatim `./format.js` would resolve to the wrong URL. Kit must rewrite relative non-`.chjs` specifiers before serving.

Build a chunk-origin map per page graph:

```js
for (const id of graph.modules.keys()) {
  origins.set(`run-${deterministicHash("module:" + id, 6)}.js`, id);
}
```

For each chunk with an origin (skip the base and hydration chunks):

- match `import ... from "..."`, `export ... from "..."`, and side-effect `import "..."` statements;
- leave `./run-*.js` specifiers untouched;
- leave absolute `/...` specifiers untouched;
- for relative specifiers, resolve against `path.posix.dirname(moduleId)`;
- rewrite to `/<resolved-src-relative-path>` (preserving `?query` and `#hash`);
- if the resolved path escapes `srcDir` or is a bare specifier, leave it unchanged and warn once per site build.

Example:

| Module id | Original import | Served specifier |
|---|---|---|
| `pages/index.chjs` | `./data.js` | `/pages/data.js` |
| `pages/blog/post.chjs` | `../../lib/format.js` | `/lib/format.js` |
| `lib/counter.chjs` | `./format.js` | `/lib/format.js` |

The server resolves `/<src-relative>` against `srcDir`, and the build copies the same files into `outDir/<src-relative>`. This also keeps existing browser URLs such as `/app.js` and `/favicon.ico` working.

Limitations to document:

- Bare npm specifiers are not resolved; users need explicit relative files or an import map outside Kit.
- CSS and JSON imports are preserved as ESM imports and are not transformed; use `<style>`, a `<link>` in `app.html`, or JS data modules instead.

### 7.4 Runtime store and hydration chunks

Non-hydration chunks are invariant for a given graph. The hydration chunk embeds per-request ctx JSON and can vary per request.

Introduce a Kit `RuntimeStore`:

- memory cache for hot chunks;
- disk fallback under `<rootDir>/.chocola/runtime/` for SSR/dev;
- content-addressed filenames; repeated identical calls reuse the same file;
- clear the runtime directory on process startup before warming;
- bounded memory entries, with disk as the source of truth for evicted hydration chunks;
- `add(runtimeFiles)`, `get(name)`, `writeTo(dir)`, `clear()`.

Behavior:

- `build`: write every chunk (including the hydration chunk rendered for that route) to `outDir`.
- `serve`: write chunks to the runtime store on first render; serve later requests from memory or disk. The hydration chunk URL is content-hashed, so it remains stable for that ctx.
- `dev`: same as `serve`; rebuild clears the runtime store.

If disk growth from high-cardinality ctx becomes a concern, document a cleanup policy (delete `.chocola/runtime` on deploy/restart; it is disposable). Do not inline chunks by default, because the acceptance requirement is stable ESM URLs.

## 8. Styles, hashes, and output

### 8.1 Scoped styles

`render()` returns one combined scoped CSS string per page.

- Hash the content with `deterministicHash(styles, 6)`.
- Emit/serve as `sc-<hash>.css`.
- Skip the file and link when `styles` is empty.
- Deduplicate identical content across pages.

### 8.2 Global styles

Global styles are author-managed and live in `app.html` as normal links:

```html
<link rel="stylesheet" href="/styles.css">
```

- `styles.css` is a regular non-`.chjs` source asset under `srcDir`, so Kit serves it in dev/SSR and copies it into `outDir` on build.
- Kit does not read, concatenate, hash, or emit `css-*` files.
- There is no `bundle.globalStyles` config.

### 8.3 Runtime files

Emit/serve every `{ name, content }` from core after import rewriting:

- `run-*.js` at the output root;
- no subdirectories, because core's inter-chunk imports are `./run-*.js`.

### 8.4 `hashMap`

- Merge `result.hashMap` from every page render.
- Keys are root-relative module ids for template-bearing modules (`pages/index.chjs`, `lib/card.chjs`); modules with no `<template>` are absent.
- Values are the 8-character CSS ids from core (`deterministicHash(moduleId, 8)`).
- Sort keys before writing.
- Write `<rootDir>/.chocola/hashes.json` with 2-space JSON and a trailing newline.
- Write after `chocola build` and after SSR/dev warm-up or rebuild; do not write per request.
- Expose the map as `handler.hashMap` and include it in the `emitSite` report.
- Optional: expose `GET /__chocola/hashes.json` in dev for debugging.

Migration note: old hashes were keyed by component filename (`greeting.html`) and derived from that filename. New hashes are keyed by module id (`lib/greeting.chjs`) and derive from the module id, so values change. Update docs and any tooling that consumes `.chocola/hashes.json`.

### 8.5 Output tree

```text
dist/
  index.html
  about.html
  blog/
    index.html
    post.html
  sc-<hash>.css           # scoped styles
  run-<hash>.js           # base/module/hydration chunks
  styles.css              # source asset linked from app.html
  app.js                  # copied source assets
  favicon.ico
  static/
    hello.txt
  pages/
    ...                   # non-.chjs source files imported by pages/lib
  lib/
    ...                   # non-.chjs source files imported by components
```

### 8.6 Static and source assets

Kit owns all asset handling:

- Copy `<srcDir>/<staticDir>/**` to `outDir/<staticDir>/**` (for example `dist/static/hello.txt`), matching current `/static/*` URLs.
- Copy non-`.chjs` source files under `srcDir` to the same relative path in `outDir`, excluding:
  - `app.html` (shell);
  - `.chjs` files;
  - `<staticDir>/**` (handled by the static copy above);
  - `.chocola`, `node_modules`, and dot-directories.
- Serve `/<src-relative>` from `srcDir` in dev/SSR. Keep the existing safe-path checks.
- Keep `emptyOutDir` behavior: remove `outDir` before a build when true.

## 9. Dev, SSR, build, and CLI

### 9.1 Shared render pipeline

Add to `routing.js`:

- `renderRoute(state, routeOrPathname, ctx)`:
  1. match route;
  2. `const result = await render(page.graph, ctx)`;
  3. rewrite runtime imports;
  4. assemble the document;
  5. return `{ page, route, html, styles, runtime, hashMap, head }`.
- `emitSite(state, { ctx, ctxPerRoute })`:
  1. clear/create `outDir` per `emptyOutDir`;
  2. for each route, render and write `outRel`;
  3. write scoped CSS and runtime chunks once;
  4. copy static/source assets;
  5. persist `hashes.json`;
  6. return `{ results, files, copies, hashMap, runtime }`.
- Default export `compileMultipage(rootDir, { overrides, config })` builds state then emits, preserving the CLI's existing `build` entry point.

### 9.2 SSR server

`server/index.js`:

- Replace core config imports with Kit config.
- Build `buildSiteState` once at startup.
- Build route table once.
- Create the runtime store and warm render every route with empty ctx to populate invariant chunks, scoped CSS, and `hashMap`.
- Per request:
  1. match route;
  2. run middleware and merge query/ctx;
  3. `renderRoute` with per-request ctx;
  4. ingest CSS/runtime into virtual store (and disk for hydration chunks);
  5. serve assembled HTML with ETag/gzip.
- Serve virtual CSS/JS, then source/static files, then 404.
- Expose `handler.graphs`, `handler.routes`, `handler.hashMap`, `handler.virtualFiles`, `handler.paths`, and `handler.state` for tests and introspection.
- Keep `createServer` and `createServerRenderer` aliases.

### 9.3 Dev server

`dev/index.js`:

- Replace `loadConfig/resolvePaths/buildMultipageGraph/emitMultipage` with Kit config/state.
- Build state once at startup.
- Watch `srcDir` recursively; on change, debounce, rebuild `buildSiteState`, regenerate the graph mirror, clear runtime/scoped caches, and update `lastBuildTime`.
- Render per request through the same shared pipeline; do not serve prebuilt HTML from `outDir`.
- Serve runtime CSS/JS from the runtime store, and source/static files from the filesystem.
- Keep `/api/hot-reload`.
- Inject the hot-reload script before `</body>` in assembled HTML.
- Dev does not need to write `outDir`; `chocola build` is the output path. If output writing is desired later, it can reuse `emitSite` after rebuild without affecting request rendering.

### 9.4 CLI

`bin/chocola.js`:

- Remove the core `loadConfig` import.
- `resolveConfig` uses Kit's `loadConfig` with `customPath` and CLI overrides.
- `build` calls `compileMultipage`/`emitSite`.
- `dev` and `serve` pass the resolved config into the modules.
- Update `--help` for new flags and the `libDir` deprecation.
- Keep the `chocola` and `chjs` binaries.

## 10. File-by-file migration

| File | Change |
|---|---|
| `package.json` | Confirm the `chocola` dependency exposes `buildModuleGraph`, `render`, `compile`, and `normalizeConfig` from `chocola/compiler`, and `deterministicHash` from `chocola/compiler/utils.js`. Do **not** add a `chalk` dependency. Add `chalk.js` and `config.js` to `files` (and `exports` for `config.js` if created). |
| `chalk.js` (new) | Copy `specs/assets/chalk.js` verbatim. This is the previously shipped `chocola/compiler/chalk.js` implementation. Update this module if additional color/style helpers are needed. |
| `config.js` (new) | Kit config loader, defaults, path resolution, CLI override merging, `libDir` deprecation. |
| `utils.js` | Keep raw config and warning helpers; drop core `loadConfig` assumptions; import `chalk` from `./chalk.js` instead of `chocola/compiler/chalk.js`. |
| `routing.js` | Replace old imports with `buildModuleGraph`, `render`, `deterministicHash`, and parser helpers. Add page preprocessing (`<chocolakit:*>` extraction), graph mirror materialization, discovery, site state, shell/head handling, route rendering, runtime rewriting, output, and hashes. Remove `toComponentSFC`, `injectPageIntoLayout`, `pageComponentName`, `pageComponentTag`, and old head splitting. |
| `server/index.js` | Use Kit config/state, per-request `render`, runtime store, document assembly, source/static serving, hash exposure; import `chalk` from `../chalk.js`. |
| `dev/index.js` | Use Kit config/state, per-request render, full rebuild watcher (including graph mirror), runtime store, hot-reload injection; import `chalk` from `../chalk.js`. |
| `bin/chocola.js` | Use Kit config loader; update flags/help/build path; deprecate `libDir`; import `chalk` from `../chalk.js`. |
| `tests/fixtures/basic/**` | Convert to `.chjs` with in-page `<chocolakit:head>`, add required `src/app.html` with a global stylesheet link, remove `src/index.html`, remove `<app>`, add explicit imports, keep assets. |
| `tests/fixtures/server/**` | Convert/reuse the basic fixture with server config. |
| `tests/compiler.test.js` | Replace old core API assertions with Kit site/build/runtime integration tests. |
| `tests/routing.test.js` | Rewrite for `.chjs` discovery, in-page head preprocessing, shell assembly, route matching, and output. |
| `tests/server.test.js` | Rewrite fixtures and assertions for ESM runtime, per-request render, scoped CSS, hashes, static, middleware. |
| `tests/config.test.js` | Test Kit `loadConfig`, defaults, overrides, `pagesDir`/`appFile`, `libDir` deprecation, warnings. |
| `tests/cli.test.js` | Rewrite fixtures and build/serve expectations for `.chjs`. |
| `documentation/**` | Update all references to `.html` pages, `<app>`, `src/index.html`, implicit `src/lib` discovery, old runtime/hash behavior. |
| `documentation/04-reference/04-migration.md` (new) | Step-by-step migration guide for users. |
| `README.md`, `ROADMAP.md` | Update the description and roadmap to reflect the new core API. |
| `.gitignore` | Ignore `.chocola/` (including the graph mirror and runtime store) and fixture-generated `dist/`/`.chocola/` if not already ignored. |

## 11. Fixture and test rewrite

### 11.1 `tests/fixtures/basic`

Target shape:

```text
basic/
  chocola.config.json          { "bundle": { "srcDir": "src", "outDir": "dist" } }
  src/
    app.html                   required shell with <chocolakit:head>, <chocolakit:body>, and <link rel="stylesheet" href="/styles.css">
    styles.css                 global styles, linked from app.html
    app.js                     source asset
    favicon.ico                source asset
    pages/
      index.chjs               imports ../lib/greeting.chjs, counter.chjs, card.chjs; contains <chocolakit:head>
    lib/
      greeting.chjs
      counter.chjs             imports ./format.js
      card.chjs                imports ./action.chjs
      action.chjs
      format.js
      unused.chjs              must not enter the graph
    static/
      hello.txt
```

- Page template mirrors the old body content, without `<app>`.
- `index.chjs` declares `export let title = "Fixture"`, imports every component it uses, and includes `<chocolakit:head><title>{title}</title>...</chocolakit:head>`, exercising preprocessing and per-request override.
- `card.chjs` imports `./action.chjs`; no auto-discovery.
- `counter.chjs` imports `./format.js` to exercise non-`.chjs` rewriting.
- `app.html` links `/styles.css` directly; there is no `globalStyles` config.
- Do not check generated `dist/` or `.chocola/` into the fixture; tests build into a temp copy.
- Remove `src/index.html`, old `.html` components, `<app>`, sidecar head files, and `globalStyles` config.

### 11.2 Test coverage

Rewrite/extend tests to assert:

- `buildSiteState` builds one graph per page and a route table; `pages/index.chjs` maps to `/`.
- `pages/index.chjs` is required as the app entry point; there is no `bundle.entry` path.
- Pages map to routes and `outRel` correctly.
- Missing `app.html` throws with the expected path; there is no fallback shell.
- Missing `pages/`, duplicate routes, `.html` pages, `<app>`, and unknown `<chocolakit:*>` tags produce clear errors.
- Page `<chocolakit:head>` is extracted, removed from the mirror source, validated, interpolated with ctx and prop defaults, and inserted into the shell.
- Shell validation: one body slot, at most one head slot, no `<app>`.
- Rendered HTML contains the page fragment inside the shell, not `<app>`.
- Scoped CSS is content-hashed and linked in the shell; global styles are author-managed `<link>` tags in `app.html` and are not rewritten or hashed by Kit.
- Runtime chunks are ESM (`type="module"`), served with `text/javascript`, and have ETag/304/gzip behavior.
- Non-`.chjs` imports in chunks are rewritten to `/<src-relative>` URLs and those URLs resolve in the server.
- `hashMap` keys are module ids and `.chocola/hashes.json` is written after build/warm-up.
- SSR/dev calls `render` per request while graphs are built once (instrument `buildModuleGraph`/`render` in a test or assert state identity).
- Multipage routes serve the correct page and head.
- Static assets, source assets, favicon, and `/static/*` still work.
- Middleware, query props, config precedence, zero-config defaults, and CLI flags keep working.
- `npm test` passes with the new core package.

## 12. Documentation update

Update every doc that references the old model:

- `.html` components/pages → `.chjs`;
- implicit `src/lib` discovery → explicit imports;
- `<app>` and `src/index.html` → `src/pages/index.chjs` + required shell `<chocolakit:body>`;
- `<chocolakit:head>` stays in the page and is preprocessed by Kit;
- `bundle.entry` → `src/pages/index.chjs` as the `/` route;
- `bundle.globalStyles` / `css-*` output → `<link rel="stylesheet">` in `app.html`;
- `renderPage`/`emit`/`buildMultipageGraph` → `render`/`buildModuleGraph`/Kit site API;
- runtime chunks → ESM served at `/run-*.js`;
- hashes → module-id keys;
- `libDir` → deprecated.

Add a migration guide with before/after examples:

```html
<!-- before: src/index.html -->
<app><Greeting name="World" /></app>

<!-- after: src/pages/index.chjs -->
<script>
  import Greeting from "../lib/greeting.chjs";
</script>
<template>
  <Greeting name="World" />
</template>
```

```html
<!-- before: src/pages/about.html -->
<chocolakit:head><title>About</title></chocolakit:head>
<main>About</main>

<!-- after: src/pages/about.chjs -->
<chocolakit:head><title>About</title></chocolakit:head>
<template><main>About</main></template>
```

Global styles move into the required shell:

```html
<!-- src/app.html -->
<link rel="stylesheet" href="/styles.css">
```

## 13. Implementation runbook for an AI coding agent

This section is written for an AI coding agent. A human drives the work; the agent executes one step at a time and reports back. The rest of this document is the specification; this section is the operating procedure.

### 13.1 Operating contract

The human will instruct the agent with a message shaped like:

> Implement step 3 of `specs/0001-chocolakit-chjs-compiler-migration.md`. Stop and report when done.

Rules the agent must follow:

1. **Read first.** Read `AGENTS.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, this spec, and the files listed for the current step before editing anything.
2. **One step at a time.** Do only the step the human names. Do not start later steps, and do not bundle unrelated cleanup into the same change.
3. **Do not commit.** Never run `git commit`, `git push`, `gh pr create`, or equivalent unless the human explicitly asks in the same instruction.
4. **Do not add dependencies.** In particular, do not add `chalk`. Copy `specs/assets/chalk.js` into `chalk.js` as specified. Do not change the `chocola` dependency.
5. **Do not edit Chocola core.** `node_modules/chocola/**` and the Chocola source repository are out of scope. If the installed core API does not match §3, stop and report.
6. **Respect user work.** Run `git status --short` before editing. If tracked files outside this migration's expected surface are modified, report and ask before touching them.
7. **Stay inside the step's file list.** If the step truly requires another file, make the change and list it under "Deviations" in the report.
8. **No silent design changes.** If the code reality contradicts this spec, stop and ask the human for an amendment. Spec changes are allowed; unplanned implementation deviations are not.
9. **Tests are the contract.** Use the repo's documented command, `npm test` (do not use `pnpm`, `yarn`, or a different runner). Run targeted tests while iterating and the full suite before reporting a step complete.
10. **Report honestly.** Include the exact commands run, their outcome, and any remaining failures. Do not claim a step is complete if its verification did not pass.
11. **Keep style consistent.** Follow the existing module style and the `snake_case` internal / `camelCase` public convention from `CONTRIBUTING.md`.
12. **Temporary files stay outside the repo.** Use the OS temp directory for scratch fixtures or logs. Do not add scratch files to the repository.

### 13.2 Per-step protocol

A **gate** is a hard stop. When a step says "Gate: report", finish the report, end your turn, and wait for the human. Do not continue into the next step just because the current one passed.

Before editing:

- State the current step, its goal, and the files you expect to touch.
- Confirm required earlier steps are complete and their verification passed.

While working:

- Keep the diff scoped. Prefer small edits over rewrites.
- If a test reveals a spec gap, stop and report it instead of inventing behavior.

Before reporting:

- Run the step's verification commands.
- Run `git status --short` and `git diff --stat` to confirm the change surface.
- Use this report format:

```text
Step N — <name>
Status: done | blocked
Files changed: <paths>
Commands run: <command → pass/fail, with failure excerpts if any>
Verification: <which checks passed>
Deviations: <none | description + reason>
Next: Step N+1 — <name>
```

If blocked, replace "Next" with the exact question for the human and the options considered.

### 13.3 Steps

Steps are ordered. Each step assumes the previous ones are complete unless stated otherwise.

#### Step 0 — Preflight and baseline (read-only)

Goal: establish a trustworthy baseline and confirm the core API.

Files: none. Do not edit.

Actions:

1. Read the files listed in rule 1 of §13.1.
2. Run `git status --short`. Report any modified or untracked paths. The pre-existing `package.json` change that points `chocola` at the local `chocola-2.0.0-next.13.tgz` is expected; do not revert it.
3. Confirm the installed core exports the API in §3:
   ```sh
   node -e "import('chocola/compiler').then(m => console.log(Object.keys(m).sort().join('\n')))"
   node -e "import('chocola/compiler/utils.js').then(m => console.log(Object.keys(m).sort().join('\n')))"
   ```
   The first output must include `buildModuleGraph`, `render`, `compile`, and `normalizeConfig`. The second must include `deterministicHash`. If `deterministicHash` is missing from the index but present in `utils.js`, that is expected; do not import it from the index.
4. Run `npm test` and capture the full output. Classify each failure as:
   - `old-api`: caused by `buildMultipageGraph`/`getComponents`/`renderPage`/`emitMultipage` or removed core modules;
   - `expected-red`: assertions this migration will rewrite;
   - `unrelated`/`environment`.
5. Do not fix anything in this step.

Verify: the export check passes and the baseline is recorded.

Gate: report and wait. The human must confirm the baseline and the §16 decisions. If the human says "use the recommended options", record that and continue.

#### Step 1 — Local chalk and Kit config layer

Goal: remove the last core-module dependencies and make Kit own configuration.

Files: `chalk.js` (new), `config.js` (new), `utils.js`, `bin/chocola.js`, `package.json`.

Actions:

1. Copy `specs/assets/chalk.js` to `chalk.js` byte-for-byte. Do not modify the copy unless a later step needs a helper, and list any change as a deviation.
2. Do not add `chalk` to `dependencies` or `devDependencies`.
3. Implement `config.js` exactly as §4.1:
   - `DEFAULT_CONFIG`;
   - `loadConfig(rootDir, { silent, customPath, overrides })` returning `{ config, paths, raw }`;
   - `resolvePaths(rootDir, config)`;
   - `normalizeConfig` passthrough for core;
   - `bundle`/`build` handling, `libDir` deprecation warning, and CLI override merging.
4. Update `utils.js` to import from `./chalk.js` and to stop assuming core `loadConfig`.
5. Update `bin/chocola.js` for §4.2: keep existing flags, add `--pagesDir`, `--appFile`, `--staticDir`, accept `--libDir` with a deprecation warning, keep `--config`, and route config resolution through Kit.
6. In `package.json`, add `chalk.js` and `config.js` to `files`; add `./config` to `exports`. Do not change the dependency version.

Verify:

```sh
node --check chalk.js
node --check config.js
node --check utils.js
node --check bin/chocola.js
```

Also smoke-load the loader against a temporary config in the OS temp directory and confirm defaults, overrides, and `libDir` behavior. Do not add the temp fixture to the repo.

Note: `bin/chocola.js` may still fail at runtime because `routing.js` has not been migrated yet. That is expected at this step; only syntax and config-loader behavior are gated.

Gate: report. The human may review the `config.js` surface before routing depends on it.

#### Step 2 — Page preprocessing, graph mirror, discovery, and site state

Goal: replace `buildMultipageGraph` with Kit-owned discovery and `buildSiteState`, feeding core a clean mirror.

Files: `routing.js`.

Actions:

1. Replace old core imports with `buildModuleGraph` and `render` from `chocola/compiler`, `deterministicHash` from `chocola/compiler/utils.js`, and `compileExpr` from `chocola/parser/index.js`. Remove `buildMultipageGraph`, `getComponents`, `renderPage`, and `emitMultipage` imports.
2. Delete the old multipage/layout machinery: `toComponentSFC`, `injectPageIntoLayout`, `pageComponentName`, `pageComponentTag`, sidecar head splitting, and implicit `src/lib` discovery.
3. Implement route/output helpers from §5.2, including `filePathToRoute`, `routeAliases`, `srcRelToOutputRel`, `normalizePathname`, `matchRoute`, and `buildRouteTable` over `.chjs`.
4. Implement `extractPageDirectives(source, filePath)`:
   - require exactly one `<template>`;
   - find a top-level `<chocolakit:head>...</chocolakit:head>`;
   - reject nested/multiple head blocks or a head block inside `<template>`;
   - validate head children against the allowed tags in §6.2;
   - reject any other `<chocolakit:*>` tag and any `<app>`;
   - return `{ source: cleanedSource, headSource }`.
5. Implement graph-mirror materialization per §5.3:
   - recreate `<rootDir>/.chocola/graph/`;
   - copy every `.chjs` file from `srcDir`, skipping `staticDir`, dot-directories, and `node_modules`;
   - write cleaned page sources for page entries;
   - leave non-page modules unchanged after validating they contain no `<chocolakit:*>` tags.
6. Implement `buildSiteState(rootDir, { overrides, config })` returning the shape in §5.3, build one graph per page via `buildModuleGraph(graphRoot, { entry, config: coreConfig })`, and populate `page.chunkOrigins`.
7. Implement the discovery errors from §5.1: missing pages, duplicate routes, `.html` pages, legacy `src/index.html`, missing `<template>`, and unknown directives. Use `[chocola/routing]` prefixes and include the offending path. The missing `app.html` error is added with shell loading in Step 3.

Verify:

```sh
node --check routing.js
```

Then run a scratch script in the OS temp directory that imports `routing.js`, builds state for a temporary site with `src/app.html`, `src/pages/index.chjs`, `src/pages/about.chjs`, and `src/lib/card.chjs`, and asserts:

- routes `/` and `/about` exist;
- `[...page.graph.modules.keys()]` contains `pages/index.chjs`, `pages/about.chjs`, and `lib/card.chjs`;
- the mirror file for `pages/index.chjs` no longer contains `<chocolakit:head>`;
- `page.headSource` contains the extracted head.

Gate: report. Do not proceed to shell work if module ids or the mirror layout differ from §3/§5.3.

#### Step 3 — Required shell, head interpolation, and document assembly

Goal: assemble complete documents from the required `app.html`.

Files: `routing.js`.

Actions:

1. Add shell loading and validation to `buildSiteState`, per §6.1:
   - default `src/app.html`;
   - throw `[chocola/routing]` with the expected path when missing;
   - require exactly one `<chocolakit:body>`;
   - allow at most one `<chocolakit:head>` inside `<head>`;
   - reject `<app>`;
   - require `</head>` and `</body>`.
2. Implement head interpolation from §6.2 using `compileExpr` against `ctx` merged with `page.graph.root.compProps` defaults.
3. Implement `assembleDocument({ state, page, ctx, result, runtime })` with the exact order in §6.3. Insert the core fragment verbatim at `<chocolakit:body>` and never wrap it in `<app>`.
4. When the shell has no head slot, append page head content before `</head>` and emit the warning once per build.

Verify: extend the Step 2 scratch script:

- a page with `<chocolakit:head><title>{title}</title></chocolakit:head>` renders the interpolated title with `ctx` and with the root prop default;
- a page without a head leaves the shell head unchanged;
- a missing shell throws with the path;
- two body slots, two head slots, `<app>`, and a missing `</body>` each throw.

Gate: report.

#### Step 4 — Shared render pipeline, runtime rewriting, and `RuntimeStore`

Goal: render a page into a complete response and serve valid ESM chunks.

Files: `routing.js` (and `utils.js` only if shared helpers are needed).

Actions:

1. Implement `renderRoute(state, routeOrPathname, ctx)` per §9.1. Return `{ page, route, html, styles, runtime, hashMap, head }` with runtime imports already rewritten.
2. Build the chunk-origin map from `page.chunkOrigins` per §7.3 and rewrite only relative non-`.chjs` specifiers to `/<src-relative>` URLs. Leave `./run-*.js` and absolute paths untouched; warn once per build for bare specifiers and for relative paths that escape `srcDir`.
3. Implement `RuntimeStore` per §7.4 with `add`, `get`, `writeTo`, `clear`, memory caching, disk fallback under `<rootDir>/.chocola/runtime/`, and startup clearing.
4. Implement `emitSite(state, { ctx, ctxPerRoute })` per §9.1 and the default `compileMultipage` export. Write scoped CSS, runtime chunks, static assets, source assets, and `hashes.json` exactly as §8.
5. Keep runtime chunk names intact. Do not rename, bundle, or inline them.

Verify: extend the scratch script to:

- render `/` and assert the assembled HTML has no `<chocolakit:body>` slot left, contains the page fragment, includes the scoped `<link>` when styles exist, and includes one `<script type="module" src="/run-*.js">` per runtime entry;
- assert a rewritten `./format.js` becomes `/lib/format.js`;
- assert hydration output is stable for the same ctx and differs for different ctx;
- run `emitSite` into a temp `outDir` and assert `index.html`, `sc-*.css`, `run-*.js`, `styles.css`, source assets, static assets, and `.chocola/hashes.json` exist.

Gate: report before touching the servers. The human may inspect the emitted temp output.

#### Step 5 — SSR server

Goal: serve the new pipeline with state built once and `render` per request.

Files: `server/index.js`.

Actions:

1. Replace core config imports with Kit `loadConfig`/`resolvePaths`.
2. Build `buildSiteState`, the route table, and the `RuntimeStore` once at handler creation.
3. Warm every route with empty ctx to populate invariant chunks, scoped CSS, and `hashMap`.
4. For each request, follow §9.2: match, run middleware, merge query/ctx, `renderRoute`, ingest assets, serve assembled HTML with ETag/gzip.
5. Serve runtime CSS/JS first, then `/<src-relative>` source assets, then static files, then 404.
6. Expose `handler.graphs`, `handler.routes`, `handler.hashMap`, `handler.virtualFiles`, `handler.paths`, and `handler.state`.
7. Import `chalk` from `../chalk.js`. Keep `createServer` and `createServerRenderer` aliases.

Verify: the existing server tests will still be red until Step 8 rewrites them. Instead, run a scratch server against the Step 2/3 temp site on an ephemeral port and assert:

- `/` returns the assembled document;
- `/run-*.js` returns `text/javascript` with a module body;
- rewritten `/lib/format.js` returns the source file;
- `/styles.css`, `/static/hello.txt`, and `/favicon.ico` resolve;
- a second request reuses the same graph objects and produces a new `render` result.

Gate: report.

#### Step 6 — Dev server

Goal: same pipeline as SSR, with full rebuilds and hot reload.

Files: `dev/index.js`.

Actions:

1. Replace `loadConfig`, `resolvePaths`, `buildMultipageGraph`, and `emitMultipage` with Kit config/state.
2. Build state once at startup.
3. Watch `srcDir` recursively; on change, debounce, rebuild state and the graph mirror, clear runtime/scoped caches, and update `lastBuildTime`.
4. Render per request through the shared pipeline. Do not serve prebuilt HTML from `outDir`.
5. Serve runtime assets from the store and source/static files from disk.
6. Keep `/api/hot-reload` and inject the hot-reload script after runtime tags in assembled HTML.
7. Import `chalk` from `../chalk.js`.

Verify: start dev against the temp site on an ephemeral port and assert the document, runtime chunks, source assets, and hot-reload script; edit a page in the temp site and assert the next request reflects the change.

Gate: report.

#### Step 7 — CLI wiring

Goal: make the CLI drive the new pipeline end to end.

Files: `bin/chocola.js`.

Actions:

1. Complete `resolveConfig` using Kit `loadConfig` with `customPath` and CLI overrides.
2. Wire `build` to `compileMultipage`/`emitSite`.
3. Wire `dev` and `serve` to the updated modules with the resolved config.
4. Update `--help` for `--pagesDir`, `--appFile`, `--staticDir`, and the `libDir` deprecation.
5. Keep the `chocola` and `chjs` binaries and the existing exit-code behavior.

Verify:

```sh
node --check bin/chocola.js
```

From a temp fixture copy, invoke the CLI in the repository (for example
`node <repo>/bin/chocola.js build`) and assert it emits `dist/index.html` and
the runtime/scoped assets. Do not run `dev`/`serve` here; Step 10 covers them.

Gate: report.

#### Step 8 — Fixtures and tests

Goal: migrate fixtures and turn the suite green against the new API.

Files: `tests/fixtures/basic/**`, `tests/fixtures/server/**`, `tests/compiler.test.js`, `tests/routing.test.js`, `tests/server.test.js`, `tests/config.test.js`, `tests/cli.test.js`.

Actions:

1. Migrate `tests/fixtures/basic` to the shape in §11.1. Add the required `src/app.html`, in-page `<chocolakit:head>`, explicit `.chjs` imports, and remove `src/index.html`, `<app>`, `.html` components, sidecar heads, and `globalStyles`.
2. Update `tests/fixtures/server` to reuse the migrated fixture with server config.
3. Rewrite the test files to cover every item in §11.2. Keep existing coverage that still applies.
4. For tests that must prove graphs are built once, instrument `buildModuleGraph`/`render` or assert state object identity; do not weaken the assertion to "it works".
5. Remove or replace assertions for removed APIs instead of skipping them. Do not add `test.skip` for the new behavior.
6. Use no new test dependencies.

Verify:

```sh
npm test
```

Fix failures inside the migration surface. If a failure is outside it (for example a core bug), stop and report with a minimal reproduction.

Gate: report with the full pass/fail summary. The human may ask for targeted test runs before accepting.

#### Step 9 — Documentation

Goal: make the human-facing documentation match the new behavior.

Files: `documentation/**`, `documentation/04-reference/04-migration.md` (new), `README.md`, `ROADMAP.md`, `.gitignore`.

Actions:

1. Update docs per §12: `.chjs`, explicit imports, required shell, in-page head, `pages/index.chjs` entry, author-managed global styles, runtime URLs, hash keys, `libDir` deprecation.
2. Add the migration guide with the before/after examples in §12.
3. Ignore `.chocola/` (graph mirror and runtime store) and fixture-generated `dist/`/`.chocola/` in `.gitignore`.
4. Update the PR description/breaking-change notes only if the human asks; do not open a PR.

Verify: search the docs for stale terms and confirm each remaining hit is intentional:

```sh
git grep -n "\.html\|<app>\|<chocolakit:head>\|globalStyles\|libDir\|run-" -- documentation README.md ROADMAP.md
```

Gate: report.

#### Step 10 — Final verification

Goal: prove the migration works end to end.

Files: none expected. Fixes must be reported and scoped.

Actions:

1. Run `npm test` and record the result.
2. Package Kit and test the installed CLI against a temp fixture copy:
   ```sh
   npm pack
   cd <temp-dir>/basic
   npm install <repo>/<packed-tarball>.tgz
   npx chocola build
   ```
   Then:
   - inspect `dist/` against §8.5;
   - run `npx chocola serve` and fetch `/`, a runtime chunk, the scoped CSS, `styles.css`, a source asset, and a static asset;
   - run `npx chocola dev`, fetch `/`, edit a page, and confirm the next response updates.
   Do not install the tarball into the repository working tree.
3. Confirm `.chocola/hashes.json` exists after build/warm-up and uses module-id keys.
4. Confirm no `chalk` dependency, no `css-*` output, no sidecar head files, and no core pipeline imports remain:
   ```sh
   git grep -n "buildMultipageGraph\|getComponents\|renderPage\|emitMultipage\|compiler/chalk\|compiler/pipeline"
   ```
5. Run `git status --short` and confirm only intended files changed.

Verify: every item in §15 is checked, or the exceptions are listed explicitly.

Gate: report the final summary and wait. Do not commit or open a PR unless the human explicitly instructs it in that turn.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hydration chunks embed per-request ctx, so URLs are high-cardinality. | Content-addressed runtime store with disk fallback; clear on startup; document `.chocola/runtime` as disposable. |
| Non-`.chjs` imports are relative to source, not the flat chunk URL. | Rewrite relative specifiers to `/<src-relative>` and serve/copy source files at those paths. |
| Bare npm specifiers do not work in the browser without a bundler/import map. | Preserve with a warning; document the limitation. |
| Explicit imports replace implicit `src/lib` discovery. | Hard break with migration errors and a migration guide. |
| Core would treat `<chocolakit:head>` as an unknown component. | Kit extracts and strips all page `<chocolakit:*>` directives into the graph mirror before core runs; unknown directives throw early. |
| The graph mirror can drift from source or change module ids. | Rebuild `.chocola/graph` on every state build, preserve the source tree layout exactly, ignore it in git, and test that ids remain `pages/index.chjs` / `lib/card.chjs`. |
| Hash keys/values change. | Document the new module-id keys and update `.chocola/hashes.json` consumers. |
| Windows path separators in module ids/URLs. | Normalize all module ids and URLs to POSIX; test on Windows. |
| Runtime chunk name collisions across pages. | Names include the root-relative module id hash; verify with a multipage fixture test. |
| Dev watcher recursion/platform differences. | Keep the existing recursive `fs.watch` approach, debounce rebuilds, and ignore `node_modules`/dot directories. |
| Concurrent SSR requests share mutable state. | Keep graphs and shell immutable; create per-request render/context/result state; runtime store is append-only/content-addressed. |
| Output and dev drift. | Dev serves from the same state/render pipeline; build is the only disk emitter. |

## 15. Acceptance checklist

- [ ] `routing.js` no longer imports `buildMultipageGraph`, `getComponents`, `renderPage`, or `emitMultipage`.
- [ ] Kit imports `buildModuleGraph` and `render` from `chocola/compiler`.
- [ ] Kit no longer imports removed core modules (`chocola/compiler/chalk.js`, `chocola/compiler/pipeline.js`); the old `chalk.js` implementation is copied locally from `specs/assets/chalk.js` and no `chalk` dependency is added.
- [ ] Every `buildModuleGraph` call passes the absolute graph mirror root as `rootDir` and an explicit page `.chjs` entry, producing ids such as `pages/index.chjs` and `lib/card.chjs`.
- [ ] Kit owns `chocola.config.json` loading and no longer calls core `loadConfig`/`resolvePaths`.
- [ ] Pages are discovered from `<srcDir>/<pagesDir>/**/*.chjs`; `pages/index.chjs` is required and serves `/`. There is no `bundle.entry`.
- [ ] Each page has one graph, built once at dev/SSR startup and rebuilt only on source changes.
- [ ] Dev and SSR call `render(graph, ctx)` per request; they do not serve prebuilt HTML.
- [ ] Multipage routes map URLs to the correct page graph, including aliases and duplicate-route errors.
- [ ] The core `html` fragment is inserted into the required Kit shell at `<chocolakit:body>`; missing `app.html`, `<app>`, and `src/index.html` are rejected with migration errors.
- [ ] Kit preprocesses page sources so `<chocolakit:head>` is extracted and removed before core runs, then interpolated into the shell at `<chocolakit:head>`.
- [ ] The shell provides `<head>`, metadata, author-managed global stylesheet links, scoped styles, and runtime tags.
- [ ] All `runtime` descriptors are served as ESM at stable `/run-*.js` URLs with correct MIME, ETag, 304, and gzip behavior.
- [ ] Non-`.chjs` imports in runtime chunks resolve to served/copied source files.
- [ ] Scoped styles are emitted as content-hashed `sc-*.css`; global styles are linked directly in `app.html` with no `css-*` output.
- [ ] `hashMap` is keyed by root-relative module ids, persisted to `.chocola/hashes.json`, and exposed by the server handler.
- [ ] `src/static` and non-`.chjs` source assets are copied/served by Kit.
- [ ] Templates, fixtures, docs, and examples use `.chjs` with explicit imports.
- [ ] The Kit test suite passes against the new API with `npm test`.
- [ ] A manual `chocola build`, `chocola dev`, and `chocola serve` smoke test passes on the migrated fixture.

## 16. Open decisions to confirm before implementation

The agent must not start Step 1 until the human confirms these. If the human accepts the recommendations, the agent records that in the Step 0 report and proceeds.

1. Serve runtime chunks individually (recommended) versus bundling them into one file.
2. Persist per-request hydration chunks under `.chocola/runtime/` (recommended) versus inlining the hydration chunk in the document.
3. Resolve non-`.chjs` imports to `/<src-relative>` URLs (recommended) versus a `/_chocola/src/` prefix.
