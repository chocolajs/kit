// Cart storage and arithmetic. Deliberately DOM-free so it runs unchanged on
// the server (imported by page scripts) and in the browser (runtime chunks).

import {
  FREE_SHIPPING_AT,
  SHIPPING_FLAT,
  findProduct,
} from "./products.js";

export const CART_KEY = "cc_cart_v1";
export const CART_COOKIE = "cc_cart";

// Mirror the cart into a plain cookie so server-side checkout can validate that
// something is actually being ordered. localStorage stays the source of truth
// for the UI; the cookie is only a checked-in copy.
function syncCartCookie(items) {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${CART_COOKIE}=${encodeURIComponent(
      JSON.stringify(items)
    )}; Path=/; Max-Age=2592000; SameSite=Lax`;
  } catch {
    // Cookies disabled — checkout will fall back to its empty-cart error.
  }
}

function storageOrNull(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function normalizeCart(raw) {
  if (!Array.isArray(raw)) return [];
  const merged = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry.slug !== "string") continue;
    if (!findProduct(entry.slug)) continue;
    const quantity = Math.max(0, Math.min(99, Math.trunc(Number(entry.quantity) || 0)));
    if (!quantity) continue;
    merged.set(entry.slug, Math.min(99, (merged.get(entry.slug) || 0) + quantity));
  }
  return [...merged].map(([slug, quantity]) => ({ slug, quantity }));
}

export function readCart(storage) {
  const store = storageOrNull(storage);
  if (!store) return [];
  try {
    return normalizeCart(JSON.parse(store.getItem(CART_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function writeCart(items, storage) {
  const store = storageOrNull(storage);
  const normalized = normalizeCart(items);
  if (store) {
    store.setItem(CART_KEY, JSON.stringify(normalized));
  }
  syncCartCookie(normalized);
  return normalized;
}

function mutate(storage, fn) {
  const next = fn(readCart(storage));
  writeCart(next, storage);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("cartchange", { detail: { items: next } }));
  }
  return next;
}

export function addToCart(slug, quantity = 1, storage) {
  return mutate(storage, (items) => {
    const existing = items.find((item) => item.slug === slug);
    if (existing) existing.quantity += quantity;
    else items.push({ slug, quantity });
    return items;
  });
}

export function setQuantity(slug, quantity, storage) {
  return mutate(storage, (items) => {
    const next = items
      .map((item) => (item.slug === slug ? { ...item, quantity } : item))
      .filter((item) => item.quantity > 0);
    return next;
  });
}

export function removeFromCart(slug, storage) {
  return mutate(storage, (items) => items.filter((item) => item.slug !== slug));
}

export function clearCart(storage) {
  return mutate(storage, () => []);
}

export function cartLines(items) {
  return normalizeCart(items)
    .map(({ slug, quantity }) => {
      const product = findProduct(slug);
      if (!product) return null;
      return {
        product,
        quantity,
        lineTotal: product.price * quantity,
      };
    })
    .filter(Boolean);
}

export function cartTotals(items) {
  const lines = cartLines(items);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const shipping = count === 0 || subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING_FLAT;
  return {
    count,
    subtotal,
    shipping,
    total: subtotal + shipping,
    freeShippingAt: FREE_SHIPPING_AT,
    shippingFlat: SHIPPING_FLAT,
    toFreeShipping: Math.max(0, FREE_SHIPPING_AT - subtotal),
  };
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatMoney(cents) {
  return money.format((Number(cents) || 0) / 100);
}
