import http from "http";
import fs from "fs";
import path from "path";

// Chocola imports
import { deterministicHash } from "chocola/compiler/utils.js";

import chalk from "../chalk.js";
import { loadConfig, resolvePaths } from "../config.js";
import {
  getConfig,
  isMissingConfigFile,
  queueConfigWarning,
  flushConfigWarnings,
} from "../utils.js";
import { buildSiteState, renderRoute, RuntimeStore } from "../routing.js";

const warnedDevHostname = new Set();
const warnedDevPort = new Set();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/vnd.microsoft.icon",
  ".icon": "image/vnd.microsoft.icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".oga": "audio/ogg",
  ".ogv": "video/ogg",
  ".tar": "application/x-tar",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".xhtml": "application/xhtml+xml",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isInside(abs, base) {
  if (!base) return false;
  const a = path.resolve(abs);
  const b = path.resolve(base);
  return a === b || a.startsWith(b + path.sep);
}

function hasUnsafeSegment(relPosix) {
  return relPosix
    .split("/")
    .some((segment) => segment.startsWith(".") || segment === "node_modules");
}

function safeCandidate(base, relPosix) {
  if (!base || !relPosix || relPosix.includes("\0")) return null;
  if (hasUnsafeSegment(relPosix)) return null;
  const resolved = path.resolve(base, ...relPosix.split("/"));
  return isInside(resolved, base) ? resolved : null;
}

function send(req, res, buffer, contentType) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(buffer);
}

async function serveFile(req, res, filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) return false;
  const buffer = await fs.promises.readFile(filePath);
  send(req, res, buffer, getMimeType(filePath));
  return true;
}

function hotReloadScript(buildTime) {
  return `
 <script>
 (function() {
   let lastBuildTime = ${Number(buildTime)};
   setInterval(async () => {
     try {
       const res = await fetch('/api/hot-reload', { cache: 'no-store' });
       const data = await res.json();
       if (data.buildTime > lastBuildTime) {
         lastBuildTime = data.buildTime;
         console.log('[Hot Reload] Changes detected, reloading...');
         window.location.reload();
       }
     } catch (e) {
       console.error('[Hot Reload] Check failed:', e);
     }
   }, 1000);
 })();
 </script>`;
}

function injectHotReload(html, buildTime) {
  const script = hotReloadScript(buildTime);
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, script + "\n</body>");
  }
  return html + script;
}

