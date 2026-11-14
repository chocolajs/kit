import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import http from "http";
import zlib from "zlib";
import { fileURLToPath } from "url";

import { createHandler, createServer, serve } from "../server/index.js";

// Chocola imports
import { deterministicHash } from "chocola/compiler/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "server");
const FIXTURE_BASIC = path.join(__dirname, "fixtures", "basic");

function httpRequest(baseUrl, pathname, opts = {}) {
  const url = new URL(pathname, baseUrl);
  const headers = opts.headers || {};
  const method = opts.method || "GET";
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const rawBuffer = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"];
        let body = rawBuffer;
        if (encoding === "gzip" && rawBuffer.length) {
          try {
            body = zlib.gunzipSync(rawBuffer);
          } catch {
            // Keep the raw buffer when it is not valid gzip.
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          raw: rawBuffer,
          text: body.toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function rawRequest(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw: Buffer.concat(chunks),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function copyFixture(source = FIXTURE) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-server-"));
  const root = path.join(parent, "app");
  await fs.cp(source, root, { recursive: true });
  return { parent, root };
}

async function writePage(root, rel, source) {
  const file = path.join(root, "src", "pages", rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function setMiddleware(root, relative = "./server-middleware.js") {
  const configPath = path.join(root, "chocola.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  config.server = { ...(config.server || {}), middleware: relative };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

const QUERY_INDEX = `<script>
  import Greeting from "../lib/greeting.chjs";
</script>
<template><main><Greeting /></main></template>`;

const ABOUT_PAGE = `<chocolakit:head><title>About | Site</title></chocolakit:head>
<template><main>About page</main></template>`;

describe("server — route table and SSR rendering", () => {
  let parent;
  let root;
  let handler;
  let server;
  let baseUrl;

  before(async () => {
    ({ parent, root } = await copyFixture(FIXTURE));
    handler = await createHandler(root, { silent: true });
    ({ server, baseUrl } = await listen(handler));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("GET / renders the page inside the shell with scoped CSS and runtime", async () => {
    const res = await httpRequest(baseUrl, "/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.ok(res.headers["etag"], "ETag present");
    assert.ok(res.headers["last-modified"], "Last-Modified present");
    assert.ok(res.text.includes("Hello World!"));
    assert.ok(res.text.includes("slot content"));
    assert.ok(res.text.includes('href="/styles.css"'));
    assert.ok(!res.text.includes("<app>"));
    assert.ok(!res.text.includes("chocolakit:"));

    const scoped = `sc-${deterministicHash(
      handler.warmResults.get("/").styles,
      6
    )}.css`;
    assert.ok(res.text.includes(`href="/${scoped}"`));
    assert.ok(/<script type="module" src="\/run-[a-z0-9]+\.js"><\/script>/.test(res.text));
  });

  test("alias routes /index and /index.html SSR the same page", async () => {
    for (const pathname of ["/index", "/index.html"]) {
      const res = await httpRequest(baseUrl, pathname);
      assert.equal(res.status, 200, pathname);
      assert.ok(res.text.includes("Hello World!"));
      assert.ok(res.text.includes("sc-"));
      assert.ok(/<script type="module"/.test(res.text));
    }
  });

  test("unknown routes 404", async () => {
    const res = await httpRequest(baseUrl, "/unknown-xyz-123");
    assert.equal(res.status, 404);
    assert.ok(res.text.includes("404"));
  });

  test("handler exposes state, routes, graphs and generated assets", async () => {
    assert.ok(handler.state);
    assert.equal(handler.paths.srcDir, path.join(root, "src"));
    assert.ok(handler.routes instanceof Map);
    assert.ok(handler.graphs instanceof Map);
    assert.equal(handler.graphs.get("/"), handler.routes.get("/").graph);
    assert.equal(handler.routes.get("/").graph.root.id, "pages/index.chjs");
    assert.ok(handler.routeTable.has("/"));
    assert.ok(handler.virtualFiles.has("/" + `sc-${deterministicHash(handler.warmResults.get("/").styles, 6)}.css`));
    assert.ok(handler.runtimeStore);
    assert.ok(handler.warmResults.has("/"));

    for (const id of [
      "lib/action.chjs",
      "lib/card.chjs",
      "lib/counter.chjs",
      "lib/greeting.chjs",
      "pages/index.chjs",
    ]) {
      assert.ok(handler.hashMap[id], `missing hash for ${id}`);
    }

    const hashFile = path.join(root, ".chocola", "hashes.json");
    const persisted = JSON.parse(await fs.readFile(hashFile, "utf-8"));
    assert.deepEqual(persisted, handler.hashMap);
  });

  test("per-request head interpolation uses query ctx", async () => {
    const res = await httpRequest(baseUrl, "/?title=Query");
    assert.equal(res.status, 200);
    const head = res.text.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    assert.ok(head.includes("<title>Query</title>"));
    assert.ok(head.includes('content="Fixture page for Query"'));
  });
});

describe("server — per-request props and graphs", () => {
  let parent;
  let root;
  let handler;
  let server;
  let baseUrl;

  before(async () => {
    ({ parent, root } = await copyFixture(FIXTURE));
    await writePage(root, "index.chjs", QUERY_INDEX);
    handler = await createHandler(root, { silent: true });
    ({ server, baseUrl } = await listen(handler));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("request-time ctx props are merged into templates", async () => {
    const res = await httpRequest(baseUrl, "/?name=Alice");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Hello Alice!"), `got ${res.text.slice(0, 400)}`);
    assert.ok(!res.text.includes("Hello World!"));
  });

  test("missing props fall back to component defaults", async () => {
    const res = await httpRequest(baseUrl, "/");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Hello World!"));
  });

  test("renders per request while reusing the same graphs", async () => {
    const graph = handler.routes.get("/").graph;
    const alice = await httpRequest(baseUrl, "/?name=Alice");
    const bob = await httpRequest(baseUrl, "/?name=Bob");
    assert.ok(alice.text.includes("Hello Alice!"));
    assert.ok(bob.text.includes("Hello Bob!"));
    assert.notEqual(alice.text, bob.text);
    assert.equal(handler.routes.get("/").graph, graph);
    assert.equal(handler.graphs.get("/"), graph);
  });

  test("middleware return wins over query props", async () => {
    await fs.writeFile(
      path.join(root, "server-middleware.js"),
      `export default [ async () => ({ name: "FromMiddleware" }) ];`
    );
    await setMiddleware(root);
    const local = await createHandler(root, { silent: true });
    const running = await listen(local);
    try {
      const res = await httpRequest(running.baseUrl, "/?name=FromQuery");
      assert.ok(
        res.text.includes("Hello FromMiddleware!"),
        `middleware should win, got ${res.text.slice(0, 300)}`
      );
    } finally {
      await new Promise((resolve) => running.server.close(resolve));
    }
  });
});

describe("server — multi-page routes", () => {
  let parent;
  let root;
  let handler;
  let server;
  let baseUrl;

  before(async () => {
    ({ parent, root } = await copyFixture(FIXTURE));
    await writePage(root, "about.chjs", ABOUT_PAGE);
    await writePage(root, "blog/index.chjs", `<template><main>Blog index</main></template>`);
    handler = await createHandler(root, { silent: true });
    ({ server, baseUrl } = await listen(handler));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("each route SSRs its page and head", async () => {
    const home = await httpRequest(baseUrl, "/");
    assert.equal(home.status, 200);
    assert.ok(home.text.includes("Hello World!"));

    for (const pathname of ["/about", "/about/", "/about.html"]) {
      const about = await httpRequest(baseUrl, pathname);
      assert.equal(about.status, 200, pathname);
      assert.ok(about.text.includes("About page"));
      assert.ok(about.text.includes("<title>About | Site</title>"));
      assert.ok(!about.text.includes("Hello World!"));
    }

    const blog = await httpRequest(baseUrl, "/blog");
    assert.equal(blog.status, 200);
    assert.ok(blog.text.includes("Blog index"));
  });

  test("distinct graphs back distinct routes", () => {
    assert.notEqual(
      handler.routes.get("/").graph,
      handler.routes.get("/about").graph
    );
    assert.equal(handler.routes.get("/about").graph.root.id, "pages/about.chjs");
  });
});

describe("server — static and source assets", () => {
  let parent;
  let root;
  let handler;
  let server;
  let baseUrl;

  before(async () => {
    ({ parent, root } = await copyFixture(FIXTURE_BASIC));
    handler = await createHandler(root, { silent: true });
    ({ server, baseUrl } = await listen(handler));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("static, source, favicon and global CSS assets are served with mime types", async () => {
    const txt = await httpRequest(baseUrl, "/static/hello.txt");
    assert.equal(txt.status, 200);
    assert.match(txt.headers["content-type"], /text\/plain/);
    assert.ok(txt.text.includes("hello static world"));

    const js = await httpRequest(baseUrl, "/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /javascript/);

    const css = await httpRequest(baseUrl, "/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /text\/css/);
    assert.ok(css.text.includes("background: #fafaf8"));

    const ico = await httpRequest(baseUrl, "/favicon.ico");
    assert.equal(ico.status, 200);
    assert.match(ico.headers["content-type"], /icon/);

    const format = await httpRequest(baseUrl, "/lib/format.js");
    assert.equal(format.status, 200);
    assert.match(format.headers["content-type"], /javascript/);
    assert.ok(format.text.includes("export function formatCount"));
  });

  test("source .chjs files and app.html are not served", async () => {
    for (const pathname of ["/app.html", "/pages/index.chjs", "/lib/greeting.chjs"]) {
      const res = await httpRequest(baseUrl, pathname);
      assert.equal(res.status, 404, pathname);
    }
  });

  test("missing assets 404", async () => {
    const missing = await httpRequest(baseUrl, "/static/missing-xyz.txt");
    assert.equal(missing.status, 404);
    const css = await httpRequest(baseUrl, "/nope.css");
    assert.equal(css.status, 404);
  });

  test("static assets support ETag and 304", async () => {
    const first = await httpRequest(baseUrl, "/static/hello.txt");
    assert.ok(first.headers["etag"]);
    assert.ok(first.headers["last-modified"]);

    const second = await httpRequest(baseUrl, "/static/hello.txt", {
      headers: { "If-None-Match": first.headers["etag"] },
    });
    assert.equal(second.status, 304);

    const third = await httpRequest(baseUrl, "/static/hello.txt", {
      headers: { "If-Modified-Since": new Date(Date.now() + 100000).toUTCString() },
    });
    assert.equal(third.status, 304);
    assert.ok(!Number.isNaN(new Date(first.headers["last-modified"]).getTime()));
  });

  test("virtual scoped CSS and runtime chunks support ETag and 304", async () => {
    const html = await httpRequest(baseUrl, "/");
    const cssMatch = html.text.match(/href="\/(sc-[a-z0-9]+\.css)"/);
    assert.ok(cssMatch, "scoped CSS link missing");
    const cssPath = `/${cssMatch[1]}`;

    const css = await httpRequest(baseUrl, cssPath);
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /text\/css/);
    assert.ok(css.headers["etag"]);
    assert.ok(css.text.includes(".greeting[data-sc-"));
    const css304 = await httpRequest(baseUrl, cssPath, {
      headers: { "If-None-Match": css.headers["etag"] },
    });
    assert.equal(css304.status, 304);

    const names = [
      ...html.text.matchAll(/<script type="module" src="\/([^"]+)"><\/script>/g),
    ].map((match) => match[1]);
    assert.ok(names.length >= 3);

    let rewritten = false;
    for (const name of names) {
      const chunk = await httpRequest(baseUrl, `/${name}`);
      assert.equal(chunk.status, 200, name);
      assert.equal(chunk.headers["content-type"], "text/javascript; charset=utf-8");
      assert.ok(chunk.text.includes("ChocolaComponent") || chunk.text.includes("DOMContentLoaded"));
      if (chunk.text.includes('from "/lib/format.js"')) rewritten = true;
    }
    assert.ok(rewritten, "rewritten source import must be served at its URL");

    const runtime = await httpRequest(baseUrl, `/${names[0]}`);
    const runtime304 = await httpRequest(baseUrl, `/${names[0]}`, {
      headers: { "If-None-Match": runtime.headers["etag"] },
    });
    assert.equal(runtime304.status, 304);
  });

  test("gzip is used for compressible assets only", async () => {
    for (const pathname of ["/", "/static/hello.txt", "/styles.css"]) {
      const response = await rawRequest(baseUrl, pathname, {
        "Accept-Encoding": "gzip",
      });
      assert.equal(response.headers["content-encoding"], "gzip", pathname);
      assert.equal(response.headers["vary"], "Accept-Encoding", pathname);
      const text = zlib.gunzipSync(response.raw).toString("utf-8");
      assert.ok(text.length > 0);
    }

    const ico = await rawRequest(baseUrl, "/favicon.ico", {
      "Accept-Encoding": "gzip",
    });
    assert.equal(ico.headers["content-encoding"], undefined);
  });
});

describe("server — middleware hook", () => {
  test("returned objects are merged into ctx and rendered", async () => {
    const { parent, root } = await copyFixture(FIXTURE);
    await writePage(root, "index.chjs", QUERY_INDEX);
    await fs.writeFile(
      path.join(root, "server-middleware.js"),
      `export default [ async ({ query }) => ({ name: query.name || "MiddlewareUser" }) ];`
    );
    await setMiddleware(root);
    const handler = await createHandler(root, { silent: true });
    const running = await listen(handler);
    try {
      const res = await httpRequest(running.baseUrl, "/");
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("Hello MiddlewareUser!"));
    } finally {
      await new Promise((resolve) => running.server.close(resolve));
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("short-circuiting middleware wins over rendering", async () => {
    const { parent, root } = await copyFixture(FIXTURE);
    await fs.writeFile(
      path.join(root, "server-middleware.js"),
      `export default [ (req, res) => { res.writeHead(401, {"Content-Type":"text/plain"}); res.end("blocked"); } ];`
    );
    await setMiddleware(root);
    const handler = await createHandler(root, { silent: true });
    const running = await listen(handler);
    try {
      const res = await httpRequest(running.baseUrl, "/");
      assert.equal(res.status, 401);
      assert.ok(res.text.includes("blocked"));
      assert.ok(!res.text.includes("Hello"));
    } finally {
      await new Promise((resolve) => running.server.close(resolve));
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("(req,res) and ({query,cookies}) signatures both work", async () => {
    const { parent, root } = await copyFixture(FIXTURE);
    await writePage(root, "index.chjs", QUERY_INDEX);
    await fs.writeFile(
      path.join(root, "server-middleware.js"),
      `export default [
        async ({ query, cookies }) => ({ name: cookies.user || query.name || "Q" }),
        (req, res) => {
          if (req.url.includes("block")) {
            res.writeHead(402, { "Content-Type": "text/plain" });
            res.end("blocked2");
          }
        }
      ];`
    );
    await setMiddleware(root);
    const handler = await createHandler(root, { silent: true });
    const running = await listen(handler);
    try {
      const query = await httpRequest(running.baseUrl, "/?name=Alice");
      assert.ok(query.text.includes("Hello Alice!"));

      const cookie = await httpRequest(running.baseUrl, "/", {
        headers: { Cookie: "user=CookieUser" },
      });
      assert.ok(cookie.text.includes("Hello CookieUser!"));

      const blocked = await httpRequest(running.baseUrl, "/?block=1");
      assert.equal(blocked.status, 402);
    } finally {
      await new Promise((resolve) => running.server.close(resolve));
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("missing middleware files fail loudly", async () => {
    const first = await copyFixture(FIXTURE_BASIC);
    try {
      await setMiddleware(first.root, "./does-not-exist.js");
      await assert.rejects(
        () => createHandler(first.root, { silent: true }),
        /middleware file not found/i
      );
    } finally {
      await fs.rm(first.parent, { recursive: true, force: true });
    }

    const second = await copyFixture(FIXTURE_BASIC);
    try {
      await assert.rejects(
        () => createHandler(second.root, { middleware: "./also-missing.js", silent: true }),
        /middleware file not found/i
      );
    } finally {
      await fs.rm(second.parent, { recursive: true, force: true });
    }
  });
});

describe("server — handler and config", () => {
  test("bare handler works and createServer is an alias", async () => {
    const { parent, root } = await copyFixture(FIXTURE);
    try {
      const handler = await createHandler(root, { silent: true });
      assert.equal(typeof handler, "function");
      const running = await listen(handler);
      try {
        const res = await httpRequest(running.baseUrl, "/");
        assert.equal(res.status, 200);
        assert.ok(res.text.includes("Hello"));
      } finally {
        await new Promise((resolve) => running.server.close(resolve));
      }

      const alias = await createServer(root, { silent: true });
      assert.equal(typeof alias, "function");
      const aliasRunning = await listen(alias);
      try {
        const res = await httpRequest(aliasRunning.baseUrl, "/");
        assert.equal(res.status, 200);
      } finally {
        await new Promise((resolve) => aliasRunning.server.close(resolve));
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("serve honors server.port/hostname and config middleware", async () => {
    const { parent, root } = await copyFixture(FIXTURE);
    await writePage(root, "index.chjs", QUERY_INDEX);
    await fs.writeFile(
      path.join(root, "server-middleware.js"),
      `export default [ async () => ({ name: "FromConfig" }) ];`
    );
    await setMiddleware(root);
    const server = await serve(root, { silent: true });
    try {
      const address = server.address();
      assert.ok(address.port > 0, "config port 0 should bind an ephemeral port");
      assert.equal(address.address, "127.0.0.1");
      const res = await httpRequest(`http://127.0.0.1:${address.port}`, "/");
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("Hello FromConfig!"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("createHandler({ rootDir }) object form is honored", async () => {
    const { parent, root } = await copyFixture(FIXTURE);
    try {
      const handler = await createHandler({ rootDir: root, silent: true });
      assert.equal(typeof handler, "function");
      const running = await listen(handler);
      try {
        const res = await httpRequest(running.baseUrl, "/");
        assert.equal(res.status, 200);
      } finally {
        await new Promise((resolve) => running.server.close(resolve));
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
