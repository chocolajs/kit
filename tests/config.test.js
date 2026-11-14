import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  DEFAULT_CONFIG,
  loadConfig,
  resolvePaths,
} from "../config.js";
import {
  getConfig,
  isMissingConfigFile,
  flushConfigWarnings,
} from "../utils.js";
import compileMultipage from "../routing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BASIC = path.join(__dirname, "fixtures", "basic");

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

async function captureWarnings(rootDir, fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(stripAnsi(args.join(" ")));
  try {
    await fn();
    flushConfigWarnings(rootDir);
  } finally {
    console.warn = original;
    flushConfigWarnings(rootDir);
  }
  return warns;
}

async function makeRoot(prefix = "chocola-config-", config = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  if (config !== null) {
    await fs.writeFile(
      path.join(root, "chocola.config.json"),
      JSON.stringify(config, null, 2)
    );
  }
  return root;
}

async function listDir(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe("config — defaults", () => {
  test("DEFAULT_CONFIG exposes frozen bundle, dev and server defaults", () => {
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
    assert.deepEqual(DEFAULT_CONFIG.bundle, {
      srcDir: "src",
      outDir: "dist",
      pagesDir: "pages",
      appFile: "app.html",
      staticDir: "static",
      emptyOutDir: true,
      treeShakeRuntime: true,
    });
    assert.deepEqual(DEFAULT_CONFIG.dev, { hostname: "localhost", port: 3000 });
    assert.deepEqual(DEFAULT_CONFIG.server, {
      hostname: "localhost",
      port: 8080,
      middleware: null,
    });
  });

  test("resolvePaths resolves every directory against the project root", () => {
    const root = path.resolve("example-root");
    const defaults = resolvePaths(root);
    assert.deepEqual(defaults, {
      rootDir: root,
      srcDir: path.join(root, "src"),
      outDir: path.join(root, "dist"),
      pagesDir: path.join(root, "src", "pages"),
      appFile: path.join(root, "src", "app.html"),
      staticDir: path.join(root, "src", "static"),
    });

    const custom = resolvePaths(root, {
      srcDir: "app",
      outDir: "public",
      pagesDir: "routes",
      appFile: "shell.html",
      staticDir: "assets",
    });
    assert.equal(custom.srcDir, path.join(root, "app"));
    assert.equal(custom.outDir, path.join(root, "public"));
    assert.equal(custom.pagesDir, path.join(root, "app", "routes"));
    assert.equal(custom.appFile, path.join(root, "app", "shell.html"));
    assert.equal(custom.staticDir, path.join(root, "app", "assets"));
  });
});

describe("config — zero-config (no chocola.config.json)", () => {
  test("getConfig flags a missing file and queues one top-level warning", async () => {
    const root = await makeRoot("chocola-cfg-missing-");
    try {
      let raw;
      const warns = await captureWarnings(root, async () => {
        raw = await getConfig(root);
      });
      assert.ok(isMissingConfigFile(raw));
      assert.deepEqual(
        Object.keys(raw).filter((key) => !key.startsWith("__")),
        []
      );
      assert.equal(
        warns.filter((warning) => warning.includes("chocola.config.json not found")).length,
        1
      );

      const again = await captureWarnings(root, async () => {
        await getConfig(root);
      });
      assert.equal(again.length, 0, "top-level warning is deduped per root");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("loadConfig returns Kit defaults and absolute paths", async () => {
    const root = await makeRoot("chocola-cfg-defaults-");
    try {
      const { config, paths, raw } = await loadConfig(root, { silent: true });
      assert.ok(isMissingConfigFile(raw));
      assert.equal(config.srcDir, path.join(root, "src"));
      assert.equal(config.outDir, path.join(root, "dist"));
      assert.equal(config.pagesDir, path.join(root, "src", "pages"));
      assert.equal(config.appFile, path.join(root, "src", "app.html"));
      assert.equal(config.staticDir, path.join(root, "src", "static"));
      assert.equal(config.emptyOutDir, true);
      assert.equal(config.treeShakeRuntime, true);
      assert.deepEqual(config.dev, { hostname: "localhost", port: 3000 });
      assert.deepEqual(config.server, {
        hostname: "localhost",
        port: 8080,
        middleware: null,
      });
      assert.deepEqual(paths, resolvePaths(root, config));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a zero-config site builds to dist with Kit defaults", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chocola-cfg-build-"));
    try {
      await fs.cp(path.join(FIXTURE_BASIC, "src"), path.join(root, "src"), {
        recursive: true,
      });
      await assert.rejects(
        () => fs.stat(path.join(root, "chocola.config.json")),
        /ENOENT/
      );

      const emitted = await compileMultipage(root);

      assert.ok(
        emitted.files.some((file) => /^sc-[a-z0-9]+\.css$/.test(file.path))
      );
      assert.ok(
        emitted.files.some((file) => /^run-[a-z0-9]+\.js$/.test(file.path))
      );

      const outDir = path.join(root, "dist");
      const out = await listDir(outDir);
      assert.ok(out.includes("index.html"));
      assert.ok(out.includes("styles.css"));
      assert.ok(out.includes("static"));

      const hashes = JSON.parse(
        await fs.readFile(path.join(root, ".chocola", "hashes.json"), "utf-8")
      );
      assert.deepEqual(Object.keys(hashes), [
        "lib/action.chjs",
        "lib/card.chjs",
        "lib/counter.chjs",
        "lib/greeting.chjs",
        "pages/index.chjs",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("config — warning hierarchy", () => {
  test("an existing empty config warns bundle, dev and server blocks", async () => {
    const root = await makeRoot("chocola-cfg-empty-", {});
    try {
      const warns = await captureWarnings(root, async () => {
        await loadConfig(root);
      });
      assert.ok(warns.some((warning) => warning.includes("bundle config not defined")));
      assert.ok(warns.some((warning) => warning.includes("dev config not defined")));
      assert.ok(warns.some((warning) => warning.includes("server config not defined")));
      assert.ok(!warns.some((warning) => warning.includes("not found")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a bundle-only config warns dev and server but not bundle", async () => {
    const root = await makeRoot("chocola-cfg-bundle-", {
      bundle: { srcDir: "src", outDir: "dist" },
    });
    try {
      const warns = await captureWarnings(root, async () => {
        await loadConfig(root);
      });
      assert.ok(!warns.some((warning) => warning.includes("bundle config not defined")));
      assert.ok(warns.some((warning) => warning.includes("dev config not defined")));
      assert.ok(warns.some((warning) => warning.includes("server config not defined")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a missing config file warns only at the top level", async () => {
    const root = await makeRoot("chocola-cfg-nofile-");
    try {
      const warns = await captureWarnings(root, async () => {
        await getConfig(root);
        await loadConfig(root);
      });
      assert.ok(warns.some((warning) => warning.includes("not found")));
      assert.ok(
        !warns.some(
          (warning) =>
            warning.includes("bundle config") ||
            warning.includes("dev config") ||
            warning.includes("server config")
        )
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("silent mode suppresses queued warnings", async () => {
    const root = await makeRoot("chocola-cfg-silent-", {});
    try {
      const warns = await captureWarnings(root, async () => {
        await loadConfig(root, { silent: true });
      });
      assert.deepEqual(warns, []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("libDir warns once and is removed from the resolved config", async () => {
    const root = await makeRoot("chocola-cfg-libdir-", {
      bundle: { srcDir: "src", outDir: "dist" },
      libDir: "components",
    });
    try {
      const warns = await captureWarnings(root, async () => {
        const { config } = await loadConfig(root);
        assert.equal(config.libDir, undefined);
        await loadConfig(root);
      });
      assert.equal(
        warns.filter((warning) => warning.includes("libDir is deprecated")).length,
        1
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("bundle.libDir also warns and drops libDir", async () => {
    const root = await makeRoot("chocola-cfg-libdir-bundle-", {
      bundle: { srcDir: "src", outDir: "dist", libDir: "components" },
    });
    try {
      const warns = await captureWarnings(root, async () => {
        const { config } = await loadConfig(root);
        assert.equal(config.libDir, undefined);
      });
      assert.ok(warns.some((warning) => warning.includes("libDir is deprecated")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("config — loading and precedence", () => {
  test("config values merge over defaults and resolve against the root", async () => {
    const root = await makeRoot("chocola-cfg-merge-", {
      bundle: {
        srcDir: "app",
        outDir: "public",
        pagesDir: "routes",
        appFile: "shell.html",
        staticDir: "assets",
        emptyOutDir: false,
      },
      dev: { port: 4000 },
      server: { hostname: "0.0.0.0", port: 9000 },
    });
    try {
      const { config } = await loadConfig(root, { silent: true });
      assert.equal(config.srcDir, path.join(root, "app"));
      assert.equal(config.outDir, path.join(root, "public"));
      assert.equal(config.pagesDir, path.join(root, "app", "routes"));
      assert.equal(config.appFile, path.join(root, "app", "shell.html"));
      assert.equal(config.staticDir, path.join(root, "app", "assets"));
      assert.equal(config.emptyOutDir, false);
      assert.equal(config.treeShakeRuntime, true);
      assert.deepEqual(config.dev, { hostname: "localhost", port: 4000 });
      assert.deepEqual(config.server, {
        hostname: "0.0.0.0",
        port: 9000,
        middleware: null,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("build is accepted as an alias for bundle", async () => {
    const root = await makeRoot("chocola-cfg-buildalias-", {
      build: { srcDir: "app", outDir: "public" },
    });
    try {
      const { config } = await loadConfig(root, { silent: true });
      assert.equal(config.srcDir, path.join(root, "app"));
      assert.equal(config.outDir, path.join(root, "public"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("CLI overrides win over the config file for every bundle key", async () => {
    const root = await makeRoot("chocola-cfg-overrides-", {
      bundle: {
        srcDir: "src",
        outDir: "dist",
        pagesDir: "pages",
        appFile: "app.html",
        staticDir: "static",
        emptyOutDir: true,
      },
      dev: { hostname: "config-host", port: 4000 },
      server: { hostname: "config-server", port: 9000, middleware: "mw.js" },
    });
    try {
      const { config } = await loadConfig(root, {
        silent: true,
        overrides: {
          srcDir: "app",
          outDir: "public",
          pagesDir: "routes",
          appFile: "shell.html",
          staticDir: "assets",
          emptyOutDir: false,
          dev: { port: 4100 },
          server: { hostname: "override-server" },
        },
      });

      assert.equal(config.srcDir, path.join(root, "app"));
      assert.equal(config.outDir, path.join(root, "public"));
      assert.equal(config.pagesDir, path.join(root, "app", "routes"));
      assert.equal(config.appFile, path.join(root, "app", "shell.html"));
      assert.equal(config.staticDir, path.join(root, "app", "assets"));
      assert.equal(config.emptyOutDir, false);
      assert.equal(config.dev.port, 4100);
      assert.equal(config.dev.hostname, "config-host");
      assert.equal(config.server.hostname, "override-server");
      assert.equal(config.server.port, 9000);
      assert.equal(config.server.middleware, "mw.js");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("nested overrides.bundle and overrides.build are honored", async () => {
    const root = await makeRoot("chocola-cfg-nested-", {});
    try {
      const viaBundle = await loadConfig(root, {
        silent: true,
        overrides: { bundle: { outDir: "out-bundle" } },
      });
      assert.equal(viaBundle.config.outDir, path.join(root, "out-bundle"));

      const viaBuild = await loadConfig(root, {
        silent: true,
        overrides: { build: { outDir: "out-build" } },
      });
      assert.equal(viaBuild.config.outDir, path.join(root, "out-build"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("customPath loads an alternate config file relative to the root", async () => {
    const root = await makeRoot("chocola-cfg-custom-", {
      bundle: { srcDir: "src", outDir: "dist" },
    });
    try {
      await fs.writeFile(
        path.join(root, "alt.json"),
        JSON.stringify({ bundle: { outDir: "alt_out" } })
      );
      const { config, paths, raw } = await loadConfig(root, {
        silent: true,
        customPath: "alt.json",
      });
      assert.equal(raw.outDir, undefined);
      assert.equal(config.outDir, path.join(root, "alt_out"));
      assert.equal(config.srcDir, path.join(root, "src"));
      assert.equal(paths.outDir, path.join(root, "alt_out"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("unknown top-level keys are preserved for consumers", async () => {
    const root = await makeRoot("chocola-cfg-extras-", {
      bundle: { srcDir: "src", outDir: "dist" },
      siteName: "Chocola",
    });
    try {
      const { config } = await loadConfig(root, { silent: true });
      assert.equal(config.siteName, "Chocola");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
