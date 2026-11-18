import { promises as fs } from "fs";
import path from "path";

// Chocola imports
import { buildModuleGraph, render } from "chocola/compiler/index.js";
import { deterministicHash } from "chocola/compiler/utils.js";
import { compileExpr } from "chocola/parser/index.js";

import { loadConfig, resolvePaths } from "./config.js";

/**
 * Routing conventions:
 * - `src/pages/**\/*.chjs` are page entries. `pages/index.chjs` renders `/`.
 * - `src/app.html` is the required document shell (loaded in a later step).
 * - Pages may contain one top-level `<chocolakit:head>` block with head-only
 *   elements. Kit extracts it before core sees the source.
 * - Core only receives `.chjs` files, so Kit mirrors `src/` under
 *   `.chocola/graph/` and removes page directives from that mirror.
 */

export const PAGES_DIR = "pages";
export const APP_FILE = "app.html";
export const BODY_SLOT_TAG = "chocolakit:body";
export const HEAD_SLOT_TAG = "chocolakit:head";

const CHJS_EXTENSION = ".chjs";
const HTML_EXTENSION = ".html";

const warnedHeadSlots = new WeakSet();
const warnedImportRewrites = new WeakMap();

const HEAD_ALLOWED_TAGS = new Set([
  "title",
  "meta",
  "link",
  "base",
  "style",
  "noscript",
]);

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function stripLeadingSlashes(value) {
  return value.replace(/^\/+/, "");
}

function isInside(abs, base) {
  if (!base) return false;
  const a = path.resolve(abs);
  const b = path.resolve(base);
  return a === b || a.startsWith(b + path.sep);
}

function joinPosix(...parts) {
  return path.posix.join(
    ...parts.flatMap((part) => String(part).split("\\").join("/").split("/").filter(Boolean))
  );
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a pages-relative posix path (e.g. "about.chjs", "blog/index.chjs")
 * into a route (e.g. "/about", "/blog", "/").
 */
export function filePathToRoute(pagesRelPosix) {
  const normalized = stripLeadingSlashes(
    String(pagesRelPosix).split("\\").join("/")
  );
  const noExt = normalized.replace(/\.chjs$/i, "");
  if (noExt === "index") return "/";
  if (noExt.endsWith("/index")) {
    return "/" + noExt.slice(0, -"/index".length);
  }
  return "/" + noExt;
}

/**
 * Output relative path (inside outDir) for a page.
 * Accepts either a pages-relative path or a src-relative one, strips the
 * pages directory when present, and maps `.chjs` to `.html`.
 */
export function srcRelToOutputRel(relPosix, pagesDir = PAGES_DIR) {
  let rel = String(relPosix).split("\\").join("/");
  let prefix = String(pagesDir).split("\\").join("/");
  rel = stripLeadingSlashes(rel).replace(/\/+$/, "");
  prefix = stripLeadingSlashes(prefix).replace(/\/+$/, "");

  if (prefix && rel === prefix) {
    rel = "";
  } else if (prefix && rel.startsWith(prefix + "/")) {
    rel = rel.slice(prefix.length + 1);
  }

  return stripLeadingSlashes(rel).replace(/\.chjs$/i, ".html");
}

/**
 * URL aliases served for a given page.
 * Keeps backwards compat with single-page aliases ("/", "/index", "/index.html").
 */
export function routeAliases(route, outRelPosix) {
  const aliases = new Set();
  const outRel = String(outRelPosix).split("\\").join("/");
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

function isCommentStart(source, index) {
  return source.startsWith("<!--", index);
}

/**
 * Read a tag starting at `index` (which must point at `<`).
 * Returns { type, rawName, lowerName, selfClosing, start, end }.
 */
function readTag(source, index) {
  if (isCommentStart(source, index)) {
    const close = source.indexOf("-->", index + 4);
    return {
      type: "comment",
      rawName: "",
      lowerName: "",
      selfClosing: true,
      start: index,
      end: close === -1 ? source.length : close + 3,
    };
  }

  const next = source[index + 1];
  if (!next || !/[a-zA-Z/!?]/.test(next)) {
    return {
      type: "text",
      rawName: "",
      lowerName: "",
      selfClosing: true,
      start: index,
      end: index + 1,
    };
  }

  let cursor = index + 1;
  let type = "start";
  if (source[cursor] === "/") {
    type = "end";
    cursor++;
  }

  const nameStart = cursor;
  while (cursor < source.length && /[a-zA-Z0-9:._-]/.test(source[cursor])) {
    cursor++;
  }
  const rawName = source.slice(nameStart, cursor);

  let quote = null;
  for (; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      cursor++;
      break;
    }
  }

  const raw = source.slice(index, cursor);
  return {
    type: rawName ? type : "other",
    rawName,
    lowerName: rawName.toLowerCase(),
    selfClosing: /\/\s*>$/.test(raw),
    start: index,
    end: cursor,
  };
}

function findBlockClose(source, from, lowerName) {
  let cursor = from;
  while (cursor < source.length) {
    const index = source.indexOf("<", cursor);
    if (index === -1) return null;
    const tag = readTag(source, index);
    if (tag.type === "end" && tag.lowerName === lowerName) {
      return { contentEnd: index, end: tag.end };
    }
    cursor = tag.end;
  }
  return null;
}

function scanTags(source, { skipBlocks = new Set() } = {}) {
  const tags = [];
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf("<", cursor);
    if (index === -1) break;
    const tag = readTag(source, index);
    if (tag.type === "comment" || tag.type === "text" || tag.type === "other") {
      cursor = tag.end;
      continue;
    }
    tags.push(tag);
    if (
      tag.type === "start" &&
      !tag.selfClosing &&
      skipBlocks.has(tag.lowerName)
    ) {
      const close = findBlockClose(source, tag.end, tag.lowerName);
      cursor = close ? close.end : tag.end;
      continue;
    }
    cursor = tag.end;
  }
  return tags;
}

