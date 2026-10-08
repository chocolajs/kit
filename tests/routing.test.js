import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

import {
  discoverPages,
  buildMultipageGraph,
  buildRouteTable,
  matchRoute,
  renderRoute,
  emitMultipage,
  filePathToRoute,
  routeAliases,
  pageComponentName,
  pageComponentTag,
  toComponentSFC,
  injectPageIntoLayout,
  injectHeadIntoLayout,
  splitPageHead,
  BODY_SLOT_TAG,
  HEAD_SLOT_TAG,
} from "../routing.js";
import { createHandler } from "../server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BASIC = path.join(__dirname, "fixtures", "basic");
const FIXTURE_SERVER = path.join(__dirname, "fixtures", "server");

function httpGet(baseUrl, pathname) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const GREETING_SFC =
  `<script>export let name = "World";</` + `script><template><div>Hello {name}!</div></template>`;

const LAYOUT_HTML =
  `<!DOCTYPE html><html><head><meta charset="utf-8"><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body><header>NAV</header><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}><footer>FOOT</footer></body></html>`;

async function makeLayoutApp() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-layout-"));
  const src = path.join(tmp, "src");
  await fs.mkdir(path.join(src, "lib"), { recursive: true });
  await fs.mkdir(path.join(src, "pages", "blog"), { recursive: true });
  await fs.writeFile(path.join(src, "app.html"), LAYOUT_HTML);
  await fs.writeFile(
    path.join(src, "pages", "index.html"),
    `<script>export let name = "World";</` +
      `script>\n<${HEAD_SLOT_TAG}><title>Home | {name}</title><meta name="description" content="Welcome {name}"></${HEAD_SLOT_TAG}>\n<template><main>Home {name}</main></template>`
  );
  await fs.writeFile(
    path.join(src, "pages", "about.html"),
    `<${HEAD_SLOT_TAG}><title>About | Site</title></${HEAD_SLOT_TAG}><main>About page</main>`
  );
  await fs.writeFile(
    path.join(src, "pages", "blog", "index.html"),
    `<template><main>Blog index</main></template>`
  );
  await fs.writeFile(path.join(src, "pages", "blog", "post.html"), `<main>Post page</main>`);
  await fs.writeFile(path.join(src, "lib", "greeting.html"), GREETING_SFC);
  await fs.writeFile(path.join(tmp, "chocola.config.json"), JSON.stringify({ bundle: { srcDir: "src", outDir: "dist" } }));
  return tmp;
}

async function makeLegacyApp() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-legacy-"));
  const src = path.join(tmp, "src");
  await fs.mkdir(path.join(src, "lib"), { recursive: true });
  await fs.writeFile(
    path.join(src, "index.html"),
    `<!DOCTYPE html><html><head><title>Home</title></head><body><app><Greeting name="Home" /></app></body></html>`
  );
  await fs.writeFile(
    path.join(src, "about.html"),
    `<!DOCTYPE html><html><head><title>About</title></head><body><app><Greeting name="About" /></app></body></html>`
  );
  await fs.writeFile(path.join(src, "lib", "greeting.html"), GREETING_SFC);
  await fs.writeFile(path.join(tmp, "chocola.config.json"), JSON.stringify({ bundle: { srcDir: "src", outDir: "dist" } }));
  return tmp;
}

describe("routing — filePathToRoute", () => {
  test("maps pages-relative paths to clean routes", () => {
    assert.equal(filePathToRoute("index.html"), "/");
    assert.equal(filePathToRoute("about.html"), "/about");
    assert.equal(filePathToRoute("blog/index.html"), "/blog");
    assert.equal(filePathToRoute("blog/post.html"), "/blog/post");
  });

  test("routeAliases covers clean, slash and .html forms", () => {
    assert.deepEqual(routeAliases("/", "index.html"), ["/", "/index", "/index.html"]);
    assert.ok(routeAliases("/about", "about.html").includes("/about"));
    assert.ok(routeAliases("/about", "about.html").includes("/about/"));
    assert.ok(routeAliases("/about", "about.html").includes("/about.html"));
    assert.ok(routeAliases("/blog", "blog/index.html").includes("/blog/index.html"));
  });
});

