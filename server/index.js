import http from "http";
import path from "path";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import zlib from "zlib";
import { pathToFileURL } from "url";

// Chocola imports
import { deterministicHash } from "chocola/compiler/utils.js";

import chalk from "../chalk.js";
import { loadConfig, resolvePaths } from "../config.js";
import {
  buildSiteState,
  renderRoute,
  RuntimeStore,
  writeHashMap,
} from "../routing.js";

import {
  getConfig,
  isMissingConfigFile,
  queueConfigWarning,
  flushConfigWarnings,
} from "../utils.js";

const warnedServerPort = new Set();
const warnedServerHostname = new Set();

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

function generateETag(buf) {
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 32);
  return `W/"${hash}"`;
}

function parseCookies(cookieHeader = "") {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function acceptsGzip(req) {
  const ae = req.headers["accept-encoding"] || "";
  return ae.includes("gzip");
}

function shouldCompress(mime) {
  return /^(text\/|application\/(javascript|json|xml|manifest\+json))/.test(mime);
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

async function loadMiddleware(rootDir, middlewarePath) {
  if (!middlewarePath) return [];
  const resolved = path.isAbsolute(middlewarePath)
    ? middlewarePath
    : path.join(rootDir, middlewarePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`[chocola/server] middleware file not found: ${resolved}`);
  }
  const imported = await import(pathToFileURL(resolved).href);
  const raw = imported.default ?? imported;
  if (Array.isArray(raw)) return raw.filter((fn) => typeof fn === "function");
  if (typeof raw === "function") return [raw];
  if (raw && typeof raw === "object") {
    const fns = Object.values(raw).filter((v) => typeof v === "function");
    if (fns.length) return fns;
  }
  return [];
}

function sendNotModified(res) {
  res.writeHead(304);
  res.end();
}

function serveBuffer(req, res, buffer, contentType, etag, mtime) {
  const headers = {
    "Content-Type": contentType,
    "ETag": etag,
    "Last-Modified": mtime.toUTCString(),
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Content-Length": buffer.length,
  };

  const inm = req.headers["if-none-match"];
  if (inm && inm === etag) {
    sendNotModified(res);
    return;
  }

  const ims = req.headers["if-modified-since"];
  if (ims) {
    const imsTime = new Date(ims).getTime();
    if (!Number.isNaN(imsTime) && mtime.getTime() <= imsTime) {
      sendNotModified(res);
      return;
    }
  }

  const doGzip = acceptsGzip(req) && shouldCompress(contentType);
  if (doGzip) {
    const gz = zlib.gzipSync(buffer);
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    headers["Content-Length"] = gz.length;
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(gz);
    return;
  }

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(buffer);
}

function normalizeRootDir(arg, opts) {
  if (typeof arg === "object" && arg !== null && !opts) {
    // createServer({ rootDir }) form
    const o = arg;
    const rd = o.rootDir || o.root || o.dir || process.cwd();
    return { rootDir: rd, opts: o };
  }
  if (typeof arg === "string") {
    return { rootDir: arg, opts: opts || {} };
  }
  return { rootDir: String(arg), opts: opts || {} };
}

async function serveFile(req, res, filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return false;
  const buffer = await fs.readFile(filePath);
  serveBuffer(
    req,
    res,
    buffer,
    getMimeType(filePath),
    generateETag(buffer),
    stat.mtime
  );
  return true;
}

export async function createHandler(rootDirArg, optsArg) {
  const { rootDir, opts } = normalizeRootDir(rootDirArg, optsArg);
  const root = path.resolve(rootDir);
  const silent = opts.silent ?? false;

  const fullConfig = await getConfig(root, { silent });

  let config = opts.config;
  let paths = opts.paths;
  if (!config) {
    ({ config, paths } = await loadConfig(root, {
      silent,
      overrides: opts.overrides || {},
    }));
  } else if (!paths) {
    paths = resolvePaths(root, config);
  }

  const state = await buildSiteState(root, { config, paths });
  const routeTable = state.routeTable;

  const runtimeStore = new RuntimeStore(root);
  await runtimeStore.clear();

  const middlewarePath = opts.middleware ?? fullConfig.server?.middleware ?? null;
  const middlewares = await loadMiddleware(root, middlewarePath);

  // pathname -> { buffer, etag, mtime, type }
  const virtualFiles = new Map();

  function rememberVirtual(name, content, type) {
    const key = "/" + String(name).replace(/^\/+/, "");
    const buffer = Buffer.from(content, "utf-8");
    virtualFiles.set(key, {
      buffer,
      etag: generateETag(buffer),
      mtime: new Date(),
      type: type || getMimeType(key),
    });
    return key;
  }

  async function ingest(result) {
    let scoped = null;
    if (result.styles) {
      scoped = `sc-${deterministicHash(result.styles, 6)}.css`;
      rememberVirtual(scoped, result.styles, "text/css; charset=utf-8");
    }

    const runtime = result.runtime || [];
    for (const chunk of runtime) {
      rememberVirtual(chunk.name, chunk.content, "text/javascript; charset=utf-8");
    }
    if (runtime.length > 0) {
      await runtimeStore.add(runtime);
    }

    return { scoped, runtime };
  }

  // Warm every route with empty ctx so invariant chunks, scoped CSS, and the
  // hash map exist before the first request.
  const warmResults = new Map();
  const hashMap = {};

  for (const route of [...state.pages.keys()].sort()) {
    try {
      const result = await renderRoute(state, route, {});
      warmResults.set(route, result);
      Object.assign(hashMap, result.hashMap);
      await ingest(result);
    } catch (err) {
      console.warn(
        "[chocola/server] initial render failed:",
        err?.message || err
      );
    }
  }

  await writeHashMap(state, hashMap);
  state.hashMap = hashMap;

  async function handler(req, res) {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url, `http://${host}`);
      let pathname = decodeURIComponent(url.pathname);

      // Normalize duplicate slashes; keep trailing slash for route lookup.
      pathname = pathname.replace(/\/+/g, "/");

      const query = Object.fromEntries(url.searchParams.entries());
      const cookies = parseCookies(req.headers.cookie || "");

      // 1) SSR route?
      const matched = routeTable.get(pathname) || routeTable.get(pathname.replace(/\/+$/, "") || "/");

      if (matched) {
        const page = matched;
        const route = page.route;

        let ctx = { ...query };
        if (opts.ctx && typeof opts.ctx === "object") Object.assign(ctx, opts.ctx);

        for (const mw of middlewares) {
          let result;
          try {
            if (mw.length >= 2) {
              result = await mw(req, res);
            } else {
              result = await mw({
                req,
                res,
                params: {},
                query,
                cookies,
                headers: req.headers,
                url,
                pathname,
                route,
                page,
                searchParams: url.searchParams,
              });
            }
          } catch (err) {
            console.error("[chocola/server] middleware error:", err);
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal middleware error");
            }
            return;
          }
          if (res.writableEnded || res.headersSent) return;
          if (
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            !(result instanceof Buffer)
          ) {
            Object.assign(ctx, result);
          }
        }

        let result;
        try {
          result = await renderRoute(state, route, ctx);
        } catch (err) {
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Render error: " + (err?.message || err));
          }
          return;
        }

        Object.assign(hashMap, result.hashMap);
        await ingest(result);

        const htmlBuf = Buffer.from(result.html, "utf-8");
        serveBuffer(
          req,
          res,
          htmlBuf,
          "text/html; charset=utf-8",
          generateETag(htmlBuf),
          new Date()
        );
        return;
      }

      // 2) Runtime CSS/JS generated by the SSR pipeline.
      if (virtualFiles.has(pathname)) {
        const entry = virtualFiles.get(pathname);
        serveBuffer(req, res, entry.buffer, entry.type, entry.etag, entry.mtime);
        return;
      }

      // 3) Source assets: /<src-relative> from srcDir.
      const rel = pathname.replace(/^\/+/, "");

      if (rel && !rel.toLowerCase().endsWith(".chjs")) {
        const srcCandidates = [rel];
        if (!/\.[a-z0-9]+$/i.test(rel)) srcCandidates.push(rel + ".html");

        for (const candidateRel of srcCandidates) {
          const candidate = safeCandidate(paths.srcDir, candidateRel);
          if (!candidate) continue;
          if (path.resolve(candidate) === path.resolve(paths.appFile)) continue;

          try {
            if (await serveFile(req, res, candidate)) return;
            const stat = await fs.stat(candidate);
            if (stat.isDirectory()) {
              const index = safeCandidate(paths.srcDir, candidateRel + "/index.html");
              if (index && (await serveFile(req, res, index))) return;
            }
          } catch {
            // Try the next candidate.
          }
        }

        // 4) Static files from a staticDir configured outside srcDir.
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
          "<h1>404 Not Found</h1><p>The requested resource was not found.</p>"
        );
      }
    } catch (err) {
      console.error("[chocola/server] handler error:", err);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  flushConfigWarnings(root);

  const graphs = new Map();
  for (const [route, page] of state.pages) {
    graphs.set(route, page.graph);
  }

  // Attach helpers for testing / introspection.
  handler.state = state;
  handler.paths = state.paths;
  handler.routes = state.pages;
  handler.graphs = graphs;
  handler.routeTable = routeTable;
  handler.hashMap = hashMap;
  handler.virtualFiles = virtualFiles;
  handler.runtimeStore = runtimeStore;
  handler.warmResults = warmResults;

  return handler;
}