function validateHeadFragment(headSource, filePath) {
  for (const tag of scanTags(headSource, {
    skipBlocks: new Set(["style", "noscript"]),
  })) {
    if (tag.type !== "start") continue;
    if (!HEAD_ALLOWED_TAGS.has(tag.lowerName)) {
      throw new Error(
        `[chocola/routing] ${filePath}: <${HEAD_SLOT_TAG}> only supports ${[
          ...HEAD_ALLOWED_TAGS,
        ]
          .map((tagName) => `<${tagName}>`)
          .join(", ")} (found <${tag.rawName}>).`
      );
    }
  }
}

function rejectKitDirectives(source, filePath) {
  for (const tag of scanTags(source, {
    skipBlocks: new Set(["script", "style", "noscript"]),
  })) {
    if (!tag.lowerName.startsWith("chocolakit:")) continue;
    throw new Error(
      `[chocola/routing] ${filePath}: <${tag.rawName}> is only allowed in page entries.`
    );
  }
}

function rejectAppTag(source, filePath) {
  for (const tag of scanTags(source, {
    skipBlocks: new Set(["script", "style", "noscript"]),
  })) {
    if (tag.type === "start" && tag.lowerName === "app") {
      throw new Error(
        `[chocola/routing] ${filePath}: <app> is no longer supported. Pages render directly into <${BODY_SLOT_TAG}> in ${APP_FILE}.`
      );
    }
  }
}

/**
 * Extract a page's top-level `<chocolakit:head>` block and return the cleaned
 * page source that core is allowed to see.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {{ source: string, headSource: string|null }}
 */
export function extractPageDirectives(source, filePath) {
  const label = filePath || "<page>";
  let cursor = 0;
  let templateDepth = 0;
  let templateCount = 0;
  let templateUnclosed = false;
  let elementDepth = 0;
  let head = null;
  let headOpen = false;

  while (cursor < source.length) {
    const index = source.indexOf("<", cursor);
    if (index === -1) break;
    const tag = readTag(source, index);

    if (tag.type === "comment" || tag.type === "text" || tag.type === "other") {
      cursor = tag.end;
      continue;
    }

    if (
      tag.type === "start" &&
      (tag.lowerName === "script" || tag.lowerName === "style")
    ) {
      const close = findBlockClose(source, tag.end, tag.lowerName);
      cursor = close ? close.end : tag.end;
      continue;
    }

    if (tag.type === "start" && tag.lowerName === "template") {
      if (templateDepth === 0) templateCount++;
      if (tag.selfClosing) {
        if (templateDepth === 0) templateUnclosed = false;
      } else {
        templateDepth++;
        templateUnclosed = true;
      }
      cursor = tag.end;
      continue;
    }

    if (tag.type === "end" && tag.lowerName === "template") {
      if (templateDepth > 0) {
        templateDepth--;
        if (templateDepth === 0) templateUnclosed = false;
      }
      cursor = tag.end;
      continue;
    }

    if (tag.type === "start" && tag.lowerName === "app") {
      rejectAppTag(source, label);
    }

    if (tag.lowerName.startsWith("chocolakit:")) {
      if (tag.lowerName !== HEAD_SLOT_TAG) {
        throw new Error(
          `[chocola/routing] ${label}: <${tag.rawName}> is not a supported page directive. Only <${HEAD_SLOT_TAG}> is allowed.`
        );
      }

      if (tag.type === "start") {
        if (templateDepth > 0) {
          throw new Error(
            `[chocola/routing] ${label}: <${HEAD_SLOT_TAG}> must be a top-level page tag, not nested inside <template>.`
          );
        }
        if (elementDepth > 0) {
          throw new Error(
            `[chocola/routing] ${label}: <${HEAD_SLOT_TAG}> must be a top-level page tag, not nested inside another element.`
          );
        }
        if (headOpen || head) {
          throw new Error(
            `[chocola/routing] ${label}: pages may contain at most one top-level <${HEAD_SLOT_TAG}> block.`
          );
        }
        headOpen = !tag.selfClosing;
        head = {
          start: index,
          contentStart: tag.end,
          contentEnd: tag.selfClosing ? tag.end : null,
          end: tag.selfClosing ? tag.end : null,
        };
      } else if (tag.type === "end") {
        if (!headOpen || !head) {
          throw new Error(
            `[chocola/routing] ${label}: unexpected </${HEAD_SLOT_TAG}> without a matching opening tag.`
          );
        }
        headOpen = false;
        head.contentEnd = index;
        head.end = tag.end;
      }
      cursor = tag.end;
      continue;
    }

    if (templateDepth === 0) {
      if (tag.type === "start") {
        if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.lowerName)) {
          elementDepth++;
        }
      } else if (tag.type === "end" && elementDepth > 0) {
        elementDepth--;
      }
    }

    cursor = tag.end;
  }

  if (templateCount === 0) {
    throw new Error(
      `[chocola/routing] ${label}: page entries must contain exactly one <template> section.`
    );
  }
  if (templateCount > 1) {
    throw new Error(
      `[chocola/routing] ${label}: page entries must contain exactly one <template> section (found ${templateCount}).`
    );
  }
  if (templateUnclosed) {
    throw new Error(`[chocola/routing] ${label}: unclosed <template> section.`);
  }
  if (headOpen || (head && head.end === null)) {
    throw new Error(
      `[chocola/routing] ${label}: unclosed <${HEAD_SLOT_TAG}> block.`
    );
  }

  if (!head) {
    return { source, headSource: null };
  }

  const headSource = source.slice(head.contentStart, head.contentEnd);
  validateHeadFragment(headSource, label);

  return {
    source: source.slice(0, head.start) + source.slice(head.end),
    headSource,
  };
}

