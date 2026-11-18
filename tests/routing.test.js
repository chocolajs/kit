import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  discoverPages,
  buildSiteState,
  buildRouteTable,
  matchRoute,
  renderRoute,
  emitSite,
  assembleDocument,
  extractPageDirectives,
  filePathToRoute,
  routeAliases,
  RuntimeStore,
  writeHashMap,
  BODY_SLOT_TAG,
  HEAD_SLOT_TAG,
} from "../routing.js";

// Chocola imports
import { deterministicHash } from "chocola/compiler/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BASIC = path.join(__dirname, "fixtures", "basic");

const SHELL = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="/styles.css" />
  <${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}>
</head>
<body>
  <${BODY_SLOT_TAG}></${BODY_SLOT_TAG}>
</body>
</html>`;

const SHELL_WITHOUT_HEAD_SLOT = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
</head>
<body>
  <${BODY_SLOT_TAG}></${BODY_SLOT_TAG}>
</body>
</html>`;

const GREETING = `<script>
  export let name = "World";
</script>
<template>
  <div class="greeting">Hello {name}!</div>
</template>
<style>
  .greeting { color: blue; }
</style>`;

const SIMPLE_INDEX = `<template><main>Home</main></template>`;

const CONFIG = { bundle: { srcDir: "src", outDir: "dist" } };

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

async function captureWarnings(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(stripAnsi(args.join(" ")));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warns;
}

