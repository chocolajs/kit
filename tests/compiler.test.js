import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Chocola imports
import {
  buildModuleGraph,
  render,
  compile,
  normalizeConfig,
  ModuleGraph,
  ChocolaModule,
} from "chocola/compiler/index.js";
import { deterministicHash } from "chocola/compiler/utils.js";

import { buildSiteState, renderRoute } from "../routing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "basic");

const GREETING = `<script>
  export let name = "World";
  let mounted = false;
  function $runtime() {
    mounted = true;
  }
</script>
<template>
  <div class="greeting">Hello {name}!</div>
</template>
<style>
  .greeting { color: blue; }
</style>`;

const CORE_PAGE = `<script>
  import "./format.js";
  import Greeting from "./lib/greeting.chjs";
  export let title = "Core";
</script>
<template>
  <main>
    <h1>{title}</h1>
    <Greeting />
  </main>
</template>`;

async function listDir(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function makeCoreApp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-core-"));
  await fs.mkdir(path.join(root, "lib"), { recursive: true });
  await fs.writeFile(path.join(root, "page.chjs"), CORE_PAGE);
  await fs.writeFile(path.join(root, "lib", "greeting.chjs"), GREETING);
  await fs.writeFile(path.join(root, "format.js"), "export const core = true;\n");
  await fs.writeFile(
    path.join(root, "lib", "unused.chjs"),
    `<template><div>unused</div></template>`
  );
  return root;
}

async function makeFixtureCopy() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-kit-core-"));
  const root = path.join(parent, "app");
  await fs.cp(FIXTURE, root, { recursive: true });
  return { parent, root };
}

describe("compiler — core import-based API", () => {
  let coreRoot;
  let graph;

  before(async () => {
    coreRoot = await makeCoreApp();
    graph = await buildModuleGraph(coreRoot, { entry: "page.chjs" });
  });

  after(async () => {
    if (coreRoot) await fs.rm(coreRoot, { recursive: true, force: true });
  });

  test("entry point exports the module pipeline", () => {
    assert.equal(typeof buildModuleGraph, "function");
    assert.equal(typeof render, "function");
    assert.equal(typeof compile, "function");
    assert.equal(typeof normalizeConfig, "function");
    assert.equal(typeof ModuleGraph, "function");
    assert.equal(typeof ChocolaModule, "function");
  });

  test("buildModuleGraph follows explicit .chjs imports only", () => {
    assert.ok(graph instanceof ModuleGraph);
    assert.ok(graph.root instanceof ChocolaModule);
    assert.equal(graph.root.id, "page.chjs");
    assert.equal(graph.entry, "page.chjs");
    assert.ok(graph.root.isRoot);

    assert.deepEqual([...graph.modules.keys()].sort(), [
      "lib/greeting.chjs",
      "page.chjs",
    ]);
    assert.ok(!graph.modules.has("lib/unused.chjs"), "unused components stay out");
    assert.ok(graph.root.deps.has("lib/greeting.chjs"));
    assert.deepEqual(
      graph.root.compProps.map((prop) => [prop.name, prop.defaultValue]),
      [["title", '"Core"']]
    );
    assert.equal(graph.root.cssId, deterministicHash("page.chjs", 8));
  });

  test("raw import statements are preserved for host rewriting", () => {
    const greetingImport = graph.root.imports.find(
      (entry) => entry.source === "./lib/greeting.chjs"
    );
    assert.ok(greetingImport);
    assert.equal(
      greetingImport.raw.trim(),
      'import Greeting from "./lib/greeting.chjs";'
    );
    assert.ok(
      graph.root.imports.some((entry) => entry.source === "./format.js")
    );
  });

  test("entry is required and must be a .chjs path", async () => {
    await assert.rejects(
      () => buildModuleGraph(coreRoot),
      /entry is required/
    );
    await assert.rejects(
      () => buildModuleGraph(coreRoot, { entry: "page.html" }),
      /entry must point to a \.chjs component/
    );
  });

  test("render is pure and returns fragment, styles, runtime and hashes", async () => {
    const before = await listDir(coreRoot);
    const result = await render(graph);
    const after = await listDir(coreRoot);

    assert.deepEqual(after, before, "render must not write files");
    assert.equal(typeof result.html, "string");
    assert.match(result.html, /<h1[^>]*>Core<\/h1>/);
    assert.ok(result.html.includes("Hello World!"));
    assert.ok(!result.html.includes("<chocolakit:"));
    assert.equal(typeof result.styles, "string");
    assert.ok(result.styles.includes(".greeting[data-sc-"));
    assert.ok(Array.isArray(result.runtime));
    assert.deepEqual(Object.keys(result.hashMap), [
      "lib/greeting.chjs",
      "page.chjs",
    ]);
  });

  test("render uses ctx overrides and component prop defaults", async () => {
    const custom = await render(graph, { title: "Ctx", name: "Alice" });
    assert.match(custom.html, /<h1[^>]*>Ctx<\/h1>/);
    assert.ok(custom.html.includes("Hello Alice!"));

    const fallback = await render(graph);
    assert.match(fallback.html, /<h1[^>]*>Core<\/h1>/);
    assert.ok(fallback.html.includes("Hello World!"));
  });

  test("runtime chunks are ESM with the hydration chunk last", async () => {
    const result = await render(graph);
    assert.ok(result.runtime.length >= 3);

    for (const chunk of result.runtime) {
      assert.match(chunk.name, /^run-[a-z0-9]+\.js$/);
      assert.equal(typeof chunk.content, "string");
    }

    const hydration = result.runtime.at(-1);
    assert.ok(hydration.content.includes("DOMContentLoaded"));
    const hydrationCount = result.runtime.filter((chunk) =>
      chunk.content.includes("DOMContentLoaded")
    ).length;
    assert.equal(hydrationCount, 1, "only the hydration chunk orchestrates mount");

    assert.ok(
      result.runtime.some((chunk) => chunk.content.includes('import "./format.js";')),
      "core preserves non-.chjs imports for Kit to rewrite"
    );
  });

  test("compile() is buildModuleGraph() + render()", async () => {
    const direct = await render(
      await buildModuleGraph(coreRoot, { entry: "page.chjs" })
    );
    const combined = await compile(coreRoot, { entry: "page.chjs" });
    assert.deepEqual(combined, direct);
  });

  test("hashes and output are deterministic across builds", async () => {
    const second = await buildModuleGraph(coreRoot, { entry: "page.chjs" });
    const a = await render(graph);
    const b = await render(second);
    assert.equal(b.styles, a.styles);
    assert.deepEqual(b.hashMap, a.hashMap);
    assert.deepEqual(
      b.runtime.map((chunk) => chunk.name),
      a.runtime.map((chunk) => chunk.name)
    );
  });
});