function collectSlotTags(source, tagName) {
  const slots = [];

  for (const tag of scanTags(source, {
    skipBlocks: new Set(["script", "style"]),
  })) {
    if (tag.type !== "start" || tag.lowerName !== tagName) continue;

    if (tag.selfClosing) {
      slots.push({
        start: tag.start,
        end: tag.end,
        selfClosing: true,
      });
      continue;
    }

    const close = findBlockClose(source, tag.end, tagName);
    slots.push({
      start: tag.start,
      end: close ? close.end : null,
      selfClosing: false,
    });
  }

  return slots;
}

function findOpeningTag(source, tagName) {
  for (const tag of scanTags(source, {
    skipBlocks: new Set(["script", "style"]),
  })) {
    if (tag.type === "start" && tag.lowerName === tagName) return tag;
  }
  return null;
}

function findClosingTag(source, tagName) {
  for (const tag of scanTags(source, {
    skipBlocks: new Set(["script", "style"]),
  })) {
    if (tag.type === "end" && tag.lowerName === tagName) return tag;
  }
  return null;
}

function replaceSlot(html, tagName, replacement, label) {
  const slots = collectSlotTags(html, tagName);
  if (slots.length !== 1) {
    throw new Error(
      `[chocola/routing] ${label}: expected exactly one <${tagName}> slot (found ${slots.length}).`
    );
  }
  if (slots[0].end === null) {
    throw new Error(
      `[chocola/routing] ${label}: unclosed <${tagName}> slot.`
    );
  }
  return html.slice(0, slots[0].start) + replacement + html.slice(slots[0].end);
}

function insertBeforeClosingTag(html, tagName, content) {
  if (!content) return html;
  const close = findClosingTag(html, tagName);
  if (!close) return html;
  return html.slice(0, close.start) + content + html.slice(close.start);
}

async function loadShell(paths) {
  const file = paths.appFile;
  let source;

  try {
    source = await fs.readFile(file, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        `[chocola/routing] Missing document shell at ${file}. Create it with exactly one <${BODY_SLOT_TAG}>, an optional <${HEAD_SLOT_TAG}> inside <head>, and closing </head>/</body> tags.`
      );
    }
    throw new Error(
      `[chocola/routing] Cannot read document shell at ${file}: ${err && err.message ? err.message : err}`
    );
  }

  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  for (const tag of scanTags(source, {
    skipBlocks: new Set(["script", "style"]),
  })) {
    if (tag.type === "start" && tag.lowerName === "app") {
      throw new Error(
        `[chocola/routing] ${file}: <app> is no longer supported in ${APP_FILE}. Render pages directly into <${BODY_SLOT_TAG}>.`
      );
    }
  }

  const bodySlots = collectSlotTags(source, BODY_SLOT_TAG);
  if (bodySlots.length !== 1) {
    throw new Error(
      `[chocola/routing] ${file}: document shell must contain exactly one <${BODY_SLOT_TAG}> (found ${
        bodySlots.length === 0 ? "none" : bodySlots.length
      }).`
    );
  }
  if (bodySlots[0].end === null) {
    throw new Error(
      `[chocola/routing] ${file}: unclosed <${BODY_SLOT_TAG}> slot.`
    );
  }

  const headSlots = collectSlotTags(source, HEAD_SLOT_TAG);
  if (headSlots.length > 1) {
    throw new Error(
      `[chocola/routing] ${file}: document shell must contain at most one <${HEAD_SLOT_TAG}> (found ${headSlots.length}).`
    );
  }
  if (headSlots.length === 1 && headSlots[0].end === null) {
    throw new Error(
      `[chocola/routing] ${file}: unclosed <${HEAD_SLOT_TAG}> slot.`
    );
  }

  const headClose = findClosingTag(source, "head");
  if (!headClose) {
    throw new Error(
      `[chocola/routing] ${file}: document shell must contain a closing </head>.`
    );
  }

  const bodyClose = findClosingTag(source, "body");
  if (!bodyClose) {
    throw new Error(
      `[chocola/routing] ${file}: document shell must contain a closing </body>.`
    );
  }

  if (headSlots.length === 1) {
    const headOpen = findOpeningTag(source, "head");
    if (
      !headOpen ||
      headSlots[0].start < headOpen.end ||
      headSlots[0].start > headClose.start
    ) {
      throw new Error(
        `[chocola/routing] ${file}: <${HEAD_SLOT_TAG}> must be inside <head>.`
      );
    }
  }

  return {
    source,
    file,
    headSlot: headSlots.length === 1,
    bodySlot: true,
  };
}

