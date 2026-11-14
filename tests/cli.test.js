import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "chocola.js");
const FIXTURE_BASIC = path.join(__dirname, "fixtures", "basic");

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function run(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const result = spawnSync("node", [CLI, ...args], {
    cwd: opts.cwd || process.cwd(),
    encoding: "utf-8",
    timeout: opts.timeout ?? 20000,
    env,
  });
  return {
    status: result.status,
    stdout: stripAnsi(result.stdout || ""),
    stderr: stripAnsi(result.stderr || ""),
  };
}

async function listDir(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function pathExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function makeFixtureCopy() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-cli-"));
  const root = path.join(parent, "app");
  await fs.cp(FIXTURE_BASIC, root, { recursive: true });
  return { parent, root };
}

async function makeZeroConfigFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-cli-zero-"));
  const root = path.join(parent, "app");
  await fs.mkdir(root, { recursive: true });
  await fs.cp(path.join(FIXTURE_BASIC, "src"), path.join(root, "src"), {
    recursive: true,
  });
  return { parent, root };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe("cli — build output", () => {
  test("build emits HTML, scoped CSS, runtime chunks, assets and hashes", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      const result = run(["build", root]);
      assert.equal(result.status, 0, result.stderr);

      const outDir = path.join(root, "dist");
      const out = await listDir(outDir);
      assert.ok(out.includes("index.html"));
      assert.ok(out.includes("styles.css"));
      assert.ok(out.includes("app.js"));
      assert.ok(out.includes("favicon.ico"));
      assert.ok(out.includes("lib"));
      assert.ok(out.includes("static"));
      assert.ok(!out.includes("app.html"));
      assert.ok(!out.includes("pages"));

      const scoped = out.find((file) => /^sc-[a-z0-9]+\.css$/.test(file));
      assert.ok(scoped, `missing scoped CSS in ${out}`);
      const runtime = out.filter((file) => /^run-[a-z0-9]+\.js$/.test(file));
      assert.ok(runtime.length >= 3, `missing runtime chunks in ${out}`);

      const html = await fs.readFile(path.join(outDir, "index.html"), "utf-8");
      assert.match(html, /^<!doctype html>/i);
      assert.ok(html.includes("Hello World!"));
      assert.ok(html.includes(`href="/${scoped}"`));
      assert.ok(!html.includes("<app>"));
      assert.ok(!html.includes("chocolakit:"));

      const scopedCss = await fs.readFile(path.join(outDir, scoped), "utf-8");
      assert.ok(scopedCss.includes(".greeting[data-sc-"));

      assert.ok(
        (await listDir(path.join(outDir, "static"))).includes("hello.txt")
      );
      assert.ok((await listDir(path.join(outDir, "lib"))).includes("format.js"));
      assert.ok(await pathExists(path.join(outDir, "lib", "format.js")));
      assert.ok(!(await pathExists(path.join(outDir, "lib", "greeting.chjs"))));

      const hashText = await fs.readFile(
        path.join(root, ".chocola", "hashes.json"),
        "utf-8"
      );
      assert.ok(hashText.endsWith("\n"));
      const hashes = JSON.parse(hashText);
      assert.deepEqual(Object.keys(hashes), [
        "lib/action.chjs",
        "lib/card.chjs",
        "lib/counter.chjs",
        "lib/greeting.chjs",
        "pages/index.chjs",
      ]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("build works with zero config and stays warning-free", async () => {
    const { parent, root } = await makeZeroConfigFixture();
    try {
      const result = run(["build", root]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stderr.includes("WARNING!"), result.stderr);
      assert.ok(!result.stdout.includes("WARNING!"), result.stdout);

      const out = await listDir(path.join(root, "dist"));
      assert.ok(out.includes("index.html"));
      assert.ok(out.some((file) => /^sc-[a-z0-9]+\.css$/.test(file)));
      assert.ok(out.some((file) => /^run-[a-z0-9]+\.js$/.test(file)));
      assert.ok(await pathExists(path.join(root, ".chocola", "hashes.json")));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("--outDir overrides the config file output directory", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      const result = run(["build", root, "--outDir", "custom-out"]);
      assert.equal(result.status, 0, result.stderr);

      const custom = path.join(root, "custom-out");
      assert.ok((await listDir(custom)).includes("index.html"));
      assert.ok(!(await pathExists(path.join(root, "dist"))));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("--srcDir, --pagesDir, --appFile and --staticDir are honored", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      await fs.rename(path.join(root, "src", "app.html"), path.join(root, "src", "shell.html"));
      await fs.rename(path.join(root, "src", "pages"), path.join(root, "src", "routes"));
      await fs.rename(path.join(root, "src", "static"), path.join(root, "src", "assets"));

      const result = run([
        "build",
        root,
        "--pagesDir",
        "routes",
        "--appFile",
        "shell.html",
        "--staticDir",
        "assets",
      ]);
      assert.equal(result.status, 0, result.stderr);

      const outDir = path.join(root, "dist");
      const out = await listDir(outDir);
      assert.ok(out.includes("index.html"));
      assert.ok(out.includes("assets"));
      assert.ok(
        (await listDir(path.join(outDir, "assets"))).includes("hello.txt")
      );
      const html = await fs.readFile(path.join(outDir, "index.html"), "utf-8");
      assert.ok(html.includes("Hello World!"));
      assert.ok(!html.includes("chocolakit:"));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("--no-emptyOutDir preserves stale files while the default clears them", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      const outDir = path.join(root, "dist");
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, "stale.txt"), "keep me");

      const kept = run(["build", root, "--no-emptyOutDir"]);
      assert.equal(kept.status, 0, kept.stderr);
      assert.ok(await pathExists(path.join(outDir, "stale.txt")));
      assert.ok(await pathExists(path.join(outDir, "index.html")));

      const cleared = run(["build", root]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.ok(!(await pathExists(path.join(outDir, "stale.txt"))));
      assert.ok(await pathExists(path.join(outDir, "index.html")));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe("cli — config precedence", () => {
  test("--config picks an alternate config file", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      await fs.writeFile(
        path.join(root, "alt.json"),
        JSON.stringify({ bundle: { srcDir: "src", outDir: "alt_out" } })
      );

      const result = run(["build", root, "--config", "alt.json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        await pathExists(path.join(root, "alt_out", "index.html")),
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
      assert.ok(!(await pathExists(path.join(root, "dist"))));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("--config with a missing path fails with a clear error", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      const result = run(["build", root, "--config", "does-not-exist.json"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found|ENOENT/i);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe("cli — help, version and bad args", () => {
  test("--help exits 0 and lists the new build flags", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("chocola <command>"));
    assert.ok(result.stdout.includes("--pagesDir"));
    assert.ok(result.stdout.includes("--appFile"));
    assert.ok(result.stdout.includes("--staticDir"));
    assert.ok(result.stdout.includes("--no-emptyOutDir"));
  });

  test("--version prints the package version", async () => {
    const result = run(["--version"]);
    assert.equal(result.status, 0);
    const pkg = JSON.parse(
      await fs.readFile(path.join(__dirname, "..", "package.json"), "utf-8")
    );
    assert.ok(result.stdout.includes(pkg.version));
  });

  test("an unknown command exits 2", () => {
    const result = run(["badcommand"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown command: badcommand/);
  });
});

describe("cli — dev and serve stay alive", () => {
  test("dev starts on the requested port and keeps running", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      const port = await getFreePort();
      const result = run(["dev", root, "--port", String(port)], {
        timeout: 3000,
      });
      assert.equal(result.status, null, `dev exited early: ${result.stderr}`);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("serve honors the PORT environment override and keeps running", async () => {
    const { parent, root } = await makeFixtureCopy();
    try {
      const port = await getFreePort();
      const result = run(["serve", root], {
        timeout: 3000,
        env: { PORT: String(port) },
      });
      assert.equal(result.status, null, `serve exited early: ${result.stderr}`);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