describe("compiler — Kit integration", () => {
  let parent;
  let root;
  let state;

  before(async () => {
    ({ parent, root } = await makeFixtureCopy());
    state = await buildSiteState(root);
  });

  after(async () => {
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  test("buildSiteState builds one core graph rooted at pages/index.chjs", () => {
    assert.ok(state.pages.has("/"));
    const page = state.pages.get("/");
    assert.ok(page.graph instanceof ModuleGraph);
    assert.equal(page.graph.root.id, "pages/index.chjs");
    assert.ok(page.graph.modules.has("lib/greeting.chjs"));
    assert.ok(page.graph.modules.has("lib/counter.chjs"));
    assert.ok(page.graph.modules.has("lib/card.chjs"));
    assert.ok(page.graph.modules.has("lib/action.chjs"));
    assert.ok(!page.graph.modules.has("lib/unused.chjs"));
  });

  test("renderRoute reuses the page graph and assembles core output", async () => {
    const page = state.pages.get("/");
    page.graph.__identity = true;
    const route = await renderRoute(state, "/", {});
    const raw = await render(page.graph, {});
    assert.equal(state.pages.get("/").graph, page.graph);
    assert.equal(state.pages.get("/").graph.__identity, true);
    assert.ok(route.html.includes(raw.html));
    assert.equal(route.styles, raw.styles);
    assert.deepEqual(route.hashMap, raw.hashMap);
    assert.deepEqual(
      route.runtime.map((chunk) => chunk.name),
      raw.runtime.map((chunk) => chunk.name)
    );
  });

  test("renderRoute calls core per request without rebuilding the graph", async () => {
    const page = state.pages.get("/");
    const graph = page.graph;
    const first = await renderRoute(state, "/", { title: "One" });
    const second = await renderRoute(state, "/", { title: "Two" });
    assert.equal(state.pages.get("/").graph, graph);
    assert.ok(first.html.includes("<title>One</title>"));
    assert.ok(second.html.includes("<title>Two</title>"));
    assert.notEqual(first.html, second.html);
  });
});