function resolveHeadContext(page, ctx) {
  const merged = { ...(ctx || {}) };
  const props =
    page && page.graph && page.graph.root && page.graph.root.compProps
      ? page.graph.root.compProps
      : [];

  for (const prop of props) {
    if (!prop || !prop.name || prop.defaultValue === undefined) continue;
    if (prop.name in merged) continue;

    if (typeof prop.defaultValue === "string") {
      try {
        merged[prop.name] = compileExpr(prop.defaultValue, false)();
      } catch {
        merged[prop.name] = prop.defaultValue;
      }
    } else {
      merged[prop.name] = prop.defaultValue;
    }
  }

  return new Proxy(merged, {
    has() {
      return true;
    },
    get(target, key) {
      if (key in target) return target[key];
      return globalThis[key];
    },
  });
}

function interpolateHead(head, page, ctx) {
  if (!head) return "";

  const context = resolveHeadContext(page, ctx);
  const protectedBlocks = [];
  const guarded = head.replace(
    /<!--[\s\S]*?-->|<(style|noscript)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi,
    (match) => {
      const token = `\u0000${protectedBlocks.length}\u0000`;
      protectedBlocks.push(match);
      return token;
    }
  );

  const interpolated = guarded.replace(/\{([^}]+)\}/g, (_, expression) => {
    try {
      const value = compileExpr(expression.trim(), true)(context);
      return value == null ? "" : String(value);
    } catch {
      return "";
    }
  });

  return interpolated
    .replace(/\u0000(\d+)\u0000/g, (_, index) => protectedBlocks[Number(index)])
    .trim();
}

/**
 * Assemble a complete HTML document from the required shell, the page head,
 * the core render result, and the runtime chunks.
 *
 * @param {{ state: object, page: object, ctx?: object, result?: object, runtime?: Array<{name: string}>|Array<string>, head?: string }} options
 * @returns {string}
 */
export function assembleDocument({
  state,
  page,
  ctx = {},
  result = {},
  runtime,
  head,
} = {}) {
  if (!state || !state.shell) {
    throw new Error(
      "[chocola/routing] assembleDocument requires a state with a loaded document shell."
    );
  }

  let html = state.shell.source;
  if (!/^\uFEFF?\s*<!doctype\b/i.test(html)) {
    html = "<!doctype html>\n" + html;
  }

  const headFragment =
    typeof head === "string"
      ? head
      : interpolateHead(page && page.headSource, page, ctx);

  if (state.shell.headSlot) {
    html = replaceSlot(html, HEAD_SLOT_TAG, headFragment, state.shell.file);
  } else if (headFragment) {
    html = insertBeforeClosingTag(html, "head", headFragment + "\n");
    if (!warnedHeadSlots.has(state)) {
      warnedHeadSlots.add(state);
      console.warn(
        `[chocola/routing] ${state.shell.file} has no <${HEAD_SLOT_TAG}> slot; page head content is appended before </head>.`
      );
    }
  }

  const styles = result && result.styles;
  if (styles) {
    const stylesFile = `sc-${deterministicHash(styles, 6)}.css`;
    html = insertBeforeClosingTag(
      html,
      "head",
      `<link rel="stylesheet" href="/${stylesFile}">\n`
    );
  }

  const bodyHtml = result && result.html != null ? result.html : "";
  html = replaceSlot(html, BODY_SLOT_TAG, bodyHtml, state.shell.file);

  const chunks = Array.isArray(runtime)
    ? runtime
    : Array.isArray(result && result.runtime)
      ? result.runtime
      : [];
  const runtimeTags = chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : chunk && chunk.name))
    .filter(Boolean)
    .map(
      (name) =>
        `<script type="module" src="/${String(name).replace(/^\/+/, "")}"></script>`
    )
    .join("\n");

  if (runtimeTags) {
    html = insertBeforeClosingTag(html, "body", runtimeTags + "\n");
  }

  return html;
}

async function walkFiles(
  dir,
  { skipAbs = null, includeUnderscored = true, includeHiddenFiles = true } = {}
) {
  const files = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (isInside(abs, skipAbs)) continue;

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (!includeUnderscored && entry.name.startsWith("_")) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        if (!includeUnderscored && entry.name.startsWith("_")) continue;
        if (!includeHiddenFiles && entry.name.startsWith(".")) continue;
        files.push(abs);
      }
    }
  }

  await walk(dir);
  return files.sort();
}