export async function serve(
  __rootdir,
  {
    silent = false,
    port: cliPort,
    hostname: cliHostname,
    open,
    config: providedConfig,
    paths: providedPaths,
    overrides = {},
    ctx: baseCtx,
  } = {}
) {
  const rootDir = path.resolve(__rootdir);

  const fullConfig = await getConfig(rootDir, { silent });
  let config = providedConfig;
  let paths = providedPaths;

  if (!config) {
    ({ config, paths } = await loadConfig(rootDir, { silent, overrides }));
  } else if (!paths) {
    paths = resolvePaths(rootDir, config);
  }

  const devConfig = config.dev || {};
  const listenPort = cliPort != null ? cliPort : devConfig.port ?? 3000;
  const listenHost =
    cliHostname != null ? cliHostname : devConfig.hostname ?? "localhost";

  if (!silent) {
    if (isMissingConfigFile(fullConfig)) {
      // top-level already warned; use defaults silently
    } else if (fullConfig.dev != null) {
      const rawDev = fullConfig.dev;
      if (
        rawDev.port == null &&
        cliPort == null &&
        !warnedDevPort.has(rootDir)
      ) {
        warnedDevPort.add(rootDir);
        queueConfigWarning(
          rootDir,
          chalk.bold.yellow("WARNING!"),
          `dev.port not defined in chocola.config.json file: using default ${listenPort} dev.port.`
        );
      }
      if (
        rawDev.hostname == null &&
        rawDev.host == null &&
        cliHostname == null &&
        !warnedDevHostname.has(rootDir)
      ) {
        warnedDevHostname.add(rootDir);
        queueConfigWarning(
          rootDir,
          chalk.bold.yellow("WARNING!"),
          `dev.hostname not defined in chocola.config.json file: using default ${listenHost} dev.hostname.`
        );
      }
    }
  }

  const runtimeStore = new RuntimeStore(rootDir);

  let state = null;
  let routeTable = new Map();
  let scopedCss = new Map();
  let hashMap = {};
  let warmResults = new Map();
  let lastBuildTime = Date.now();

  async function build() {
    const nextState = await buildSiteState(rootDir, { config, paths });
    const nextScoped = new Map();
    const nextHashMap = {};
    const nextRuntime = new Map();
    const nextWarm = new Map();

    for (const route of [...nextState.pages.keys()].sort()) {
      const result = await renderRoute(nextState, route, {});
      nextWarm.set(route, result);

      if (result.styles) {
        nextScoped.set(
          `sc-${deterministicHash(result.styles, 6)}.css`,
          result.styles
        );
      }
      for (const chunk of result.runtime) {
        nextRuntime.set(chunk.name, chunk.content);
      }
      Object.assign(nextHashMap, result.hashMap);
    }

    // Swap caches only after a fully successful rebuild so failed builds keep
    // serving the previous state.
    await runtimeStore.clear();
    if (nextRuntime.size > 0) {
      await runtimeStore.add(
        [...nextRuntime].map(([name, content]) => ({ name, content }))
      );
    }

    state = nextState;
    routeTable = nextState.routeTable;
    scopedCss = nextScoped;
    hashMap = nextHashMap;
    warmResults = nextWarm;
    lastBuildTime = Date.now();
  }

  async function ingestRequest(result) {
    if (result.styles) {
      scopedCss.set(
        `sc-${deterministicHash(result.styles, 6)}.css`,
        result.styles
      );
    }
    if (result.runtime.length > 0) {
      await runtimeStore.add(result.runtime);
    }
    Object.assign(hashMap, result.hashMap);
  }

  await build();

  let compileTimeout = null;
  let rebuilding = false;
  let rebuildQueued = false;

  async function runRebuild() {
    if (rebuilding) {
      rebuildQueued = true;
      return;
    }
    rebuilding = true;
    try {
      await build();
      console.log(chalk.green("✓"), "Hot reload: compiled successfully");
    } catch (error) {
      console.error(
        chalk.red("✗"),
        "Hot reload compilation failed:",
        error.message
      );
    } finally {
      rebuilding = false;
      if (rebuildQueued) {
        rebuildQueued = false;
        scheduleRebuild();
      }
    }
  }

  function scheduleRebuild() {
    clearTimeout(compileTimeout);
    compileTimeout = setTimeout(() => {
      void runRebuild();
    }, 300);
  }

  const watcher = fs.watch(
    paths.srcDir,
    { recursive: true },
    (eventType, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (name.includes("node_modules")) return;
      scheduleRebuild();
    }
  );

  async function handler(req, res) {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      let pathname = decodeURIComponent(url.pathname);

      // Normalize duplicate slashes; keep trailing slash for route lookup.
      pathname = pathname.replace(/\/+/g, "/");

      if (pathname === "/api/hot-reload") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ buildTime: lastBuildTime }));
        return;
      }

      // 1) SSR route through the shared render pipeline.
      const matched =
        routeTable.get(pathname) ||
        routeTable.get(pathname.replace(/\/+$/, "") || "/");

      if (matched) {
        const query = Object.fromEntries(url.searchParams.entries());
        const reqCtx = { ...query };
        if (baseCtx && typeof baseCtx === "object") {
          Object.assign(reqCtx, baseCtx);
        }

        let result;
        try {
          result = await renderRoute(state, matched.route, reqCtx);
        } catch (err) {
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Render error: " + (err?.message || err));
          }
          return;
        }

        await ingestRequest(result);
        const html = injectHotReload(result.html, lastBuildTime);
        send(req, res, Buffer.from(html, "utf-8"), "text/html; charset=utf-8");
        return;
      }

      const rel = pathname.replace(/^\/+/, "");

      // 2) Virtual scoped CSS.
      if (rel && scopedCss.has(rel)) {
        send(
          req,
          res,
          Buffer.from(scopedCss.get(rel), "utf-8"),
          "text/css; charset=utf-8"
        );
        return;
      }

      // 3) Runtime chunks from the store.
      if (/^run-[A-Za-z0-9._-]+\.js$/.test(rel)) {
        let content = null;
        try {
          content = await runtimeStore.get(rel);
        } catch {
          content = null;
        }
        if (content != null) {
          send(
            req,
            res,
            Buffer.from(content, "utf-8"),
            "text/javascript; charset=utf-8"
          );
          return;
        }
      }

      // 4) Source assets from disk (`/<src-relative>`), then external static.
      if (rel && !rel.toLowerCase().endsWith(".chjs")) {
        const srcCandidates = [rel];
        if (!/\.[a-z0-9]+$/i.test(rel)) srcCandidates.push(rel + ".html");

        for (const candidateRel of srcCandidates) {
          const candidate = safeCandidate(paths.srcDir, candidateRel);
          if (!candidate) continue;
          if (path.resolve(candidate) === path.resolve(paths.appFile)) continue;

          try {
            if (await serveFile(req, res, candidate)) return;
            const stat = await fs.promises.stat(candidate);
            if (stat.isDirectory()) {
              const index = safeCandidate(
                paths.srcDir,
                candidateRel + "/index.html"
              );
              if (index && (await serveFile(req, res, index))) return;
            }
          } catch {
            // Try the next candidate.
          }
        }

        if (!isInside(paths.staticDir, paths.srcDir)) {
          const staticCandidate = safeCandidate(paths.staticDir, rel);
          if (staticCandidate) {
            try {
              if (await serveFile(req, res, staticCandidate)) return;
            } catch {
              // Fall through to 404.
            }
          }
        }
      }

      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>404 Not Found</h1><p>The requested resource was not found on this server.</p>"
        );
      }
    } catch (err) {
      console.error("[chocola/dev] handler error:", err);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal server error");
      }
    }
  }

  flushConfigWarnings(rootDir);

  const server = http.createServer(handler);

  server.on("close", () => {
    clearTimeout(compileTimeout);
    try {
      watcher.close();
    } catch {
      // Watcher already closed.
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, resolve);
  });

  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : listenPort;

  console.log(
    "Live server running at",
    chalk.hex("#68C4EE").underline(`http://${listenHost}:${actualPort}/`)
  );

  if (open) {
    const url =
      listenHost === "0.0.0.0"
        ? `http://localhost:${actualPort}`
        : `http://${listenHost}:${actualPort}`;
    try {
      const openPkg = await import("open");
      openPkg.default(url);
    } catch {
      const { exec } = await import("child_process");
      const cmd =
        process.platform === "win32"
          ? `start ${url}`
          : process.platform === "darwin"
            ? `open ${url}`
            : `xdg-open ${url}`;
      exec(cmd);
    }
  }

  server.app = {
    get state() {
      return state;
    },
    paths,
    config,
    get graphs() {
      return new Map(
        [...(state ? state.pages : [])].map(([route, page]) => [route, page.graph])
      );
    },
    get routes() {
      return state ? state.pages : new Map();
    },
    get hashMap() {
      return hashMap;
    },
    get warmResults() {
      return warmResults;
    },
    runtimeStore,
    get lastBuildTime() {
      return lastBuildTime;
    },
    get scopedCss() {
      return scopedCss;
    },
  };

  return server;
}

/**
 * An intrinsic object that contains the Chocola Dev methods.
 */
export const dev = {
  /**
 *  Initializes your Chocola dev server using a root directory.
 * 
 * ```js
 * import { app } from "chocola/compiler"
 import path from "path";
 import { fileURLToPath } from "url";
  
 const __filename = fileURLToPath(import.meta.url);
 const __dirname = path.dirname(__filename);
  
 app.build(__dirname);
 ```
 * @example
 * @param {PathLike} __rootdir the directory where your Chocola App is
 */
  async server(__rootdir) {
    return serve(__rootdir);
  },
};