async function writePage(root, rel, source) {
  const file = path.join(root, "src", "pages", rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
}

async function writeLib(root, rel, source) {
  const file = path.join(root, "src", "lib", rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
}

async function makeApp({
  appHtml = SHELL,
  pages = { "index.chjs": SIMPLE_INDEX },
  lib = {},
  config = CONFIG,
  assets = { "styles.css": "body { background: #fafaf8; }\n" },
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-routing-"));
  const src = path.join(root, "src");
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(path.join(src, "static"), { recursive: true });

  if (config !== null) {
    await fs.writeFile(
      path.join(root, "chocola.config.json"),
      JSON.stringify(config, null, 2)
    );
  }
  if (appHtml !== null) {
    await fs.writeFile(path.join(src, "app.html"), appHtml);
  }
  for (const [rel, content] of Object.entries(assets)) {
    const file = path.join(src, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  for (const [rel, source] of Object.entries(pages)) {
    await writePage(root, rel, source);
  }
  for (const [rel, source] of Object.entries(lib)) {
    await writeLib(root, rel, source);
  }
  return root;
}

async function makeMultipageApp() {
  return makeApp({
    pages: {
      "index.chjs": `<script>
  import Greeting from "../lib/greeting.chjs";
  export let title = "Home";
</script>
<${HEAD_SLOT_TAG}><title>{title} | Site</title><meta name="description" content="Welcome {title}"></${HEAD_SLOT_TAG}>
<template><main>Home <Greeting /></main></template>`,
      "about.chjs": `<${HEAD_SLOT_TAG}><title>About | Site</title></${HEAD_SLOT_TAG}>
<template><main>About page</main></template>`,
      "blog/index.chjs": `<template><main>Blog index</main></template>`,
      "blog/post.chjs": `<template><main>Post page</main></template>`,
    },
    lib: { "greeting.chjs": GREETING },
  });
}

async function listDir(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe("routing — file paths and aliases", () => {
  test("maps .chjs page paths to clean routes", () => {
    assert.equal(filePathToRoute("index.chjs"), "/");
    assert.equal(filePathToRoute("about.chjs"), "/about");
    assert.equal(filePathToRoute("blog/index.chjs"), "/blog");
    assert.equal(filePathToRoute("blog/post.chjs"), "/blog/post");
  });

  test("routeAliases covers clean, slash, .html and index forms", () => {
    assert.deepEqual(routeAliases("/", "index.html"), ["/", "/index", "/index.html"]);
    assert.ok(routeAliases("/about", "about.html").includes("/about"));
    assert.ok(routeAliases("/about", "about.html").includes("/about/"));
    assert.ok(routeAliases("/about", "about.html").includes("/about.html"));
    assert.ok(routeAliases("/blog", "blog/index.html").includes("/blog/index.html"));
    assert.ok(routeAliases("/blog", "blog/index.html").includes("/blog.html"));
  });
});

describe("routing — page directives", () => {
  const BODY = `<template><main>Hi</main></template>`;

  test("extracts a top-level head block and removes it from core source", () => {
    const { source, headSource } = extractPageDirectives(
      `<${HEAD_SLOT_TAG}><title>Hi</title><meta name="x" content="y"></${HEAD_SLOT_TAG}>${BODY}`,
      "pages/index.chjs"
    );
    assert.equal(headSource, `<title>Hi</title><meta name="x" content="y">`);
    assert.ok(!source.includes(HEAD_SLOT_TAG));
    assert.ok(source.includes("<main>Hi</main>"));
  });

  test("returns a null head when the page has none", () => {
    const { source, headSource } = extractPageDirectives(BODY, "page");
    assert.equal(headSource, null);
    assert.equal(source, BODY);
  });

  test("rejects duplicate, nested and misplaced head blocks", () => {
    assert.throws(
      () =>
        extractPageDirectives(
          `<${HEAD_SLOT_TAG}><title>A</title></${HEAD_SLOT_TAG}><${HEAD_SLOT_TAG}><title>B</title></${HEAD_SLOT_TAG}>${BODY}`,
          "page"
        ),
      /at most one/
    );
    assert.throws(
      () =>
        extractPageDirectives(
          `<template><div><${HEAD_SLOT_TAG}><title>A</title></${HEAD_SLOT_TAG}></div></template>`,
          "page"
        ),
      /top-level page tag/
    );
    assert.throws(
      () =>
        extractPageDirectives(
          `<div><${HEAD_SLOT_TAG}><title>A</title></${HEAD_SLOT_TAG}></div>${BODY}`,
          "page"
        ),
      /nested inside another element/
    );
    assert.throws(
      () =>
        extractPageDirectives(
          `</${HEAD_SLOT_TAG}>${BODY}`,
          "page"
        ),
      /unexpected/
    );
    assert.throws(
      () =>
        extractPageDirectives(
          `<${HEAD_SLOT_TAG}><title>Hi</title>${BODY}`,
          "page"
        ),
      /unclosed <chocolakit:head>/
    );
  });

  test("rejects non-head elements inside the head block", () => {
    assert.throws(
      () =>
        extractPageDirectives(
          `<${HEAD_SLOT_TAG}><script src="x.js"></script></${HEAD_SLOT_TAG}>${BODY}`,
          "page"
        ),
      /only supports/
    );
  });

  test("rejects unknown chocolakit directives and <app>", () => {
    assert.throws(
      () =>
        extractPageDirectives(
          `<${BODY_SLOT_TAG}></${BODY_SLOT_TAG}>${BODY}`,
          "page"
        ),
      /not a supported page directive/
    );
    assert.throws(
      () => extractPageDirectives(`<app></app>${BODY}`, "page"),
      /<app> is no longer supported/
    );
  });

  test("requires exactly one template section", () => {
    assert.throws(
      () => extractPageDirectives(`<${HEAD_SLOT_TAG}><title>A</title></${HEAD_SLOT_TAG}>`, "page"),
      /exactly one <template>/
    );
    assert.throws(
      () => extractPageDirectives(BODY + BODY, "page"),
      /exactly one <template>.*found 2/
    );
    assert.throws(
      () => extractPageDirectives(`<template><main>Hi`, "page"),
      /unclosed <template>/
    );
  });
});

describe("routing — discovery", () => {
  test("migrated basic fixture maps pages/index.chjs to /", async () => {
    const pages = await discoverPages(FIXTURE_BASIC);
    assert.equal(pages.length, 1);
    const [page] = pages;
    assert.equal(page.route, "/");
    assert.equal(page.srcRel, "pages/index.chjs");
    assert.equal(page.entry, "pages/index.chjs");
    assert.equal(page.outRel, "index.html");
    assert.ok(page.headSource.includes("<title>{title}</title>"));
    assert.ok(!page.source.includes(HEAD_SLOT_TAG));
  });

  test("multipage apps map routes and outRel", async () => {
    const root = await makeMultipageApp();
    try {
      const pages = await discoverPages(root);
      assert.deepEqual(
        pages.map((page) => page.route),
        ["/", "/about", "/blog", "/blog/post"]
      );
      assert.deepEqual(
        pages.map((page) => page.outRel),
        ["index.html", "about.html", "blog/index.html", "blog/post.html"]
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("missing pages/ throws with the expected entry path", async () => {
    const root = await makeApp({ pages: {} });
    try {
      await assert.rejects(
        () => discoverPages(root),
        /No pages found in .*pages.*pages\/index\.chjs/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("legacy src/index.html throws the removed single-page error", async () => {
    const root = await makeApp({ pages: {} });
    try {
      await fs.writeFile(
        path.join(root, "src", "index.html"),
        "<html><body><app></app></body></html>"
      );
      await assert.rejects(
        () => discoverPages(root),
        /removed legacy single-page mode/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(".html pages throw instead of being auto-wrapped", async () => {
    const root = await makeApp({
      pages: { "index.chjs": SIMPLE_INDEX, "about.html": "<main>About</main>" },
    });
    try {
      await assert.rejects(
        () => discoverPages(root),
        /uses \.html, but pages must be \.chjs files/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("duplicate routes throw", async () => {
    const root = await makeApp({
      pages: {
        "index.chjs": SIMPLE_INDEX,
        "about.chjs": `<template><main>About</main></template>`,
        "about/index.chjs": `<template><main>Duplicate</main></template>`,
      },
    });
    try {
      await assert.rejects(
        () => discoverPages(root),
        /Duplicate route \/about/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("underscore files and directories are ignored", async () => {
    const root = await makeMultipageApp();
    try {
      await writePage(root, "_draft.chjs", "<template><div>draft</div></template>");
      await writePage(root, "_partials/x.chjs", "<template><div>x</div></template>");
      const pages = await discoverPages(root);
      assert.deepEqual(
        pages.map((page) => page.route),
        ["/", "/about", "/blog", "/blog/post"]
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("the pages root must define /", async () => {
    const root = await makeApp({
      pages: { "about.chjs": `<template><main>About</main></template>` },
    });
    try {
      await assert.rejects(
        () => discoverPages(root),
        /Missing .*pages\/index\.chjs/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("routing — site state", () => {
  let parent;
  let root;
  let state;

  before(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-state-"));
    root = path.join(parent, "app");
    await fs.cp(FIXTURE_BASIC, root, { recursive: true });
    state = await buildSiteState(root);
  });

  after(async () => {
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("builds one graph per page, a route table and a graph mirror", async () => {
    assert.ok(state.pages instanceof Map);
    assert.deepEqual([...state.pages.keys()], ["/"]);
    const page = state.pages.get("/");
    assert.equal(page.route, "/");
    assert.equal(page.outRel, "index.html");
    assert.equal(page.graph.root.id, "pages/index.chjs");
    assert.ok(page.graph.modules.has("lib/greeting.chjs"));
    assert.ok(!page.graph.modules.has("lib/unused.chjs"));

    assert.deepEqual(
      [...state.routeTable.keys()].sort(),
      ["/", "/index", "/index.html"]
    );

    const mirrorPage = await fs.readFile(
      path.join(state.graphRoot, "pages", "index.chjs"),
      "utf-8"
    );
    assert.ok(!mirrorPage.includes(HEAD_SLOT_TAG));
    assert.ok(mirrorPage.includes("<main>"));
    assert.ok(
      await fs
        .stat(path.join(state.graphRoot, "lib", "unused.chjs"))
        .then(() => true)
    );
    assert.ok(!page.graph.modules.has("lib/unused.chjs"));
  });

  test("one graph object per page is reused for the life of the state", async () => {
    const page = state.pages.get("/");
    const graph = page.graph;
    await renderRoute(state, "/");
    await renderRoute(state, "/", { title: "Again" });
    assert.equal(state.pages.get("/").graph, graph);
    assert.equal(state.pages.get("/").graph.root, graph.root);
  });

  test("multipage state builds distinct graphs with matching page routes", async () => {
    const multiRoot = await makeMultipageApp();
    try {
      const multi = await buildSiteState(multiRoot);
      assert.deepEqual([...multi.pages.keys()], [
        "/",
        "/about",
        "/blog",
        "/blog/post",
      ]);
      for (const [route, page] of multi.pages) {
        assert.equal(page.route, route);
        assert.equal(page.graph.entry, page.entry);
      }
      assert.notEqual(
        multi.pages.get("/").graph,
        multi.pages.get("/about").graph
      );
    } finally {
      await fs.rm(multiRoot, { recursive: true, force: true });
    }
  });

  test("a missing app.html throws with the expected path and no fallback", async () => {
    const noShell = await makeApp({ appHtml: null });
    try {
      await assert.rejects(
        () => buildSiteState(noShell),
        /Missing document shell at .*app\.html/
      );
    } finally {
      await fs.rm(noShell, { recursive: true, force: true });
    }
  });

  test("pages/index.chjs is the entry point; bundle.entry is ignored", async () => {
    const rootWithEntry = await makeApp({
      config: {
        bundle: { srcDir: "src", outDir: "dist", entry: "src/index.html" },
      },
    });
    try {
      const built = await buildSiteState(rootWithEntry);
      assert.ok(built.pages.has("/"));
      assert.equal(built.pages.get("/").entry, "pages/index.chjs");
    } finally {
      await fs.rm(rootWithEntry, { recursive: true, force: true });
    }
  });

  test("non-page .chjs modules cannot contain chocolakit directives", async () => {
    const badLib = await makeApp({
      lib: {
        "widget.chjs": `<${HEAD_SLOT_TAG}><title>No</title></${HEAD_SLOT_TAG}><template><div>no</div></template>`,
      },
    });
    try {
      await assert.rejects(
        () => buildSiteState(badLib),
        /only allowed in page entries/
      );
    } finally {
      await fs.rm(badLib, { recursive: true, force: true });
    }
  });

  test("page <app> is rejected", async () => {
    const appPage = await makeApp({
      pages: { "index.chjs": `<app></app><template><main>Hi</main></template>` },
    });
    try {
      await assert.rejects(
        () => buildSiteState(appPage),
        /<app> is no longer supported/
      );
    } finally {
      await fs.rm(appPage, { recursive: true, force: true });
    }
  });

  test("shell validation produces clear errors", async () => {
    const cases = [
      {
        name: "no body slot",
        html: `<html><head><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body></body></html>`,
        pattern: /exactly one <chocolakit:body>.*found none/,
      },
      {
        name: "two body slots",
        html: `<html><head></head><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`,
        pattern: /exactly one <chocolakit:body>.*found 2/,
      },
      {
        name: "unclosed body slot",
        html: `<html><head></head><body><${BODY_SLOT_TAG}></body></html>`,
        pattern: /unclosed <chocolakit:body> slot/,
      },
      {
        name: "two head slots",
        html: `<html><head><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`,
        pattern: /at most one <chocolakit:head>.*found 2/,
      },
      {
        name: "head slot outside head",
        html: `<html><head></head><body><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`,
        pattern: /<chocolakit:head> must be inside <head>/,
      },
      {
        name: "unclosed head slot",
        html: `<html><head><${HEAD_SLOT_TAG}></head><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`,
        pattern: /unclosed <chocolakit:head> slot/,
      },
      {
        name: "missing </head>",
        html: `<html><head><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`,
        pattern: /closing <\/head>/,
      },
      {
        name: "missing </body>",
        html: `<html><head><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></html>`,
        pattern: /closing <\/body>/,
      },
      {
        name: "<app>",
        html: `<html><head></head><body><app><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></app></body></html>`,
        pattern: /<app> is no longer supported in app\.html/,
      },
    ];

    for (const testCase of cases) {
      const shellRoot = await makeApp({ appHtml: testCase.html });
      try {
        await assert.rejects(
          () => buildSiteState(shellRoot),
          testCase.pattern,
          testCase.name
        );
      } finally {
        await fs.rm(shellRoot, { recursive: true, force: true });
      }
    }
  });
});

describe("routing — renderRoute", () => {
  let parent;
  let root;
  let state;

  before(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-render-"));
    root = path.join(parent, "app");
    await fs.cp(FIXTURE_BASIC, root, { recursive: true });
    state = await buildSiteState(root);
  });

  after(async () => {
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("assembles the page fragment into the required shell", async () => {
    const result = await renderRoute(state, "/");
    assert.match(result.html, /^<!doctype html>/i);
    assert.ok(!result.html.includes(BODY_SLOT_TAG));
    assert.ok(!result.html.includes(HEAD_SLOT_TAG));
    assert.ok(!result.html.includes("<app>"));
    assert.ok(result.html.includes("<main"));
    assert.ok(result.html.includes("Hello World!"));
    assert.ok(result.html.includes("slot content"));
    assert.match(
      result.html,
      /<div[^>]*style="display:none"[^>]*>never shown<\/div>/,
      "false conditionals render hidden"
    );

    const body = result.html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? "";
    assert.ok(body.includes("<main"), "page fragment must live in the shell body");
    assert.ok(!result.html.includes("chocolakit:"));
  });

  test("extracts, interpolates and inserts the page head", async () => {
    const defaults = await renderRoute(state, "/");
    assert.equal(
      defaults.head,
      `<title>Fixture</title>\n  <meta name="description" content="Fixture page for Fixture" />`
    );
    const head = defaults.html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    assert.ok(head.includes("<title>Fixture</title>"));
    assert.ok(head.includes('content="Fixture page for Fixture"'));

    const custom = await renderRoute(state, "/", { title: "Override" });
    assert.ok(custom.html.includes("<title>Override</title>"));
    assert.ok(custom.html.includes('content="Fixture page for Override"'));

    const body = custom.html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? "";
    assert.ok(!body.includes("<title>"), "head must not leak into the body");
  });

  test("routes without a page head report head null and add no title", async () => {
    const multiRoot = await makeMultipageApp();
    try {
      const multi = await buildSiteState(multiRoot);
      const blog = await renderRoute(multi, "/blog");
      assert.equal(blog.head, null);
      const head = blog.html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
      assert.ok(!head.includes("<title>"));
      assert.ok(blog.html.includes("Blog index"));
    } finally {
      await fs.rm(multiRoot, { recursive: true, force: true });
    }
  });

  test("multipage routes serve the correct page and head", async () => {
    const multiRoot = await makeMultipageApp();
    try {
      const multi = await buildSiteState(multiRoot);

      const home = await renderRoute(multi, "/", { title: "Alice" });
      assert.ok(home.html.includes("Home"));
      assert.ok(home.html.includes("<title>Alice | Site</title>"));
      assert.ok(home.html.includes("Hello World!"));

      const about = await renderRoute(multi, "/about");
      assert.ok(about.html.includes("About page"));
      assert.ok(about.html.includes("<title>About | Site</title>"));
      assert.ok(!about.html.includes("Alice | Site"));

      const blog = await renderRoute(multi, "/blog/");
      assert.ok(blog.html.includes("Blog index"));

      const post = await renderRoute(multi, "/blog/post.html");
      assert.ok(post.html.includes("Post page"));

      await assert.rejects(() => renderRoute(multi, "/nope"), /No route found/);
    } finally {
      await fs.rm(multiRoot, { recursive: true, force: true });
    }
  });

  test("matchRoute handles clean, trailing slash and .html aliases", async () => {
    const multiRoot = await makeMultipageApp();
    try {
      const multi = await buildSiteState(multiRoot);
      const table = buildRouteTable(multi);
      assert.ok(matchRoute(table, "/about"));
      assert.ok(matchRoute(table, "/about/"));
      assert.ok(matchRoute(table, "/about.html"));
      assert.ok(matchRoute(table, "/blog"));
      assert.ok(matchRoute(table, "/blog/index.html"));
      assert.equal(matchRoute(table, "/nope-xyz"), null);
      assert.ok(matchRoute(multi, "/about"), "state.routeTable is reused");
    } finally {
      await fs.rm(multiRoot, { recursive: true, force: true });
    }
  });

  test("shell without a head slot appends page head with one warning per state", async () => {
    const noHeadRoot = await makeApp({
      appHtml: SHELL_WITHOUT_HEAD_SLOT,
      pages: {
        "index.chjs": `<${HEAD_SLOT_TAG}><title>Page</title></${HEAD_SLOT_TAG}><template><main>Home</main></template>`,
      },
    });
    try {
      const noHeadState = await buildSiteState(noHeadRoot);
      let first;
      const warns = await captureWarnings(async () => {
        first = await renderRoute(noHeadState, "/");
        await renderRoute(noHeadState, "/");
      });
      assert.ok(first.html.includes("<title>Page</title>"));
      assert.ok(!first.html.includes(HEAD_SLOT_TAG));
      assert.equal(
        warns.filter((warning) => warning.includes(HEAD_SLOT_TAG)).length,
        1
      );
    } finally {
      await fs.rm(noHeadRoot, { recursive: true, force: true });
    }
  });

  test("scoped CSS is content-hashed and global styles stay author-managed", async () => {
    const result = await renderRoute(state, "/");
    const name = `sc-${deterministicHash(result.styles, 6)}.css`;
    assert.ok(result.html.includes(`href="/${name}"`));
    assert.ok(result.styles.includes(".greeting[data-sc-"));
    assert.ok(!result.styles.includes("background: #fafaf8"));
    assert.ok(result.html.includes('href="/styles.css"'));
    assert.ok(result.html.includes('href="https://fonts.example.com/font.css"'));
  });

  test("runtime tags are ESM, ordered after core, and hydration is last", async () => {
    const result = await renderRoute(state, "/");
    const tags = [
      ...result.html.matchAll(/<script type="module" src="\/([^"]+)"><\/script>/g),
    ].map((match) => match[1]);
    assert.deepEqual(tags, result.runtime.map((chunk) => chunk.name));
    assert.ok(tags.length >= 3);
    const hydration = result.runtime.at(-1);
    assert.ok(hydration.content.includes("DOMContentLoaded"));
    assert.equal(
      result.runtime.filter((chunk) => chunk.content.includes("DOMContentLoaded"))
        .length,
      1
    );
  });

  test("non-.chjs imports are rewritten to /<src-relative> URLs", async () => {
    const result = await renderRoute(state, "/");
    const counterChunk = result.runtime.find((chunk) =>
      chunk.content.includes("formatCount")
    );
    assert.ok(counterChunk, "counter chunk present");
    assert.ok(counterChunk.content.includes('from "/lib/format.js"'));
    assert.ok(!counterChunk.content.includes('from "./format.js"'));
    assert.ok(
      await fs
        .stat(path.join(root, "src", "lib", "format.js"))
        .then((stat) => stat.isFile())
    );
  });

  test("generated ./run-*.js imports stay untouched", async () => {
    const result = await renderRoute(state, "/");
    const moduleChunks = result.runtime.filter((chunk) =>
      chunk.content.includes('from "./run-')
    );
    assert.ok(moduleChunks.length > 0);
    for (const chunk of moduleChunks) {
      assert.ok(!chunk.content.includes('from "/run-'));
    }
  });

  test("query and hash suffixes are preserved when rewriting", async () => {
    const suffixRoot = await makeApp({
      pages: {
        "index.chjs": `<script>
  import "../lib/format.js?raw#frag";
</script>
<template><main>Suffix</main></template>`,
      },
      lib: { "format.js": "export const ok = true;\n" },
    });
    try {
      const suffixState = await buildSiteState(suffixRoot);
      const result = await renderRoute(suffixState, "/");
      const chunk = result.runtime.find((entry) =>
        entry.content.includes("format.js?raw#frag")
      );
      assert.ok(chunk, "import preserved");
      assert.ok(chunk.content.includes('import "/lib/format.js?raw#frag"'));
    } finally {
      await fs.rm(suffixRoot, { recursive: true, force: true });
    }
  });

  test("warns once per state for bare and escaping imports", async () => {
    const warnRoot = await makeApp({
      pages: {
        "index.chjs": `<script>
  import "lodash";
  import "../../outside.js";
</script>
<template><main>Warnings</main></template>`,
      },
    });
    try {
      const warnState = await buildSiteState(warnRoot);
      const warns = await captureWarnings(async () => {
        await renderRoute(warnState, "/");
        await renderRoute(warnState, "/");
      });
      assert.equal(
        warns.filter((warning) => warning.includes('bare import "lodash"')).length,
        1
      );
      assert.equal(
        warns.filter((warning) => warning.includes("escapes srcDir")).length,
        1
      );
    } finally {
      await fs.rm(warnRoot, { recursive: true, force: true });
    }
  });
});

describe("routing — emitSite", () => {
  let parent;
  let root;
  let state;

  before(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-emit-"));
    root = path.join(parent, "app");
    await fs.cp(FIXTURE_BASIC, root, { recursive: true });
    state = await buildSiteState(root);
  });

  after(async () => {
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("emits routes, scoped CSS, runtime chunks and copied assets", async () => {
    const emitted = await emitSite(state);
    const outDir = path.join(root, "dist");

    assert.ok((await listDir(outDir)).includes("index.html"));
    assert.ok(emitted.files.some((file) => /^sc-[a-z0-9]+\.css$/.test(file.path)));
    assert.ok(emitted.files.some((file) => /^run-[a-z0-9]+\.js$/.test(file.path)));
    assert.ok(emitted.copies.some((copy) => copy.relative === "static"));
    assert.ok(emitted.copies.some((copy) => copy.relative === "styles.css"));
    assert.ok(emitted.copies.some((copy) => copy.relative === "lib/format.js"));
    assert.ok(!emitted.copies.some((copy) => copy.relative === "app.html"));
    assert.ok(!emitted.copies.some((copy) => copy.relative.endsWith(".chjs")));

    assert.ok((await listDir(path.join(outDir, "static"))).includes("hello.txt"));
    assert.ok((await listDir(path.join(outDir, "lib"))).includes("format.js"));
    assert.ok((await listDir(outDir)).includes("favicon.ico"));
    assert.ok(!(await listDir(outDir)).includes("app.html"));
    assert.ok(!(await listDir(outDir)).includes("pages"));
  });

  test("writes .chocola/hashes.json with module-id keys", async () => {
    const emitted = await emitSite(state);
    const file = path.join(root, ".chocola", "hashes.json");
    const text = await fs.readFile(file, "utf-8");
    assert.ok(text.endsWith("\n"));
    const hashes = JSON.parse(text);
    assert.deepEqual(hashes, emitted.hashMap);
    assert.deepEqual(Object.keys(hashes), [
      "lib/action.chjs",
      "lib/card.chjs",
      "lib/counter.chjs",
      "lib/greeting.chjs",
      "pages/index.chjs",
    ]);
    assert.equal(hashes["lib/greeting.chjs"], deterministicHash("lib/greeting.chjs", 8));
  });

  test("emptyOutDir clears stale files by default", async () => {
    const outDir = path.join(root, "dist");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "stale.txt"), "stale");

    await emitSite(state);
    assert.ok(!(await listDir(outDir)).includes("stale.txt"));
  });

  test("emptyOutDir false preserves stale files", async () => {
    const keepRoot = await makeApp({
      config: { bundle: { srcDir: "src", outDir: "dist", emptyOutDir: false } },
    });
    try {
      const keepState = await buildSiteState(keepRoot);
      const outDir = path.join(keepRoot, "dist");
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, "stale.txt"), "keep");
      await emitSite(keepState);
      assert.ok((await listDir(outDir)).includes("stale.txt"));
      assert.ok((await listDir(outDir)).includes("index.html"));
    } finally {
      await fs.rm(keepRoot, { recursive: true, force: true });
    }
  });

  test("generated files win collisions with author assets", async () => {
    const collisionRoot = await makeApp();
    try {
      const collisionState = await buildSiteState(collisionRoot);
      const first = await renderRoute(collisionState, "/");
      const runtimeName = first.runtime.at(-1).name;
      const generated = first.runtime.at(-1).content;
      await fs.writeFile(
        path.join(collisionRoot, "src", runtimeName),
        "AUTHOR COLLISION"
      );

      const rebuilt = await buildSiteState(collisionRoot);
      await emitSite(rebuilt);
      const written = await fs.readFile(
        path.join(collisionRoot, "dist", runtimeName),
        "utf-8"
      );
      assert.equal(written, generated);
    } finally {
      await fs.rm(collisionRoot, { recursive: true, force: true });
    }
  });

  test("emitSite and assembleDocument require a valid state", async () => {
    await assert.rejects(() => emitSite(null), /requires a site state/);
    assert.throws(
      () => assembleDocument({ state: null }),
      /requires a state with a loaded document shell/
    );
  });
});

describe("routing — assembleDocument", () => {
  test("inserts head, scoped CSS, body and runtime in the documented order", () => {
    const shellState = {
      shell: {
        source: `<html><head><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`,
        headSlot: true,
        file: "app.html",
      },
    };
    const html = assembleDocument({
      state: shellState,
      page: { headSource: "<title>T</title>", graph: { root: { compProps: [] } } },
      result: {
        html: "<main>Body</main>",
        styles: ".x{color:red}",
        runtime: [{ name: "run-aaaaaa.js" }, { name: "run-bbbbbb.js" }],
      },
      head: "<title>T</title>",
    });

    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes("<title>T</title>"));
    const scoped = `sc-${deterministicHash(".x{color:red}", 6)}.css`;
    assert.ok(html.indexOf(scoped) > html.indexOf("<title>T</title>"));
    assert.ok(html.indexOf(scoped) < html.indexOf("</head>"));
    assert.ok(html.includes("<main>Body</main>"));
    assert.ok(!html.includes(BODY_SLOT_TAG));
    assert.ok(html.indexOf("run-aaaaaa.js") < html.indexOf("run-bbbbbb.js"));
    assert.ok(html.indexOf("run-bbbbbb.js") < html.indexOf("</body>"));
  });
});

describe("routing — RuntimeStore", () => {
  test("stores chunks in memory, falls back to disk, and clears", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-store-"));
    try {
      const store = new RuntimeStore(root, { memoryLimit: 1 });
      const names = await store.add([
        { name: "a.js", content: "A" },
        { name: "b.js", content: "B" },
      ]);
      assert.deepEqual(names, ["a.js", "b.js"]);
      assert.ok(store.has("a.js"));
      assert.ok(store.has("b.js"));
      assert.equal(await store.get("a.js"), "A");
      assert.equal(await store.get("b.js"), "B");
      assert.ok(
        await fs.stat(path.join(root, ".chocola", "runtime", "a.js")).then((s) => s.isFile())
      );

      const target = path.join(root, "written");
      const written = await store.writeTo(target);
      assert.deepEqual(written, ["a.js", "b.js"]);
      assert.equal(await fs.readFile(path.join(target, "b.js"), "utf-8"), "B");

      await store.clear();
      assert.equal(store.has("a.js"), false);
      assert.equal(await store.get("a.js"), null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal and invalid runtime names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-store-bad-"));
    try {
      const store = new RuntimeStore(root);
      for (const bad of ["../a.js", "a/b.js", "..", "."]) {
        await assert.rejects(
          () => store.get(bad),
          /Invalid runtime file name/
        );
        await assert.rejects(
          () => store.add([{ name: bad, content: "x" }]),
          /Invalid runtime file name/
        );
        assert.equal(store.has(bad), false);
      }
      await assert.rejects(() => store.get(""), /Invalid runtime file name/);
      assert.equal(store.has(""), false);
      assert.deepEqual(await store.add([{ name: "", content: "x" }]), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("writeHashMap sorts keys and adds a trailing newline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-hash-"));
    try {
      await writeHashMap(
        { rootDir: root },
        { "b.chjs": "22222222", "a.chjs": "11111111" }
      );
      const text = await fs.readFile(path.join(root, ".chocola", "hashes.json"), "utf-8");
      assert.equal(
        text,
        `{\n  "a.chjs": "11111111",\n  "b.chjs": "22222222"\n}\n`
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
