import { promises as fs } from "fs";
import path from "path";

// Chocola imports
import { loadConfig, resolvePaths } from "chocola/compiler/config.js";
import { getComponents } from "chocola/compiler/pipeline.js";
import { renderPage } from "chocola/compiler/render.js";
import { ChocolaModule } from "chocola/compiler/module-graph.js";
import { compileExpr, extractPropsDefaults } from "chocola/parser/index.js";

/**
 * Layout routing conventions (SvelteKit-style):
 * - `src/app.html` is the general layout (full HTML document). It must contain
 *   exactly one `<chocolakit:body>` tag where the page renders and at most one
 *   `<chocolakit:head>` tag inside `<head>` where the page's head fragment
 *   renders (e.g. per-page `<title>`/`<meta>`). `<app>` is not used in the
 *   layout.
 * - `src/pages/` holds pages as extended components (same SFC format as
 *   `lib/` components: optional `<script>` props, `<template>` content,
 *   `<style>` scoped CSS, including `$runtime`). A plain HTML fragment also
 *   works and is treated as the template. Pages may contain one top-level
 *   `<chocolakit:head>` tag with head-only elements (`<title>`, `<meta>`,
 *   `<link>`); it is moved into the layout head at render time. All remaining
 *   page content renders at `<chocolakit:body>`.
 * - `src/pages/index.html` renders `/`, `src/pages/about.html` renders
 *   `/about`, `src/pages/blog/post.html` renders `/blog/post`.
 *
 * Legacy mode (no `src/app.html` and no `src/pages/`): every `.html` file
 * directly under `src/` (excluding `lib/` and `static/`) is a standalone
 * full-document page, as before.
 */

export const PAGES_DIR = "pages";
export const APP_FILE = "app.html";
export const BODY_SLOT_TAG = "chocolakit:body";
export const HEAD_SLOT_TAG = "chocolakit:head";

function slotPattern(tag) {
  return new RegExp(`<${tag}(\\s[^<>]*)?\\s*(\\/>|>([\\s\\S]*?)<\\/${tag}\\s*>)`, "gi");
}

function slotRegex() {
  return slotPattern(BODY_SLOT_TAG);
}

function headSlotRegex() {
  return slotPattern(HEAD_SLOT_TAG);
}

/**
 * Convert a pages-relative posix path (e.g. "about.html", "blog/index.html")
 * into a route (e.g. "/about", "/blog", "/").
 */
export function filePathToRoute(pagesRelPosix) {
  const normalized = pagesRelPosix.split("\\").join("/").replace(/^\/+/, "");
  const noExt = normalized.replace(/\.html$/i, "");
  if (noExt === "index") return "/";
  if (noExt.endsWith("/index")) {
    const base = noExt.slice(0, -"/index".length);
    return "/" + base;
  }
  return "/" + noExt;
}

/**
 * Output relative path (inside outDir) for a page.
 * In layout mode this is pages-relative; in legacy mode it is src-relative.
 * e.g. "about.html" -> "about.html", "blog/index.html" -> "blog/index.html"
 */
export function srcRelToOutputRel(relPosix) {
  return relPosix.split("\\").join("/").replace(/^\/+/, "");
}

/**
 * URL aliases served for a given page.
 * Keeps backwards compat with single-page aliases ("/", "/index", "/index.html").
 */
export function routeAliases(route, outRelPosix) {
  const aliases = new Set();
  const outRel = outRelPosix.split("\\").join("/");
  aliases.add(route);
  if (route !== "/") {
    aliases.add(route + "/");
    aliases.add(route + ".html");
  } else {
    aliases.add("/index");
    aliases.add("/index.html");
  }
  // File-path style URL always works: /blog/index.html, /about.html
  aliases.add("/" + outRel);
  // For index pages, also serve /about.html as alias of /about/index.html
  if (outRel.endsWith("/index.html")) {
    const withoutIndex = "/" + outRel.slice(0, -"/index.html".length) + ".html";
    aliases.add(withoutIndex);
  }
  return [...aliases];
}

/**
 * Deterministic synthetic component name for a route, e.g.
 * "/" -> "chocolakitpageindex.html", "/blog/post" -> "chocolakitpageblogpost.html".
 * Alphanumeric-only so generated CSR class names stay valid identifiers.
 */