async function discoverPageFiles(paths) {
  const pagesDir = paths.pagesDir;
  const chjs = [];
  const html = [];

  if (!(await pathExists(pagesDir))) {
    return { chjs, html };
  }

  const files = await walkFiles(pagesDir, {
    includeUnderscored: false,
    includeHiddenFiles: false,
  });
  for (const file of files) {
    const name = file.toLowerCase();
    if (name.endsWith(CHJS_EXTENSION)) chjs.push(file);
    else if (name.endsWith(HTML_EXTENSION)) html.push(file);
  }
  return { chjs, html };
}

/**
 * Discover `.chjs` page entries under the configured pages directory.
 *
 * @param {string} rootDir
 * @param {{ config?: object, paths?: object }} [options]
 * @returns {Promise<Array<{ route: string, srcRel: string, entry: string, outRel: string, filePath: string, source: string, headSource: string|null }>>}
 */
export async function discoverPages(
  rootDir,
  { overrides = {}, config, paths } = {}
) {
  const root = path.resolve(rootDir);
  let resolvedConfig = config;
  let resolvedPaths = paths;

  if (!resolvedConfig) {
    ({ config: resolvedConfig, paths: resolvedPaths } = await loadConfig(root, {
      silent: true,
      overrides,
    }));
  } else if (!resolvedPaths) {
    resolvedPaths = resolvePaths(root, resolvedConfig);
  }

  const found = await discoverPageFiles(resolvedPaths);
  const pagesRelToSrc =
    toPosix(path.relative(resolvedPaths.srcDir, resolvedPaths.pagesDir)) || ".";
  const indexPath = joinPosix(pagesRelToSrc, "index.chjs");
  const appPath = joinPosix(
    toPosix(path.relative(resolvedPaths.srcDir, resolvedPaths.appFile)) ||
      APP_FILE
  );

  if (found.html.length > 0) {
    throw new Error(
      `[chocola/routing] ${found.html[0]} uses .html, but pages must be .chjs files with explicit component imports. Rename it to .chjs and replace layout tags with imports.`
    );
  }

  if (found.chjs.length === 0) {
    const legacyIndex = path.join(resolvedPaths.srcDir, "index.html");
    if (await pathExists(legacyIndex)) {
      throw new Error(
        `[chocola/routing] ${legacyIndex} uses the removed legacy single-page mode. Move it to ${indexPath} and add ${appPath}.`
      );
    }
    throw new Error(
      `[chocola/routing] No pages found in ${resolvedPaths.pagesDir}. Add at least ${indexPath} (rendered as /).`
    );
  }

  const pages = [];
  const byRoute = new Map();

  for (const filePath of found.chjs) {
    const pagesRel = toPosix(path.relative(resolvedPaths.pagesDir, filePath));
    const srcRel = toPosix(path.relative(resolvedPaths.srcDir, filePath));
    const route = filePathToRoute(pagesRel);
    const outRel = srcRelToOutputRel(pagesRel);
    const rawSource = await fs.readFile(filePath, "utf-8");
    const { source, headSource } = extractPageDirectives(rawSource, filePath);

    if (byRoute.has(route)) {
      throw new Error(
        `[chocola/routing] Duplicate route ${route}: ${byRoute.get(route).srcRel} and ${srcRel} map to the same URL. Rename or remove one.`
      );
    }

    const page = {
      route,
      srcRel,
      entry: srcRel,
      outRel,
      filePath,
      source,
      headSource,
    };
    byRoute.set(route, page);
    pages.push(page);
  }

  if (!byRoute.has("/")) {
    throw new Error(
      `[chocola/routing] Missing ${indexPath}: the pages root must define the "/" route.`
    );
  }

  pages.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  return pages;
}

async function materializeGraphMirror(rootDir, paths, pagesBySrcRel) {
  const graphRoot = path.join(rootDir, ".chocola", "graph");
  await fs.rm(graphRoot, { recursive: true, force: true });
  await fs.mkdir(graphRoot, { recursive: true });

  const files = await walkFiles(paths.srcDir, {
    skipAbs: paths.staticDir,
    includeUnderscored: true,
  });

  for (const filePath of files) {
    if (!filePath.toLowerCase().endsWith(CHJS_EXTENSION)) continue;

    const srcRel = toPosix(path.relative(paths.srcDir, filePath));
    const dest = path.join(graphRoot, ...srcRel.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });

    const page = pagesBySrcRel.get(srcRel);
    if (page) {
      await fs.writeFile(dest, page.source);
      continue;
    }

    const source = await fs.readFile(filePath, "utf-8");
    rejectKitDirectives(source, filePath);
    await fs.writeFile(dest, source);
  }

  return graphRoot;
}

function chunkOriginsForGraph(graph) {
  const origins = new Map();
  for (const id of graph.modules.keys()) {
    origins.set(`run-${deterministicHash("module:" + id, 6)}.js`, id);
  }
  return origins;
}

/**
 * Build the Kit-owned site state: discover page entries, materialize the
 * preprocessed `.chocola/graph` mirror, and build one core module graph per
 * page.
 *
 * @param {string} rootDir
 * @param {{ overrides?: object, config?: object, paths?: object }} [options]
 * @returns {Promise<object>}
 */