// Alias per lead: createServer({ rootDir }) returns bare http handler
export const createServer = createHandler;
export const createServerRenderer = createHandler; // future ssr escape hatch alias

export async function serve(rootDirArg, optsArg) {
  const { rootDir } = normalizeRootDir(rootDirArg, optsArg);
  const silent = optsArg?.silent ?? false;
  const fullConfig = await getConfig(rootDir, { silent });
  const serverCfg = fullConfig.server || {};
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const hasEnvPort = Number.isFinite(envPort) && envPort >= 1 && envPort <= 65535;
  const port =
    optsArg?.port ?? (hasEnvPort ? envPort : serverCfg.port ?? 8080);
  const hasHostFlag = optsArg?.hostname != null || optsArg?.host != null;
  const hasHostConfig = serverCfg.hostname != null || serverCfg.host != null;
  const hostname = hasHostFlag
    ? optsArg?.hostname ?? optsArg?.host
    : hasEnvPort && !hasHostConfig
      ? "0.0.0.0"
      : serverCfg.hostname ?? serverCfg.host ?? "localhost";

  if (!silent) {
    if (isMissingConfigFile(fullConfig)) {
      // top-level already warned
    } else if (fullConfig.server != null) {
      if (
        serverCfg.port == null &&
        optsArg?.port == null &&
        !warnedServerPort.has(rootDir)
      ) {
        warnedServerPort.add(rootDir);
        queueConfigWarning(
          rootDir,
          chalk.bold.yellow("WARNING!"),
          `server.port not defined in chocola.config.json file: using default ${port} server.port.`
        );
      }
      if (
        serverCfg.hostname == null &&
        serverCfg.host == null &&
        optsArg?.hostname == null &&
        optsArg?.host == null &&
        !warnedServerHostname.has(rootDir)
      ) {
        warnedServerHostname.add(rootDir);
        queueConfigWarning(
          rootDir,
          chalk.bold.yellow("WARNING!"),
          `server.hostname not defined in chocola.config.json file: using default ${hostname} server.hostname.`
        );
      }
    }
  }

  const handler = await createHandler(rootDir, optsArg);

  flushConfigWarnings(rootDir);

  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      console.log(`Chocola server running at http://${hostname}:${port}/`);
      resolve();
    });
  });
  return server;
}

// also export default for convenience
export default { createHandler, createServer, serve };