describe("routing — layout helpers", () => {
  test("pageComponentName is deterministic and identifier-safe", () => {
    assert.equal(pageComponentName("/"), "chocolakitpageindex.html");
    assert.equal(pageComponentName("/about"), "chocolakitpageabout.html");
    assert.equal(pageComponentName("/blog/post"), "chocolakitpageblogpost.html");
    assert.match(pageComponentName("/a-b_c"), /^[a-z0-9.]+$/);
  });

  test("pageComponentTag capitalizes the component base", () => {
    assert.equal(pageComponentTag("chocolakitpageabout.html"), "Chocolakitpageabout");
  });

  test("toComponentSFC leaves SFC sources untouched", () => {
    const sfc = `<script>export let x;</` + `script><template><div>{x}</div></template>`;
    assert.equal(toComponentSFC(sfc), sfc);
  });

  test("toComponentSFC wraps fragments and full documents as templates", () => {
    const frag = toComponentSFC(`<main>Hi</main>`);
    assert.ok(frag.includes("<template>") && frag.includes("<main>Hi</main>"));
    const doc = toComponentSFC(
      `<!DOCTYPE html><html><head><title>T</title></head><body><main>Hi</main></body></html>`
    );
    assert.ok(doc.includes("<template>") && doc.includes("<main>Hi</main>"));
    assert.ok(!doc.includes("<body>"), "layout chrome must not leak into page template");
  });

  test("injectPageIntoLayout replaces the body slot and forwards attrs", () => {
    const out = injectPageIntoLayout(LAYOUT_HTML, "Chocolakitpageabout");
    assert.ok(out.includes("<app><Chocolakitpageabout></Chocolakitpageabout></app>"));
    assert.ok(!out.includes(BODY_SLOT_TAG));
    assert.ok(out.includes("NAV") && out.includes("FOOT"), "layout chrome preserved");
  });

  test("splitPageHead separates head fragment from body SFC", () => {
    const { head, sfc } = splitPageHead(
      `<${HEAD_SLOT_TAG}><title>Hi</title></${HEAD_SLOT_TAG}><template><main>Hi</main></template>`
    );
    assert.equal(head, "<title>Hi</title>");
    assert.ok(sfc.includes("<main>Hi</main>") && !sfc.includes(HEAD_SLOT_TAG));
    const none = splitPageHead(`<template><main>Hi</main></template>`);
    assert.equal(none.head, null);
  });

  test("splitPageHead rejects duplicate and nested head tags", () => {
    assert.throws(
      () =>
        splitPageHead(
          `<${HEAD_SLOT_TAG}><title>A</title></${HEAD_SLOT_TAG}><${HEAD_SLOT_TAG}><title>B</title></${HEAD_SLOT_TAG}><template><div /></template>`
        ),
      /at most one/
    );
    assert.throws(
      () => splitPageHead(`<template><div><${HEAD_SLOT_TAG}><title>A</title></${HEAD_SLOT_TAG}></div></template>`),
      /top-level/
    );
  });

  test("splitPageHead rejects non-head elements", () => {
    assert.throws(
      () => splitPageHead(`<${HEAD_SLOT_TAG}><script src="x.js"></${HEAD_SLOT_TAG}><template><div /></template>`),
      /only supports/
    );
  });

  test("injectHeadIntoLayout renders fragment with ctx interpolation", () => {
    const layout = `<html><head><meta charset="utf-8"><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body></body></html>`;
    const page =
      `<script>export let name = "World";</` +
      `script>\n<${HEAD_SLOT_TAG}><title>Hi {name}</title></${HEAD_SLOT_TAG}>\n<template><main /></template>`;
    const out = injectHeadIntoLayout(layout, page, { name: "Alice" });
    assert.ok(out.includes("<title>Hi Alice</title>"));
    assert.ok(!out.includes(HEAD_SLOT_TAG));
    assert.ok(out.includes('<meta charset="utf-8">'), "layout head preserved");
  });

  test("injectHeadIntoLayout leaves layout head untouched without page head", () => {
    const layout = `<html><head><title>Site</title><${HEAD_SLOT_TAG}></${HEAD_SLOT_TAG}></head><body></body></html>`;
    const out = injectHeadIntoLayout(layout, `<template><main /></template>`, {});
    assert.ok(out.includes("<title>Site</title>"));
  });
});