export async function buildSiteState(
  rootDir,
  { overrides = {}, config, paths } = {}
) {
  const root = path.resolve(rootDir);
  let resolvedConfig = config;
  let resolvedPaths = paths;

  if (!resolvedConfig) {
    ({ config: resolvedConfig, paths: resolvedPaths } = await loadConfig(root, {
      silent: true,
      overrides,
    }));
  } else if (!resolvedPaths) {
    resolvedPaths = resolvePaths(root, resolvedConfig);
  }

  const discovered = await discoverPages(root, {
    config: resolvedConfig,
    paths: resolvedPaths,
  });
  const shell = await loadShell(resolvedPaths);

  const pagesBySrcRel = new Map(discovered.map((page) => [page.srcRel, page]));
  const graphRoot = await materializeGraphMirror(
    root,
    resolvedPaths,
    pagesBySrcRel
  );

  for (const page of discovered) {
    const graph = await buildModuleGraph(graphRoot, {
      entry: page.entry,
      config: resolvedConfig,
    });
    page.graph = graph;
    page.chunkOrigins = chunkOriginsForGraph(graph);
  }

  const pages = new Map(discovered.map((page) => [page.route, page]));
  const state = {
    rootDir: root,
    graphRoot,
    config: resolvedConfig,
    paths: resolvedPaths,
    shell,
    pages,
    routeTable: buildRouteTable({ pages }),
    hashMap: {},
  };

  return state;
}

/**
 * Build SSR route table: Map<urlPath, page>.
 * Includes clean URLs, trailing-slash and .html aliases.
 */
