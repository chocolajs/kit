---
title: Configuration
description: Technical configuration system
---

## Configuration precedence hierarchy

```
CLI flags > chocola.config.json > built-in defaults
```

### Evaluation order

1. **CLI flags** — Parsed from command-line arguments (`--port`, `--host`, `--config`, etc.)
2. **Config file** — Read from `chocola.config.json` if `--config` flag not specified
3. **Built-in defaults** — Hard-coded values used when neither CLI nor config file provides a value

### Configuration schema (internal representation)

```json
{
  "bundle": {
    "srcDir": "src",       // source directory path
    "outDir": "dist",      // build output directory path
    "libDir": "lib",       // components subdirectory relative to srcDir
    "emptyOutDir": true    // whether to clean outDir before each build write
  },
  "dev": {
    "hostname": "localhost", // dev server bind address
    "port": 3000            // dev server listen port
  },
  "server": {
    "port": 8080,          // SSR production server listen port
    "hostname": "localhost", // SSR server bind address
    "middleware": null       // path to ESM middleware file, relative to project root
  }
}
```

### Key internal behaviors

- **`emptyOutDir`** — When `true`, the output directory is recursively cleaned before write operations. When `false`, existing files are preserved and new files overlaid. This affects both SSG build and dev server rebuild behavior.

- **Middleware resolution** — `server.middleware` path is resolved relative to the project root at handler initialization. The module is dynamically imported as ESM. If the file is missing or has no default export, middleware is treated as `null` (no middleware installed).

- **PORT environment variable** — At server startup, `process.env.PORT` takes precedence over `server.port` in config file and `--port` CLI flag. This enables container deployment patterns where the orchestrator assigns the port at runtime.

- **Hostname derivation** — When `PORT` environment variable is set and no explicit hostname is provided via `--host` flag or `server.hostname` config, the server binds to `0.0.0.0`. This is an internal behavioral detail for container compatibility; users typically do not need to specify `--host` when using `PORT`.

- **Config file absence** — If `chocola.config.json` does not exist at the expected path and `--config` flag is not provided, the framework silently falls back to built-in defaults without error. This allows zero-configuration get-started experiences.