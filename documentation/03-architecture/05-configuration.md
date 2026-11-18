---
title: Configuration
description: Technical configuration system
---

## Configuration precedence hierarchy

```text
CLI flags > chocola.config.json > built-in defaults
```

### Evaluation order

1. **CLI flags** — Parsed from command-line arguments (`--port`, `--host`, `--srcDir`, `--outDir`, `--config`, and so on).
2. **Config file** — Read from `chocola.config.json` at the project root, or from the path passed with `--config`.
3. **Built-in defaults** — Used when neither CLI nor config file provides a value.

When `--config <path>` is explicit and the file is missing, loading fails with `ENOENT` so typos surface immediately. Without `--config`, a missing `chocola.config.json` silently falls back to defaults.

Unknown top-level keys are preserved in the merged config object for forward compatibility, but Kit itself only reads the documented keys.

### Configuration schema (internal representation)

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

`build` is accepted as an alias for the `bundle` section. If both are present, `bundle` wins.

### Path resolution

- `srcDir` and `outDir` are resolved relative to the project root.
- `pagesDir`, `appFile`, and `staticDir` are resolved relative to `srcDir`.
- The resulting absolute paths are used consistently by the dev server, SSR server, and static build.

```json
{
  "bundle": {
    "srcDir": "app",
    "pagesDir": "routes",
    "appFile": "shell.html",
    "staticDir": "public"
  }
}
```

With that config, Kit reads pages from `app/routes/`, the shell from `app/shell.html`, and static assets from `app/public/`.

### Key internal behaviors

- **`emptyOutDir`** — When `true` (the default), `outDir` is recursively cleaned before a static build writes output. When `false`, existing files are preserved and new files are overlaid. Dev mode never writes `outDir`, so this setting does not affect it.

- **`treeShakeRuntime`** — When `true` (the default), the compiler performs intra-module `$runtime` extraction and omits unused runtime code. It does not perform cross-module reachability; page modules still follow explicit imports.

- **`libDir`** — Deprecated and ignored. A warning is printed once per project if `libDir` appears in the config or CLI flags. Components enter the graph only through explicit `.chjs` imports; there is no component scan directory.

- **Middleware resolution** — `server.middleware` is resolved relative to the project root at handler initialization and imported as ESM. A configured file that does not exist throws immediately. A module with no callable default export is treated as no middleware.

- **PORT environment variable** — `--port` wins over everything. Otherwise `PORT` wins over `server.port`, which wins over the `8080` default. This enables container platforms that assign a port at runtime.

- **Hostname derivation** — When `PORT` is set and no explicit `--host`/`--hostname` flag or `server.hostname`/`server.host` config exists, the server binds to `0.0.0.0`. An explicit host always wins.

- **Config file absence** — If `chocola.config.json` is absent and `--config` is not provided, the framework falls back to built-in defaults without error. This keeps the zero-configuration experience working.

### Programmatic usage

`loadConfig` and `resolvePaths` are exported from `@chocolajs/kit/config`:

```js
import { loadConfig, resolvePaths } from "@chocolajs/kit/config";

const { config, paths } = await loadConfig(process.cwd(), {
  overrides: { outDir: "build" },
});
```

The returned `config` is flat (`srcDir`, `outDir`, `pagesDir`, `appFile`, `staticDir`, `emptyOutDir`, `treeShakeRuntime`, `dev`, `server`, plus unknown keys) so it can be forwarded to the compiler directly.