export function buildRouteTable(stateOrPages) {
  const table = new Map();
  const pages =
    stateOrPages && stateOrPages.pages instanceof Map
      ? stateOrPages.pages
      : stateOrPages instanceof Map
        ? stateOrPages
        : new Map();

  for (const [route, page] of pages) {
    const outRel =
      page.outRel || srcRelToOutputRel(page.entry || page.srcRel || "");
    for (const alias of routeAliases(route, outRel)) {
      if (!table.has(alias)) table.set(alias, page);
    }
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
 * Match a pathname against a route table (or state).
 * Returns { page, route } or null.
 */
export function matchRoute(tableOrState, pathname) {
  const table =
    tableOrState instanceof Map
      ? tableOrState
      : tableOrState && tableOrState.routeTable instanceof Map
        ? tableOrState.routeTable
        : buildRouteTable(tableOrState);
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

function warnImportOnce(state, key, message) {
  let warned = warnedImportRewrites.get(state);
  if (!warned) {
    warned = new Set();
    warnedImportRewrites.set(state, warned);
  }
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function splitSpecifierSuffix(specifier) {
  const index = specifier.search(/[?#]/);
  return index === -1
    ? [specifier, ""]
    : [specifier.slice(0, index), specifier.slice(index)];
}

/**
 * Rewrite one relative non-`.chjs` specifier into a src-relative URL.
 * Returns `null` when the specifier must stay unchanged.
 */
function rewriteImportSpecifier(state, moduleId, specifier) {
  const value = String(specifier);
  if (!value) return null;
  // Absolute URLs and non-relative specifiers stay untouched.
  if (value.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  if (!value.startsWith("./") && !value.startsWith("../")) {
    warnImportOnce(
      state,
      `bare:${moduleId}:${value}`,
      `[chocola/routing] ${moduleId}: bare import "${value}" is left unchanged. Use a relative file path or an import map.`
    );
    return null;
  }

  // Core's generated inter-chunk imports already point at flat run-*.js URLs.
  if (/^\.\/run-[a-z]{6}\.js(?:[?#].*)?$/.test(value)) return null;

  const [pathPart, suffix] = splitSpecifierSuffix(value);
  if (!pathPart) return null;

  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(moduleId), pathPart)
  );

  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved)
  ) {
    warnImportOnce(
      state,
      `escape:${moduleId}:${value}`,
      `[chocola/routing] ${moduleId}: import "${value}" escapes srcDir and is left unchanged.`
    );
    return null;
  }

  return `/${resolved}${suffix}`;
}

function replaceImportSource(raw, source, next) {
  const index = raw.indexOf(source);
  if (index === -1) return raw;
  const before = raw[index - 1];
  const after = raw[index + source.length];
  if ((before !== '"' && before !== "'") || after !== before) return raw;
  return raw.slice(0, index) + next + raw.slice(index + source.length);
}

function moduleImportRewrites(state, page, moduleId) {
  if (!page.importRewrites) page.importRewrites = new Map();
  if (page.importRewrites.has(moduleId)) {
    return page.importRewrites.get(moduleId);
  }

  const rewrites = new Map();
  const module = page.graph.modules.get(moduleId);

  for (const imp of (module && module.imports) || []) {
    if (!imp || !imp.source || !imp.raw) continue;
    if (String(imp.source).toLowerCase().endsWith(CHJS_EXTENSION)) continue;

    const next = rewriteImportSpecifier(state, moduleId, imp.source);
    if (next === null) continue;

    const raw = imp.raw.trim();
    const rewritten = replaceImportSource(raw, String(imp.source), next);
    if (rewritten !== raw) rewrites.set(raw, rewritten);
  }

  page.importRewrites.set(moduleId, rewrites);
  return rewrites;
}

/**
 * Rewrite relative non-`.chjs` imports inside one runtime chunk.
 * Base and hydration chunks have no module origin and are left untouched.
 */
function rewriteRuntimeChunk(state, page, chunk) {
  if (!chunk || !chunk.name || typeof chunk.content !== "string") return chunk;

  const origin =
    page.chunkOrigins && page.chunkOrigins.get(String(chunk.name));
  if (!origin) return chunk;

  const rewrites = moduleImportRewrites(state, page, origin);
  if (rewrites.size === 0) return chunk;

  let content = chunk.content;
  for (const [from, to] of rewrites) {
    if (content.includes(from)) content = content.split(from).join(to);
  }
  return { ...chunk, content };
}

const RUNTIME_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertRuntimeName(name) {
  const value = String(name);
  if (
    !RUNTIME_NAME_PATTERN.test(value) ||
    value === "." ||
    value === ".." ||
    value !== path.basename(value)
  ) {
    throw new Error(`[chocola/routing] Invalid runtime file name: ${name}`);
  }
  return value;
}

/**
 * Memory cache plus disk fallback for core runtime chunks.
 *
 * Disk lives under `<rootDir>/.chocola/runtime/` and is cleared on first use
 * (process startup) or when `clear()` is called on rebuild.
 */
export class RuntimeStore {
  constructor(rootDir, { memoryLimit = 256 } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.dir = path.join(this.rootDir, ".chocola", "runtime");
    this.memoryLimit =
      Number.isFinite(memoryLimit) && memoryLimit > 0
        ? Math.floor(memoryLimit)
        : 256;
    this.memory = new Map();
    this.names = new Set();
    this.disk = new Set();
    this.ready = null;
  }

  ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        await fs.rm(this.dir, { recursive: true, force: true });
        await fs.mkdir(this.dir, { recursive: true });
      })();
    }
    return this.ready;
  }

  remember(name, content) {
    if (this.memory.has(name)) this.memory.delete(name);
    this.memory.set(name, content);
    while (this.memory.size > this.memoryLimit) {
      const oldest = this.memory.keys().next().value;
      this.memory.delete(oldest);
    }
  }

  async add(files) {
    await this.ensureReady();
    const list = Array.isArray(files) ? files : files ? [files] : [];

    for (const file of list) {
      if (!file || !file.name) continue;
      const name = assertRuntimeName(file.name);
      const content =
        typeof file.content === "string"
          ? file.content
          : String(file.content ?? "");

      this.names.add(name);
      this.remember(name, content);

      if (!this.disk.has(name)) {
        await fs.writeFile(path.join(this.dir, name), content);
        this.disk.add(name);
      }
    }

    return list.map((file) => (file && file.name ? String(file.name) : null)).filter(Boolean);
  }

  async get(name) {
    const safeName = assertRuntimeName(name);
    if (this.memory.has(safeName)) return this.memory.get(safeName);

    await this.ensureReady();
    try {
      const content = await fs.readFile(path.join(this.dir, safeName), "utf-8");
      this.names.add(safeName);
      this.disk.add(safeName);
      this.remember(safeName, content);
      return content;
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
  }

  has(name) {
    try {
      const safeName = assertRuntimeName(name);
      return this.memory.has(safeName) || this.disk.has(safeName);
    } catch {
      return false;
    }
  }

  async writeTo(dir) {
    const target = path.resolve(dir);
    await fs.mkdir(target, { recursive: true });

    const written = [];
    for (const name of [...this.names].sort()) {
      const content = this.memory.has(name)
        ? this.memory.get(name)
        : await this.get(name);
      if (content == null) continue;
      await fs.writeFile(path.join(target, name), content);
      written.push(name);
    }
    return written;
  }

  async clear() {
    this.memory.clear();
    this.names.clear();
    this.disk.clear();
    this.ready = (async () => {
      await fs.rm(this.dir, { recursive: true, force: true });
      await fs.mkdir(this.dir, { recursive: true });
    })();
    await this.ready;
  }
}

function resolveRouteContext(ctx, ctxPerRoute, route, page) {
  const base = ctx && typeof ctx === "object" ? ctx : {};
  if (!ctxPerRoute) return { ...base };
  if (typeof ctxPerRoute === "function") {
    return { ...base, ...(ctxPerRoute(route, page) || {}) };
  }
  return { ...base, ...(ctxPerRoute[route] || {}) };
}

function sortedHashMap(hashMap) {
  const sorted = {};
  for (const key of Object.keys(hashMap || {}).sort()) {
    sorted[key] = hashMap[key];
  }
  return sorted;
}

/**
 * Persist the merged CSS hash map to `<rootDir>/.chocola/hashes.json`.
 * Keys are sorted and the file has a trailing newline.
 */
export async function writeHashMap(state, hashMap) {
  const dir = path.join(state.rootDir, ".chocola");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "hashes.json");
  await fs.writeFile(
    file,
    JSON.stringify(sortedHashMap(hashMap), null, 2) + "\n"
  );
  return file;
}

/**
 * Render one route to a complete HTML document.
 *
 * @param {object} state site state from `buildSiteState`
 * @param {string} routeOrPathname route or URL pathname
 * @param {object} [ctx] per-request context
 * @returns {Promise<{ page: object, route: string, html: string, styles: string, runtime: Array<{name:string,content:string}>, hashMap: object, head: string|null }>}
 */
export async function renderRoute(state, routeOrPathname, ctx = {}) {
  if (!state || !(state.pages instanceof Map)) {
    throw new Error(
      "[chocola/routing] renderRoute requires a site state from buildSiteState."
    );
  }

  const matched = matchRoute(state, routeOrPathname);
  if (!matched) {
    throw new Error(`[chocola/routing] No route found for ${routeOrPathname}`);
  }

  const { page, route } = matched;
  const result = await render(page.graph, ctx);
  const runtime = (result.runtime || []).map((chunk) =>
    rewriteRuntimeChunk(state, page, chunk)
  );
  const head = page.headSource
    ? interpolateHead(page.headSource, page, ctx)
    : null;

  const html = assembleDocument({
    state,
    page,
    ctx,
    result: { ...result, runtime },
    runtime,
    head: head === null ? "" : head,
  });

  return {
    page,
    route,
    html,
    styles: result.styles || "",
    runtime,
    hashMap: result.hashMap || {},
    head,
  };
}

async function collectAssetCopies(state) {
  const { srcDir, staticDir, outDir, appFile } = state.paths;
  const copies = [];
  const seen = new Set();

  const staticRel = toPosix(path.relative(srcDir, staticDir));
  if (
    staticRel &&
    !staticRel.startsWith("..") &&
    !path.isAbsolute(staticRel) &&
    (await pathExists(staticDir))
  ) {
    copies.push({
      from: staticDir,
      to: path.join(outDir, ...staticRel.split("/")),
      relative: staticRel,
      recursive: true,
    });
  }

  const files = await walkFiles(srcDir, {
    skipAbs: staticDir,
    includeUnderscored: true,
  });

  for (const file of files) {
    if (isInside(file, outDir)) continue;
    if (path.resolve(file) === path.resolve(appFile)) continue;
    if (file.toLowerCase().endsWith(CHJS_EXTENSION)) continue;

    const rel = toPosix(path.relative(srcDir, file));
    if (!rel || rel.startsWith("..") || seen.has(rel)) continue;
    seen.add(rel);
    copies.push({
      from: file,
      to: path.join(outDir, ...rel.split("/")),
      relative: rel,
    });
  }

  return copies;
}

/**
 * Emit every route, scoped stylesheet, runtime chunk, and copied asset.
 *
 * @param {object} state site state from `buildSiteState`
 * @param {{ ctx?: object, ctxPerRoute?: object|Function }} [options]
 * @returns {Promise<{ results: Map<string, object>, files: Array<{path:string,content:string}>, copies: Array<object>, hashMap: object, runtime: Array<{name:string,content:string}> }>}
 */
export async function emitSite(state, { ctx = {}, ctxPerRoute } = {}) {
  if (!state || !(state.pages instanceof Map)) {
    throw new Error(
      "[chocola/routing] emitSite requires a site state from buildSiteState."
    );
  }

  const outDir = state.paths.outDir;
  if (state.config && state.config.emptyOutDir !== false) {
    await fs.rm(outDir, { recursive: true, force: true });
  }
  await fs.mkdir(outDir, { recursive: true });

  const copies = await collectAssetCopies(state);

  // Copy author assets first so generated files always win on collision.
  for (const copy of copies) {
    if (copy.recursive) {
      await fs.cp(copy.from, copy.to, { recursive: true, force: true });
    } else {
      await fs.mkdir(path.dirname(copy.to), { recursive: true });
      await fs.copyFile(copy.from, copy.to);
    }
  }

  const results = new Map();
  const generated = new Map();
  const runtimeByName = new Map();
  const mergedHashMap = {};

  for (const route of [...state.pages.keys()].sort()) {
    const page = state.pages.get(route);
    const routeCtx = resolveRouteContext(ctx, ctxPerRoute, route, page);
    const rendered = await renderRoute(state, route, routeCtx);
    results.set(route, rendered);

    Object.assign(mergedHashMap, rendered.hashMap);

    if (rendered.styles) {
      const name = `sc-${deterministicHash(rendered.styles, 6)}.css`;
      if (!generated.has(name)) generated.set(name, rendered.styles);
    }

    for (const chunk of rendered.runtime) {
      if (!runtimeByName.has(chunk.name)) {
        runtimeByName.set(chunk.name, chunk.content);
      }
    }

    const outAbs = path.join(outDir, ...page.outRel.split("/"));
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    await fs.writeFile(outAbs, rendered.html);
  }

  for (const [name, content] of [...generated].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    await fs.writeFile(path.join(outDir, name), content);
  }

  const runtime = [...runtimeByName]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => ({ name, content }));

  for (const chunk of runtime) {
    await fs.writeFile(path.join(outDir, chunk.name), chunk.content);
    generated.set(chunk.name, chunk.content);
  }

  const hashMap = sortedHashMap(mergedHashMap);
  await writeHashMap(state, hashMap);
  state.hashMap = hashMap;

  return {
    results,
    files: [...generated]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, content]) => ({ path: filePath, content })),
    copies,
    hashMap,
    runtime,
  };
}

/**
 * Compile a site: build state and emit every route to `outDir`.
 */
export default async function compileMultipage(
  rootDir,
  { overrides = {}, config, paths } = {}
) {
  const state = await buildSiteState(rootDir, { overrides, config, paths });
  return emitSite(state);
}
