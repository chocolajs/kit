import { readFile } from "fs/promises";
import path from "path";

import chalk from "./chalk.js";
import { getConfig, warnMissingConfigSections } from "./utils.js";

const BUNDLE_DEFAULTS = {
  srcDir: "src",
  outDir: "dist",
  pagesDir: "pages",
  appFile: "app.html",
  staticDir: "static",
  emptyOutDir: true,
  treeShakeRuntime: true,
};

const DEV_DEFAULTS = { hostname: "localhost", port: 3000 };
const SERVER_DEFAULTS = { hostname: "localhost", port: 8080, middleware: null };

export const DEFAULT_CONFIG = Object.freeze({
  bundle: Object.freeze({ ...BUNDLE_DEFAULTS }),
  dev: Object.freeze({ ...DEV_DEFAULTS }),
  server: Object.freeze({ ...SERVER_DEFAULTS }),
});

const BUNDLE_KEYS = Object.keys(BUNDLE_DEFAULTS);
const TOP_LEVEL_RESERVED = new Set(["bundle", "build", "dev", "server", "libDir"]);
const warnedLibDir = new Set();

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function warnLibDir(rootDir) {
  if (warnedLibDir.has(rootDir)) return;
  warnedLibDir.add(rootDir);
  console.warn(
    chalk.bold.yellow("WARNING!"),
    "libDir is deprecated and ignored: components enter the graph only through explicit .chjs imports."
  );
}

function pickBundleOverrides(overrides) {
  const picked = {};
  for (const key of BUNDLE_KEYS) {
    if (overrides[key] !== undefined) picked[key] = overrides[key];
  }
  return picked;
}

function assignDefined(target, source) {
  if (!isObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
  return target;
}

function collectTopLevelExtras(source, target) {
  if (!isObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (!TOP_LEVEL_RESERVED.has(key) && value !== undefined) target[key] = value;
  }
}

async function readRawConfig(rootDir, { silent, customPath }) {
  if (!customPath) return getConfig(rootDir, { silent });

  const file = path.isAbsolute(customPath) ? customPath : path.resolve(rootDir, customPath);
  const raw = JSON.parse(await readFile(file, "utf-8"));
  warnMissingConfigSections(rootDir, raw, { silent });
  return raw;
}

/**
 * Resolve Kit paths against a project root.
 *
 * @param {string} rootDir
 * @param {object} [config]
 * @returns {{ rootDir: string, srcDir: string, outDir: string, pagesDir: string, appFile: string, staticDir: string }}
 */
export function resolvePaths(rootDir, config = {}) {
  const root = path.resolve(rootDir);
  const srcDir = path.resolve(root, config.srcDir ?? BUNDLE_DEFAULTS.srcDir);
  const outDir = path.resolve(root, config.outDir ?? BUNDLE_DEFAULTS.outDir);

  return {
    rootDir: root,
    srcDir,
    outDir,
    pagesDir: path.resolve(srcDir, config.pagesDir ?? BUNDLE_DEFAULTS.pagesDir),
    appFile: path.resolve(srcDir, config.appFile ?? BUNDLE_DEFAULTS.appFile),
    staticDir: path.resolve(srcDir, config.staticDir ?? BUNDLE_DEFAULTS.staticDir),
  };
}

/**
 * Load Kit configuration from `chocola.config.json` (or `customPath`) and merge
 * defaults plus CLI overrides.
 *
 * The returned `config` is flat so it can be forwarded to core:
 * `{ srcDir, outDir, pagesDir, appFile, staticDir, emptyOutDir,
 *    treeShakeRuntime, dev, server, ...unknownKeys }`.
 *
 * @param {string} rootDir
 * @param {{ silent?: boolean, customPath?: string|null, overrides?: object }} [options]
 * @returns {Promise<{ config: object, paths: object, raw: object }>}
 */
export async function loadConfig(
  rootDir,
  { silent = false, customPath = null, overrides = {} } = {}
) {
  const root = path.resolve(rootDir);
  const raw = await readRawConfig(root, { silent, customPath });

  const rawBundle = isObject(raw.bundle)
    ? raw.bundle
    : isObject(raw.build)
      ? raw.build
      : {};

  const overrideBundle = pickBundleOverrides(overrides);
  if (isObject(overrides.bundle)) {
    assignDefined(overrideBundle, overrides.bundle);
  } else if (isObject(overrides.build)) {
    assignDefined(overrideBundle, overrides.build);
  }

  const bundle = assignDefined(
    assignDefined({ ...BUNDLE_DEFAULTS }, rawBundle),
    overrideBundle
  );
  if (
    raw.libDir !== undefined ||
    rawBundle.libDir !== undefined ||
    overrides.libDir !== undefined ||
    overrideBundle.libDir !== undefined
  ) {
    warnLibDir(root);
  }
  delete bundle.libDir;

  const dev = assignDefined(
    assignDefined({ ...DEV_DEFAULTS }, isObject(raw.dev) ? raw.dev : {}),
    isObject(overrides.dev) ? overrides.dev : {}
  );
  const server = assignDefined(
    assignDefined({ ...SERVER_DEFAULTS }, isObject(raw.server) ? raw.server : {}),
    isObject(overrides.server) ? overrides.server : {}
  );

  const config = {};
  collectTopLevelExtras(raw, config);
  collectTopLevelExtras(overrides, config);
  Object.assign(config, bundle, { dev, server });

  const paths = resolvePaths(root, config);
  config.srcDir = paths.srcDir;
  config.outDir = paths.outDir;
  config.pagesDir = paths.pagesDir;
  config.appFile = paths.appFile;
  config.staticDir = paths.staticDir;

  return { config, paths, raw };
}
