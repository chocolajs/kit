// Production-shaped middleware for Cacao & Crumb.
//
// Two functions, run in order for every matched SSR route:
//   1. request context  — security headers + cookie-derived account data
//   2. POST handlers    — contact form, checkout, account save/sign-out
//
// Everything is cookie-based on purpose: this sample has no database and no
// sessions, but it does exercise the request/response lifecycle that a real
// deployment uses.

import { CART_COOKIE, cartLines, cartTotals, formatMoney } from "./src/lib/cart.js";

const DETAILS_COOKIE = "cc_details";
const MAX_BODY_BYTES = 16 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // Ignore an undecodable cookie instead of failing the request.
    }
  }
  return out;
}

function readCartCookie(cookies) {
  const raw = cookies[CART_COOKIE];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDetails(cookies) {
  const raw = cookies[DETAILS_COOKIE];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function isSecure(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return proto === "https";
}

function setDetails(req, res, details) {
  const value = encodeURIComponent(JSON.stringify(details));
  const parts = [
    `${DETAILS_COOKIE}=${value}`,
    "Path=/",
    "Max-Age=31536000",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (isSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearDetails(res) {
  res.setHeader(
    "Set-Cookie",
    `${DETAILS_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`
  );
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

/**
 * Read the request body without buffering past the limit. Extra bytes are
 * drained so the socket can still finish cleanly before the redirect.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge };
}

function text(form, key, max) {
  return String(form.get(key) || "")
    .trim()
    .slice(0, max);
}

function orderReference() {
  const stamp = Date.now().toString(36).toUpperCase();
  return `CC-${stamp.slice(-5)}`;
}

export default [
  // 1) Context middleware. Sets headers and derives account state from the
  //    cookie so the first painted page is already correct.
  ({ req, res, cookies, pathname }) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(), camera=(), microphone=(), payment=()"
    );

    // Pages that depend on cookies must never be stored by a shared cache.
    if (["/account", "/cart", "/checkout"].includes(pathname)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Cookie");
    }

    const details = parseDetails(cookies);
    const name = typeof details.name === "string" ? details.name : "";
    const email = typeof details.email === "string" ? details.email : "";

    return {
      signedIn: Boolean(name),
      name,
      email,
      lastOrder: typeof details.lastOrder === "string" ? details.lastOrder : "None yet",
      lastTotal: typeof details.lastTotal === "string" ? details.lastTotal : "",
    };
  },

  // 2) Form handlers. Only POSTs, only the three form routes.
  async (req, res) => {
    if (req.method !== "POST") return;

    const host = req.headers.host || "localhost";
    const pathname = new URL(req.url, `http://${host}`).pathname.replace(/\/+$/, "") || "/";
    if (!["/contact", "/checkout", "/account"].includes(pathname)) return;

    const { text: body, tooLarge } = await readBody(req);
    if (tooLarge) {
      redirect(res, `${pathname}?error=payload`);
      return;
    }

    const form = new URLSearchParams(body);
    const cookies = parseCookies(req);
    // The context middleware already parsed the cookie; re-parse here so the
    // handler does not depend on return-value ordering.
    const details = parseDetails(cookies);

    if (pathname === "/contact") {
      const name = text(form, "name", 80);
      const email = text(form, "email", 160);
      const message = text(form, "message", 4000);

      if (!name || !EMAIL.test(email) || !message) {
        redirect(res, "/contact?error=validation");
        return;
      }

      setDetails(req, res, { ...details, name, email });
      redirect(res, "/contact?sent=1");
      return;
    }

    if (pathname === "/checkout") {
      const name = text(form, "name", 80);
      const email = text(form, "email", 160);
      const address = text(form, "address", 160);
      const city = text(form, "city", 80);
      const postal = text(form, "postal", 24);

      if (!name || !EMAIL.test(email) || !address || !city || !postal) {
        redirect(res, "/checkout?error=validation");
        return;
      }

      const lines = cartLines(readCartCookie(cookies));
      if (lines.length === 0) {
        redirect(res, "/checkout?error=empty");
        return;
      }

      const totals = cartTotals(readCartCookie(cookies));
      setDetails(req, res, {
        ...details,
        name,
        email,
        lastOrder: orderReference(),
        lastTotal: formatMoney(totals.total),
      });
      redirect(res, "/checkout?placed=1");
      return;
    }

    if (pathname === "/account") {
      const action = text(form, "action", 16);

      if (action === "signout") {
        clearDetails(res);
        redirect(res, "/account?signedOut=1");
        return;
      }

      const name = text(form, "name", 80);
      const email = text(form, "email", 160);
      if (!name || !EMAIL.test(email)) {
        redirect(res, "/account?error=validation");
        return;
      }

      setDetails(req, res, { ...details, name, email });
      redirect(res, "/account?saved=1");
      return;
    }
  },
];
