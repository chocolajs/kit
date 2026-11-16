import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

import { createHandler } from "../server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(__dirname, "..", "examples", "cacao-and-crumb");

function request(baseUrl, pathname, opts = {}) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: opts.method || "GET", headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: raw.toString("utf-8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const form = { "content-type": "application/x-www-form-urlencoded" };

const PAGES = [
  "/",
  "/shop",
  "/shop/70-dark",
  "/shop/milk-sea-salt",
  "/shop/hazelnut-praline",
  "/shop/citrus-nib",
  "/cart",
  "/checkout",
  "/about",
  "/contact",
  "/account",
  "/journal",
  "/journal/tempering",
  "/journal/bean-to-bar",
  "/health",
];

describe("example: cacao-and-crumb storefront", () => {
  let server;
  let baseUrl;

  before(async () => {
    const handler = await createHandler(EXAMPLE, { silent: true });
    server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("renders every page route", async () => {
    for (const route of PAGES) {
      const res = await request(baseUrl, route);
      assert.equal(res.status, 200, `${route} should render`);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.text, /<html lang="en">/);
    }
  });

  test("serves static and generated assets", async () => {
    for (const asset of [
      "/styles/base.css",
      "/app.js",
      "/assets/70-dark.svg",
      "/robots.txt",
      "/sitemap.xml",
      "/static/wholesale-sheet.txt",
    ]) {
      const res = await request(baseUrl, asset);
      assert.equal(res.status, 200, `${asset} should be served`);
    }
  });

  test("404s unknown routes", async () => {
    const res = await request(baseUrl, "/no-such-page");
    assert.equal(res.status, 404);
  });

  test("middleware adds security headers to page routes", async () => {
    const res = await request(baseUrl, "/shop");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
  });

  test("contact form stores details and pre-fills the account page", async () => {
    const post = await request(baseUrl, "/contact", {
      method: "POST",
      headers: form,
      body: "name=Ada+Byron&email=ada%40example.com&message=Two+seats+please",
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, "/contact?sent=1");
    const cookie = post.headers["set-cookie"]?.[0];
    assert.ok(cookie, "contact POST should set the details cookie");
    assert.match(cookie, /^cc_details=/);
    assert.match(cookie, /HttpOnly/);

    const account = await request(baseUrl, "/account", {
      headers: { cookie: cookie.split(";")[0] },
    });
    assert.equal(account.status, 200);
    assert.match(account.text, /Hello, Ada Byron/);
    assert.match(account.text, /ada@example\.com/);
  });

  test("contact form rejects invalid input", async () => {
    const post = await request(baseUrl, "/contact", {
      method: "POST",
      headers: form,
      body: "name=Ada&email=not-an-email&message=hi",
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, "/contact?error=validation");
  });

  test("checkout refuses an empty cart", async () => {
    const post = await request(baseUrl, "/checkout", {
      method: "POST",
      headers: form,
      body: "name=Ada&email=ada%40example.com&address=1+Main&city=Portland&postal=97214",
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, "/checkout?error=empty");
  });

  test("checkout accepts a cart and records the server-computed total", async () => {
    const cart = encodeURIComponent(
      JSON.stringify([{ slug: "70-dark", quantity: 4 }])
    );
    const post = await request(baseUrl, "/checkout", {
      method: "POST",
      headers: { ...form, cookie: `cc_cart=${cart}` },
      body: "name=Ada&email=ada%40example.com&address=1+Main&city=Portland&postal=97214",
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, "/checkout?placed=1");

    const cookie = post.headers["set-cookie"][0].split(";")[0];
    const details = JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)));
    assert.match(details.lastOrder, /^CC-/);
    assert.equal(details.lastTotal, "$36.00");

    const page = await request(baseUrl, "/checkout?placed=1", {
      headers: { cookie },
    });
    assert.match(page.text, /\$36\.00/);
  });

  test("account sign-out clears the details cookie", async () => {
    const post = await request(baseUrl, "/account", {
      method: "POST",
      headers: {
        ...form,
        cookie: `cc_details=${encodeURIComponent(
          JSON.stringify({ name: "Ada", email: "ada@example.com" })
        )}`,
      },
      body: "action=signout",
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, "/account?signedOut=1");
    assert.match(post.headers["set-cookie"][0], /cc_details=;.*Max-Age=0/);
  });
});