describe("routing — discovery", () => {
  test("layout mode: pages/ maps to routes, app.html is the layout", async () => {
    const tmp = await makeLayoutApp();
    try {
      const { mode, pages, layoutFile } = await discoverPages(tmp);
      assert.equal(mode, "layout");
      assert.ok(layoutFile.endsWith("app.html"));
      assert.deepEqual(
        pages.map((p) => p.route),
        ["/", "/about", "/blog", "/blog/post"]
      );
      assert.deepEqual(
        pages.map((p) => p.outRel),
        ["index.html", "about.html", path.posix.join("blog", "index.html"), path.posix.join("blog", "post.html")]
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("legacy mode: standalone src/*.html pages still work", async () => {
    const tmp = await makeLegacyApp();
    try {
      const { mode, pages } = await discoverPages(tmp);
      assert.equal(mode, "legacy");
      assert.deepEqual(pages.map((p) => p.route), ["/", "/about"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("existing single-page fixtures stay in legacy mode", async () => {
    const { mode, pages } = await discoverPages(FIXTURE_BASIC);
    assert.equal(mode, "legacy");
    assert.deepEqual(pages.map((p) => p.route), ["/"]);
  });

  test("pages/ without app.html throws", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.rm(path.join(tmp, "src", "app.html"));
      await assert.rejects(() => discoverPages(tmp), /app\.html.*missing/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("app.html without pages/ throws", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-noapp-"));
    try {
      await fs.mkdir(path.join(tmp, "src", "lib"), { recursive: true });
      await fs.writeFile(path.join(tmp, "src", "app.html"), LAYOUT_HTML);
      await assert.rejects(() => buildMultipageGraph(tmp), /No pages found/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("layout without body slot throws", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.writeFile(path.join(tmp, "src", "app.html"), "<html><body><app></app></body></html>");
      await assert.rejects(() => buildMultipageGraph(tmp), new RegExp(`<${BODY_SLOT_TAG}>`));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("layout with two body slots throws", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.writeFile(
        path.join(tmp, "src", "app.html"),
        `<html><body><${BODY_SLOT_TAG} /><${BODY_SLOT_TAG} /></body></html>`
      );
      await assert.rejects(() => buildMultipageGraph(tmp), /exactly one/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("layout with <app> throws (replaced by body slot)", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.writeFile(
        path.join(tmp, "src", "app.html"),
        `<html><body><app><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></app></body></html>`
      );
      await assert.rejects(() => buildMultipageGraph(tmp), /must not contain <app>/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("duplicate routes (about.html + about/index.html) throw", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.mkdir(path.join(tmp, "src", "pages", "about"), { recursive: true });
      await fs.writeFile(path.join(tmp, "src", "pages", "about", "index.html"), "<main>dup</main>");
      await assert.rejects(() => buildMultipageGraph(tmp), /Duplicate route \/about/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("underscore files/dirs are ignored", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.writeFile(path.join(tmp, "src", "pages", "_draft.html"), "<main>draft</main>");
      await fs.mkdir(path.join(tmp, "src", "pages", "_partials"), { recursive: true });
      await fs.writeFile(path.join(tmp, "src", "pages", "_partials", "x.html"), "<main>x</main>");
      const { pages } = await discoverPages(tmp);
      assert.deepEqual(
        pages.map((p) => p.route),
        ["/", "/about", "/blog", "/blog/post"]
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("routing — graph + render", () => {
  test("layout graph registers pages as components, keeps page compat", async () => {
    const tmp = await makeLayoutApp();
    try {
      const graph = await buildMultipageGraph(tmp);
      assert.equal(graph.mode, "layout");
      assert.ok(graph.layoutSource.includes(BODY_SLOT_TAG));
      assert.equal(graph.pages.size, 4);
      assert.ok(graph.page, "graph.page must exist for backwards compat");
      assert.equal(graph.page.route, "/");
      for (const page of graph.pages.values()) {
        assert.ok(page.compName, "layout pages are components");
        assert.ok(graph.loadedComponents.has(page.compName));
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("renderRoute renders each page inside the layout", async () => {
    const tmp = await makeLayoutApp();
    try {
      const graph = await buildMultipageGraph(tmp);
      const home = await renderRoute(graph, "/", { name: "Alice" });
      assert.ok(home.html.includes("NAV") && home.html.includes("FOOT"), "layout chrome");
      assert.ok(home.html.includes("Home Alice"), "page content with ctx prop");
      assert.ok(!home.html.includes(BODY_SLOT_TAG), "slot consumed");
      assert.ok(home.html.includes("<title>Home | Alice</title>"), "page head with ctx");
      assert.ok(home.html.includes('<meta name="description" content="Welcome Alice">'));
      assert.ok(!home.html.includes(HEAD_SLOT_TAG), "head slot consumed");

      const about = await renderRoute(graph, "/about");
      assert.ok(about.html.includes("NAV") && about.html.includes("About page"));
      assert.ok(about.html.includes("<title>About | Site</title>"), "per-page title");

      const blog = await renderRoute(graph, "/blog/");
      assert.ok(blog.html.includes("Blog index"));
      const blogHead = blog.html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
      assert.ok(!blogHead.includes("<title>"), "pages without head add no title");

      const post = await renderRoute(graph, "/blog/post.html");
      assert.ok(post.html.includes("Post page"));

      await assert.rejects(() => renderRoute(graph, "/nope"), /No route found/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("page head never leaks into body", async () => {
    const tmp = await makeLayoutApp();
    try {
      const graph = await buildMultipageGraph(tmp);
      const home = await renderRoute(graph, "/", { name: "Alice" });
      const body = home.html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? "";
      assert.ok(!body.includes("<title>"), "title must render in head only");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("layout without head slot ignores page head with warning", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.writeFile(
        path.join(tmp, "src", "app.html"),
        `<!DOCTYPE html><html><head><title>Site</title></head><body><${BODY_SLOT_TAG}></${BODY_SLOT_TAG}></body></html>`
      );
      const graph = await buildMultipageGraph(tmp);
      const warns = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args.join(" "));
      try {
        const home = await renderRoute(graph, "/");
        assert.ok(home.html.includes("<title>Site</title>"), "layout head preserved");
        assert.ok(!home.html.includes("Home |"), "page head ignored without slot");
      } finally {
        console.warn = origWarn;
      }
      assert.ok(warns.some((w) => w.includes(HEAD_SLOT_TAG)), `expected head warning, got ${warns}`);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("layout pages use shared lib components", async () => {
    const tmp = await makeLayoutApp();
    try {
      await fs.writeFile(
        path.join(tmp, "src", "pages", "index.html"),
        `<template><main><Greeting name="{name}" /></main></template>`
      );
      const graph = await buildMultipageGraph(tmp);
      const home = await renderRoute(graph, "/", { name: "Bob" });
      assert.ok(home.html.includes("Hello Bob!"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("matchRoute handles trailing slash and .html aliases", async () => {
    const tmp = await makeLayoutApp();
    try {
      const graph = await buildMultipageGraph(tmp);
      const table = buildRouteTable(graph);
      assert.ok(matchRoute(table, "/about"));
      assert.ok(matchRoute(table, "/about/"));
      assert.ok(matchRoute(table, "/about.html"));
      assert.ok(matchRoute(table, "/blog"));
      assert.ok(matchRoute(table, "/blog/index.html"));
      assert.equal(matchRoute(table, "/nope-xyz"), null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("routing — emitMultipage", () => {
  test("layout emit strips pages/ prefix, keeps structure", async () => {
    const tmp = await makeLayoutApp();
    try {
      const graph = await buildMultipageGraph(tmp);
      await emitMultipage(graph);
      const outDir = path.join(tmp, "dist");
      for (const rel of ["index.html", "about.html", path.join("blog", "index.html"), path.join("blog", "post.html")]) {
        const html = await fs.readFile(path.join(outDir, rel), "utf-8");
        assert.ok(html.includes("NAV"), `${rel} should render inside layout`);
      }
      const entries = await fs.readdir(outDir);
      assert.ok(!entries.includes("pages"), "pages/ prefix must not leak into dist");
      assert.ok(!entries.includes("app.html"), "layout itself is not emitted as a page");
      const about = await fs.readFile(path.join(outDir, "about.html"), "utf-8");
      assert.ok(about.includes("About page"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("routing — server SSR", () => {
  let tmp;
  let server;
  let baseUrl;

  before(async () => {
    tmp = await makeLayoutApp();
    const handler = await createHandler(tmp);
    server = http.createServer(handler);
    await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", res);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  test("each route SSRs its page inside the layout", async () => {
    const home = await httpGet(baseUrl, "/");
    assert.equal(home.status, 200);
    assert.ok(home.text.includes("NAV") && home.text.includes("Home"));

    const about = await httpGet(baseUrl, "/about");
    assert.equal(about.status, 200);
    assert.ok(about.text.includes("NAV") && about.text.includes("About page"));

    const aboutSlash = await httpGet(baseUrl, "/about/");
    assert.equal(aboutSlash.status, 200);
    assert.ok(aboutSlash.text.includes("About page"));

    const aboutHtml = await httpGet(baseUrl, "/about.html");
    assert.equal(aboutHtml.status, 200);
    assert.ok(aboutHtml.text.includes("About page"));

    const blog = await httpGet(baseUrl, "/blog");
    assert.equal(blog.status, 200);
    assert.ok(blog.text.includes("Blog index"));

    const post = await httpGet(baseUrl, "/blog/post");
    assert.equal(post.status, 200);
    assert.ok(post.text.includes("Post page"));
  });

  test("per-request query ctx applies to layout pages", async () => {
    const res = await httpGet(baseUrl, "/?name=Alice");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Home Alice"), `got ${res.text.slice(0, 300)}`);
  });

  test("SSR head is per-page with ctx interpolation", async () => {
    const home = await httpGet(baseUrl, "/?name=Alice");
    const homeHead = home.text.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    assert.ok(homeHead.includes("<title>Home | Alice</title>"), `got ${homeHead.slice(0, 200)}`);

    const about = await httpGet(baseUrl, "/about");
    const aboutHead = about.text.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    assert.ok(aboutHead.includes("<title>About | Site</title>"));
    assert.ok(!aboutHead.includes("Home |"), "heads must not leak across routes");
  });

  test("unknown route still 404s", async () => {
    const res = await httpGet(baseUrl, "/unknown-xyz-123");
    assert.equal(res.status, 404);
  });

  test("legacy single-page fixture still serves / /index /index.html", async () => {
    const handler = await createHandler(FIXTURE_SERVER);
    const srv = http.createServer(handler);
    await new Promise((res, rej) => {
      srv.once("error", rej);
      srv.listen(0, "127.0.0.1", res);
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      for (const p of ["/", "/index", "/index.html"]) {
        const res = await httpGet(base, p);
        assert.equal(res.status, 200, p);
      }
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
