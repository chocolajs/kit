---
title: CLI reference
description: ChocolaKit command-line interface reference
---

## Installation

ChocolaKit ships a globally installable CLI:

```sh
npm i -g @chocolajs/kit
chjs build
```

Both `chocola` and `chjs` are available as commands and run the same binary.

## Commands

```text
Usage: chocola <command> [root] [options]

Commands:
  build   Build for production (static)
  dev     Start dev server with hot reload
  serve   Start SSR production server

Options (common):
  -c, --config <path>   Path to config file (default: <root>/chocola.config.json, optional)
  -h, --help            Show help
  -v, --version         Show version
  --plain, NO_COLOR=1   Disable color output
```

`[root]` defaults to the current working directory.

### `chocola build [root]`

Builds the static site into `outDir` (default `dist`). Requires `src/app.html` and `src/pages/index.chjs`.

```sh
chocola build                        # build with defaults
chocola build ./my-app               # build a specific project
chocola build --outDir ./tmp/build   # override output directory
chocola build --srcDir ./src         # override source directory
chocola build --pagesDir ./pages     # override pages directory (relative to srcDir)
chocola build --appFile ./app.html   # override document shell (relative to srcDir)
chocola build --staticDir ./static   # override static directory (relative to srcDir)
chocola build --no-emptyOutDir       # do not clean outDir before build
chocola build --config ./alt.json    # use an explicit config file
chocola build --libDir ./components  # deprecated and ignored
```

A `.html` file under `src/pages/` is rejected. Rename pages to `.chjs` and replace layout tags with explicit imports. See the [migration guide](./04-migration.md).

### `chocola dev [root]`

Starts the dev server with hot reload. Default: `http://localhost:3000`. Dev mode writes no `dist` output.

```sh
chocola dev                              # dev server at http://localhost:3000
chocola dev --port 5173                  # override port
chocola dev --host 0.0.0.0               # bind to all interfaces
chocola dev --open                       # open the browser after start
chocola dev --config ./chocola.dev.json  # use an explicit config
```

### `chocola serve [root]`

Builds the site state at startup and starts the SSR production server. Default: `http://localhost:8080`. Honors `PORT` for container deployment.

```sh
chocola serve                        # server at http://localhost:8080
chocola serve --port 3000            # explicit port (flag wins over PORT and config)
chocola serve --host 0.0.0.0         # bind to all interfaces
chocola serve --middleware ./mw.js   # attach an ESM middleware file
chocola serve --config ./chocola.prod.json
```

Port precedence: `--port` > `PORT` env > `server.port` > `8080`. When `PORT` is set and no host is configured, the server binds to `0.0.0.0`.

A configured middleware file that is missing throws at startup.

## Config file (`chocola.config.json`)

Fully optional. If absent, defaults are used silently:

| Key | Default |
|---|---|
| `srcDir` | `"src"` |
| `outDir` | `"dist"` |
| `pagesDir` | `"pages"` |
| `appFile` | `"app.html"` |
| `staticDir` | `"static"` |
| `emptyOutDir` | `true` |
| `treeShakeRuntime` | `true` |
| `dev.hostname` | `"localhost"` |
| `dev.port` | `3000` |
| `server.hostname` | `"localhost"` |
| `server.port` | `8080` |
| `server.middleware` | `null` |

```json
{
  "bundle": { "outDir": "build", "emptyOutDir": false },
  "dev": { "port": 5173 },
  "server": { "middleware": "./middleware.js" }
}
```

`build` is accepted as an alias for the `bundle` section. `pagesDir`, `appFile`, and `staticDir` are resolved relative to `srcDir`; `srcDir` and `outDir` are resolved relative to the project root.

`libDir` is deprecated and ignored. Kit prints a warning if it is present, because components now enter the module graph only through explicit `.chjs` imports.

**Precedence:** CLI flags > `chocola.config.json` > built-in defaults.

When `--config <path>` is explicit and the file is missing, `ENOENT` is thrown so typos surface immediately.

## Container deployment

`chocola serve` honors `PORT`:

```sh
PORT=8080 chocola serve
```

When `PORT` is set and no explicit host flag/config exists, the hostname defaults to `0.0.0.0` for container binding.

## Local delegation

When invoked globally, the CLI looks for a project-local `chocola` installation and uses its metaframework modules if present. Otherwise it uses the modules bundled with the global CLI. This lets a globally installed CLI run the project's pinned Chocola toolchain.