export function pageComponentName(route) {
  const slug = route === "/" ? "index" : route.slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `chocolakitpage${slug || "index"}.html`;
}

export function pageComponentTag(compName) {
  const base = compName.replace(/\.html$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Normalize a page source into component SFC shape ({script,template,style}
 * parseable by chocola's component pipeline). Sources that already contain a
 * <template> are returned as-is; anything else is treated as the template,
 * preserving any top-level <script>/<style> blocks.
 */
export function toComponentSFC(source) {
  if (/<template(?=[\s>])/i.test(source)) return source;
  const scripts = [...source.matchAll(/<script(?=[\s>])[^>]*>[\s\S]*?<\/script\s*>/gi)]
    .map((m) => m[0])
    .join("\n");
  const styles = [...source.matchAll(/<style(?=[\s>])[^>]*>[\s\S]*?<\/style\s*>/gi)]
    .map((m) => m[0])
    .join("\n");
  let rest = source
    .replace(/<script(?=[\s>])[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style(?=[\s>])[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const body = rest.match(/<body[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (body) {
    rest = body[1];
  } else {
    const html = rest.match(/<html[^>]*>([\s\S]*?)<\/html\s*>/i);
    if (html) rest = html[1];
  }
  rest = rest
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(html|head|body)[^>]*>/gi, "");
  return `${scripts}\n<template>${rest}</template>\n${styles}`;
}

function validateLayout(layoutSource, layoutFile) {
  const matches = [...layoutSource.matchAll(slotRegex())];
  if (matches.length === 0) {
    throw new Error(
      `[chocola/routing] ${layoutFile} must contain exactly one <${BODY_SLOT_TAG}> tag (found none). Pages render where the slot is.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `[chocola/routing] ${layoutFile} must contain exactly one <${BODY_SLOT_TAG}> tag (found ${matches.length}).`
    );
  }
  if (/<app(?=[\s>])/i.test(layoutSource)) {
    throw new Error(
      `[chocola/routing] ${layoutFile} must not contain <app>: <app> was replaced by <${BODY_SLOT_TAG}>.`
    );
  }
  const headSlots = [...layoutSource.matchAll(headSlotRegex())];
  if (headSlots.length > 1) {
    throw new Error(
      `[chocola/routing] ${layoutFile} must contain at most one <${HEAD_SLOT_TAG}> tag (found ${headSlots.length}).`
    );
  }
}

/**
 * Inject the page component tag into the layout at the body slot.
 * Slot attributes are forwarded onto the page tag (they become page props).
 */
export function injectPageIntoLayout(layoutSource, tag) {
  return layoutSource.replace(slotRegex(), (_, attrs) => `<app><${tag}${attrs || ""}></${tag}></app>`);
}

const HEAD_ALLOWED_TAGS = new Set(["title", "meta", "link", "base", "style", "noscript"]);

/**
 * Extract the page's head fragment (top-level `<chocolakit:head>` content)
 * and the remaining body SFC. Returns { head, sfc }.
 */
export function splitPageHead(source) {
  const sfc = /<template(?=[\s>])/i.test(source) ? source : toComponentSFC(source);
  const matches = [...sfc.matchAll(headSlotRegex())];
  if (matches.length > 1) {
    throw new Error(
      `[chocola/routing] Pages must contain at most one top-level <${HEAD_SLOT_TAG}> tag (found ${matches.length}).`
    );
  }
  // Nested-slot check: the head tag must sit at depth 0 of the page template
  // (script/style sources may legitimately contain such strings, so only
  // template markup is scanned).
  const withoutStyles = sfc.replace(/<style(?=[\s>])[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const templateBody =
    withoutStyles.match(/<template(?=[\s>])[^>]*>([\s\S]*?)<\/template\s*>/i)?.[1] ?? withoutStyles;
  const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  const depthAt = (prefix) => {
    let depth = 0;
    const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)[^<>]*>/g;
    let tagMatch;
    while ((tagMatch = tagRe.exec(prefix)) !== null) {
      const full = tagMatch[0];
      if (full.startsWith("<!--")) continue;
      if (full[1] === "/") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (full.endsWith("/>") || VOID_ELEMENTS.has(tagMatch[1].toLowerCase())) continue;
      depth++;
    }
    return depth;
  };
  for (const match of matches) {
    const idx = templateBody.indexOf(match[0]);
    if (idx !== -1 && depthAt(templateBody.slice(0, idx)) > 0) {
      throw new Error(
        `[chocola/routing] <${HEAD_SLOT_TAG}> must be a top-level page tag (found nested inside another element).`
      );
    }
  }
  if (!matches.length) return { head: null, sfc };
  const head = matches[0][3] ?? "";
  const rest = sfc.replace(headSlotRegex(), "");
  for (const tagMatch of head.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g)) {
    const tag = tagMatch[1].toLowerCase();
    if (!HEAD_ALLOWED_TAGS.has(tag)) {
      throw new Error(
        `[chocola/routing] <${HEAD_SLOT_TAG}> only supports ${[...HEAD_ALLOWED_TAGS].map((t) => `<${t}>`).join(", ")} (found <${tagMatch[1]}>).`
      );
    }
  }
  return { head, sfc: rest };
}

/**
 * Build the per-request page ctx: component prop defaults, `<script>`
 * top-level values that the matcher can resolve statically, then global ctx.
 * Values unrelated to the head are harmless because renderPage re-merges
 * the same keys. Attribute interpolation inside the page head uses the
 * same `{expr}` syntax as components.
 */
function resolvePageCtx(pageSource, ctx) {
  const merged = { ...(ctx || {}) };
  const scriptMatch = pageSource.match(/<script(?=[\s>])[^>]*>([\s\S]*?)<\/script\s*>/i);
  const script = scriptMatch ? scriptMatch[1] : "";
  const proxy = new Proxy(merged, { has() { return true; }, get(t, k) { return t[k]; } });
  for (const { name, defaultValue } of extractPropsDefaults(script)) {
    if (defaultValue !== undefined && !(name in merged)) {
      try {
        merged[name] = compileExpr(defaultValue, false)();
      } catch {
        merged[name] = defaultValue;
      }
    }
  }
  return { merged, proxy };
}

function interpolateHead(head, pageSource, ctx) {
  if (!head) return "";
  const { merged, proxy } = resolvePageCtx(pageSource, ctx);
  return head.replace(/\{([^}]+)\}/g, (_, expr) => {
    try {
      const value = compileExpr(expr.trim(), true)(proxy);
      return value == null ? "" : String(value);
    } catch {
      return "";
    }
  }).trim();
}

/**
 * Render the page head fragment into the layout head at the head slot.
 * Pages without a head fragment leave the layout head untouched.
 */
export function injectHeadIntoLayout(layoutSource, pageSource, ctx = {}) {
  const { head } = splitPageHead(pageSource);
  const fragment = interpolateHead(head, pageSource, ctx);
  if (!headSlotRegex().test(layoutSource)) {
    if (head) {
      console.warn(
        `[chocola/routing] Page defines <${HEAD_SLOT_TAG}> but the layout has no <${HEAD_SLOT_TAG}> slot: head content ignored.`
      );
    }
    return layoutSource;
  }
  return layoutSource.replace(headSlotRegex(), () => fragment);
}

function isExcludedDir(name) {
  return name.startsWith(".") || name === "node_modules";
}

function isExcludedPageFile(basename) {
  if (basename.startsWith(".") || basename.startsWith("_")) return true;
  return false;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkHtmlFiles(dir, { libAbs, staticAbs } = {}) {
  const out = [];
  const isInside = (abs, excl) => {
    if (!excl) return false;
    const a = path.resolve(abs);
    const e = path.resolve(excl);
    return a === e || a.startsWith(e + path.sep);
  };
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        if (entry.name.startsWith("_")) continue;
        // Skip lib dir and static dir wherever they appear under src
        if (isInside(abs, libAbs)) continue;
        if (isInside(abs, staticAbs)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        if (!entry.name.toLowerCase().endsWith(".html")) continue;
        if (isExcludedPageFile(entry.name)) continue;
        if (isInside(abs, libAbs)) continue;
        if (isInside(abs, staticAbs)) continue;
        out.push(abs);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

function sortByRoute(a, b) {
  return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
}

/**
 * Discover pages under srcDir.
 * Returns { mode, pages, layoutFile } where mode is "layout" or "legacy"
 * and pages is [{ srcRel, outRel, filePath, route }] sorted by route.
 */
export async function discoverPages(rootDir, { overrides } = {}) {
  const config = overrides
    ? await loadConfig(rootDir, { silent: true, overrides })
    : await loadConfig(rootDir);
  const paths = resolvePaths(rootDir, config);
  return discoverPagesInSrc(paths.src, paths);
}

export async function discoverPagesInSrc(srcAbs, paths) {
  const pagesAbs = path.join(srcAbs, PAGES_DIR);
  const appAbs = path.join(srcAbs, APP_FILE);
  const hasApp = await pathExists(appAbs);
  const inPages = (await pathExists(pagesAbs)) ? await walkHtmlFiles(pagesAbs, {}) : [];

  if (hasApp || inPages.length > 0) {
    if (!hasApp) {
      throw new Error(
        `[chocola/routing] Layout mode detected (${PAGES_DIR}/ holds pages) but ${APP_FILE} is missing: create src/${APP_FILE} with exactly one <${BODY_SLOT_TAG}> tag.`
      );
    }
    if (!inPages.length) {
      throw new Error(
        `[chocola/routing] No pages found in ${pagesAbs}. Add at least ${PAGES_DIR}/index.html (rendered as /).`
      );
    }
    const pages = inPages.map((abs) => {
      const pagesRel = path.relative(pagesAbs, abs).split(path.sep).join("/");
      const srcRel = path.relative(srcAbs, abs).split(path.sep).join("/");
      return { srcRel, outRel: pagesRel, filePath: abs, route: filePathToRoute(pagesRel) };
    });
    pages.sort(sortByRoute);
    return { mode: "layout", pages, layoutFile: appAbs };
  }

  // Legacy mode: standalone full-document pages directly under src/
  const libAbs = paths?.components ? path.resolve(paths.components) : null;
  const staticAbs = paths?.src ? path.join(path.resolve(paths.src), "static") : null;
  if (!(await pathExists(srcAbs))) {
    return { mode: "legacy", pages: [], layoutFile: null };
  }
  const files = await walkHtmlFiles(srcAbs, { libAbs, staticAbs });
  const pages = files.map((abs) => {
    const srcRel = path.relative(srcAbs, abs).split(path.sep).join("/");
    return { srcRel, outRel: srcRel, filePath: abs, route: filePathToRoute(srcRel) };
  });
  pages.sort(sortByRoute);
  return { mode: "legacy", pages, layoutFile: null };
}

async function getFileMtime(filePath) {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function loadComponentsSafe(componentsAbs) {
  try {
    return await getComponents(componentsAbs);
  } catch {
    return { loadedComponents: new Map(), originalNames: new Map(), componentsLib: [], emptyComps: [] };
  }
}

/**
 * Build a multipage graph. Shape is a superset of chocola's ModuleGraph
 * so existing single-page code (renderPage with graph.page) keeps working:
 * - mode: "layout" | "legacy"
 * - pages: Map<route, ChocolaModule> (module.compName set in layout mode)
 * - page: root ("/") page or first page (backwards compat)
 * - layoutSource/layoutFile in layout mode
 * - loadedComponents / originalComponentNames shared across pages
 *   (in layout mode every page is also registered as a synthetic component)
 */
export async function buildMultipageGraph(rootDir, { overrides } = {}) {
  const config = overrides
    ? await loadConfig(rootDir, { silent: true, overrides })
    : await loadConfig(rootDir);
  const paths = resolvePaths(rootDir, config);

  const found = await loadComponentsSafe(paths.components);
  const loadedComponents = found.loadedComponents || new Map();
  const originalNames = found.originalNames || new Map();

  const { mode, pages: discovered, layoutFile } = await discoverPagesInSrc(paths.src, paths);
  if (!discovered.length) {
    throw new Error(
      `[chocola/routing] No pages found in ${paths.src}. Add at least src/index.html (legacy mode) or src/${PAGES_DIR}/index.html with src/${APP_FILE} (layout mode). HTML files under ${config.libDir}/ and static/ are not treated as pages.`
    );
  }

  // Detect duplicate routes (e.g. about.html + about/index.html)
  const byRoute = new Map();
  for (const d of discovered) {
    if (byRoute.has(d.route)) {
      const prev = byRoute.get(d.route);
      throw new Error(
        `[chocola/routing] Duplicate route ${d.route}: ${prev.srcRel} and ${d.srcRel} map to the same URL. Rename or remove one.`
      );
    }
    byRoute.set(d.route, d);
  }

  let layoutSource = null;
  if (mode === "layout") {
    layoutSource = await fs.readFile(layoutFile, "utf-8");
    validateLayout(layoutSource, layoutFile);
  }

  const pages = new Map();
  const modules = new Map();
  const components = new Map();

  for (const [compName, source] of loadedComponents) {
    const mod = new ChocolaModule({
      id: path.posix.join(config.libDir, compName),
      kind: "component",
      sourcePath: path.join(paths.components, originalNames.get(compName) || compName),
      source,
      mtimeMs: null,
    });
    mod.deps = new Set();
    modules.set(mod.id, mod);
    components.set(compName, mod);
  }

  for (const d of discovered) {
    const source = await fs.readFile(d.filePath, "utf-8");
    let compName = null;
    if (mode === "layout") {
      compName = pageComponentName(d.route);
      if (loadedComponents.has(compName)) {
        throw new Error(
          `[chocola/routing] Page ${d.srcRel} collides with an existing component (${compName}). Rename the component.`
        );
      }
      if ([...pages.values()].some((p) => p.compName === compName)) {
        throw new Error(
          `[chocola/routing] Duplicate page component for route ${d.route}. Routes must differ by more than punctuation/case.`
        );
      }
      // Validate the head fragment eagerly so invalid pages fail at build/startup.
      const { sfc } = splitPageHead(source);
      loadedComponents.set(compName, sfc);
      originalNames.set(compName, d.srcRel);
    }
    const mod = new ChocolaModule({
      id: d.srcRel,
      kind: "page",
      sourcePath: d.filePath,
      source,
      mtimeMs: await getFileMtime(d.filePath),
    });
    mod.deps = new Set();
    mod.route = d.route;
    mod.srcRel = d.srcRel;
    mod.outRel = d.outRel;
    mod.compName = compName;
    pages.set(d.route, mod);
    modules.set(d.srcRel, mod);
  }

  const graph = {
    rootDir,
    config,
    paths,
    modules,
    components,
    loadedComponents,
    originalComponentNames: originalNames,
    pages,
    page: pages.get("/") || [...pages.values()][0],
    mode,
    layoutSource,
    layoutFile,
  };
  return graph;
}

/**
 * Build SSR route table: Map<urlPath, pageModule>.
 * Includes clean URLs, trailing-slash and .html aliases.
 */
export function buildRouteTable(graph) {
  const table = new Map();
  const pages = graph.pages || (graph.page ? new Map([["/", graph.page]]) : new Map());
  for (const [route, page] of pages) {
    const outRel = page.outRel || page.srcRel || page.id || "";
    for (const alias of routeAliases(route, outRel)) {
      if (!table.has(alias)) table.set(alias, page);
    }
  }
  // Backwards compat: single-page graphs without .pages
  if (graph.page && !graph.pages) {
    table.set("/", graph.page);
    table.set("/index.html", graph.page);
    table.set("/index", graph.page);
  }
  return table;
}

export function normalizePathname(pathname) {
  let p = decodeURIComponent(pathname).replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/**
 * Match a pathname against a route table (or graph).
 * Returns { page, route } or null.
 */
export function matchRoute(tableOrGraph, pathname) {
  const table = tableOrGraph instanceof Map ? tableOrGraph : buildRouteTable(tableOrGraph);
  const normalized = normalizePathname(pathname);
  let page = table.get(pathname) || table.get(normalized);
  if (page) {
    return { page, route: page.route || normalized };
  }
  // Try with/without trailing slash (table already has aliases, this is a safety net)
  if (normalized.endsWith("/") && normalized.length > 1) {
    page = table.get(normalized.slice(0, -1));
    if (page) return { page, route: page.route || normalized };
  } else {
    page = table.get(normalized + "/");
    if (page) return { page, route: page.route || normalized };
  }
  return null;
}

function absolutizeGeneratedAssets(html) {
  return html
    .replace(/href="\.\/(css-|sc-)/g, 'href="/$1')
    .replace(/src="\.\/(js-|run-)/g, 'src="/$1');
}

/**
 * Render a single route. routeOrPathname can be a route ("/about")
 * or a URL pathname ("/about/", "/about.html").
 * In layout mode the page component renders inside app.html at
 * <chocolakit:body> and the page's <chocolakit:head> fragment (if any)
 * renders at the layout's <chocolakit:head> slot; in legacy mode the page
 * document renders as-is.
 */
export async function renderRoute(graph, routeOrPathname, ctx = {}) {
  const table = buildRouteTable(graph);
  const matched = matchRoute(table, routeOrPathname);
  if (!matched) {
    throw new Error(`[chocola/routing] No route found for ${routeOrPathname}`);
  }
  const { page } = matched;
  let view = graph;
  if (graph.mode === "layout") {
    if (!graph.layoutSource) {
      throw new Error("[chocola/routing] Layout mode graph is missing its layout source.");
    }
    const tag = pageComponentTag(page.compName);
    const withHead = injectHeadIntoLayout(graph.layoutSource, page.source, ctx);
    const synthetic = injectPageIntoLayout(withHead, tag);
    const pageModule = new ChocolaModule({
      id: page.srcRel,
      kind: "page",
      sourcePath: page.sourcePath,
      source: synthetic,
      mtimeMs: page.mtimeMs,
    });
    // Shallow view (no graph.page mutation, safe under concurrent requests)
    view = { ...graph, page: pageModule };
  } else {
    view = { ...graph, page };
  }
  const result = await renderPage(view, ctx);
  return {
    ...result,
    html: absolutizeGeneratedAssets(result.html),
    page,
    route: page.route,
  };
}

/**
 * Emit all routes to outDir.
 * Layout mode preserves pages/ structure minus the prefix:
 * pages/index.html -> dist/index.html, pages/blog/post.html -> dist/blog/post.html.
 * Legacy mode preserves src structure: src/about.html -> dist/about.html.
 */
export async function emitMultipage(graph, { ctx, ctxPerRoute } = {}) {
  const outDir = graph.paths.outDir;
  if (graph.config.emptyOutDir) {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });
  } else {
    await fs.mkdir(outDir, { recursive: true });
  }

  const seenFiles = new Map(); // path -> content
  const seenCopies = new Map(); // `${from}->${to}` -> op
  const mergedHashMap = {};
  const results = new Map();

  const routes = [...graph.pages.keys()].sort();
  for (const route of routes) {
    const page = graph.pages.get(route);
    const routeCtx = { ...(ctx || {}), ...((ctxPerRoute && ctxPerRoute[route]) || {}) };
    const result = await renderRoute(graph, route, routeCtx);
    results.set(route, result);
    Object.assign(mergedHashMap, result.hashMap || {});
    for (const file of result.files) {
      if (!seenFiles.has(file.path)) seenFiles.set(file.path, file.content);
    }
    for (const copy of result.copies) {
      const key = `${copy.from}->${copy.to}`;
      if (!seenCopies.has(key)) seenCopies.set(key, copy);
    }
    const outRel = srcRelToOutputRel(page.outRel || page.srcRel || page.id);
    const outAbs = path.join(outDir, outRel);
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    await fs.writeFile(outAbs, result.html);
  }

  for (const [rel, content] of seenFiles) {
    const abs = path.join(outDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  for (const copy of seenCopies.values()) {
    if (copy.recursive) {
      await fs.cp(copy.from, copy.to, { recursive: true, force: true });
    } else {
      await fs.mkdir(path.dirname(copy.to), { recursive: true });
      try {
        await fs.copyFile(copy.from, copy.to);
      } catch {
        // Missing asset (e.g. optional icon): skip, per-page render already succeeded
      }
    }
  }

  const chocolaDir = path.join(graph.rootDir, ".chocola");
  await fs.mkdir(chocolaDir, { recursive: true });
  await fs.writeFile(path.join(chocolaDir, "hashes.json"), JSON.stringify(mergedHashMap, null, 2) + "\n");

  return {
    results,
    files: [...seenFiles.entries()].map(([rel, content]) => ({ path: rel, content })),
    copies: [...seenCopies.values()],
    hashMap: mergedHashMap,
  };
}

/**
 * Compile a rootDir (multipage-aware replacement for chocola's compile()).
 */
export default async function compileMultipage(rootDir, { overrides } = {}) {
  const graph = await buildMultipageGraph(rootDir, { overrides });
  return emitMultipage(graph);
}
