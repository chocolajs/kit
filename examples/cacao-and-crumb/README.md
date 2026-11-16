# Cacao &amp; Crumb

A production-shaped storefront used to beta-test ChocolaKit. It is a real
multi-page app — catalog, product pages, journal, cart, checkout, account, and a
server-rendered contact form — not a feature checklist.

The point is to run it, click through it, deploy it behind a CDN, and find the
places where ChocolaKit gets in the way. Findings from building and exercising
it are recorded in [`../../BETA-TEST-FINDINGS.md`](../../BETA-TEST-FINDINGS.md).

## Quick start

```bash
# from this directory
npm run dev      # http://localhost:3100 (hot reload)
npm run build    # static site -> dist/
npm start        # http://127.0.0.1:4100 (SSR + middleware)
```

`npm test` at the repository root includes `tests/example.test.js`, which boots
this app through `createHandler` and covers the form, cart-validation, and
account flows.

## Routes

| Route | Rendering | Notes |
| --- | --- | --- |
| `/` | SSG | Hero, featured bars, journal teasers |
| `/shop` | SSG | Client-side search and tag filtering |
| `/shop/70-dark` | SSG | Product detail, add to cart |
| `/shop/milk-sea-salt` | SSG | |
| `/shop/hazelnut-praline` | SSG | |
| `/shop/citrus-nib` | SSG | |
| `/journal` | SSG | |
| `/journal/tempering` | SSG | Long-form article |
| `/journal/bean-to-bar` | SSG | Long-form article |
| `/about` | SSG | Team and visit info |
| `/contact` | SSR | POST handled by middleware, validation + cookie |
| `/account` | SSR | Personalized from a cookie; save/sign-out forms |
| `/cart` | SSR shell | Cart rendered from localStorage |
| `/checkout` | SSR | Server validates the cart cookie and computes the total |
| `/health` | SSG | Uptime check target |

Plus `/robots.txt`, `/sitemap.xml`, `/styles/base.css`, `/app.js`,
`/assets/*.svg`, and `/static/wholesale-sheet.txt`.

## Layout

```
chocola.config.json      dev :3100, serve :4100, middleware wiring
server-middleware.js     request context + contact/checkout/account handlers
src/app.html             document shell (static by design)
src/app.js               cart badge, listens for cartchange/storage
src/pages/               one .chjs file per route
src/lib/                 components + shared cart/catalog modules
src/styles/base.css      global styles
src/assets/              product art, favicon, OG image
src/static/              wholesale sheet (copied verbatim)
```

## What the app exercises

- **SSG + SSR on the same routes.** The same page files render to `dist/` for
  copy and to HTML per request in `serve` mode.
- **Middleware context.** `/account` is personalized from `cc_details` before
  rendering, with no flash of signed-out content.
- **Middleware short-circuiting.** `POST /contact`, `POST /checkout`, and
  `POST /account` redirect with `303` and `Set-Cookie`.
- **Server-side validation.** Checkout rejects missing fields and an empty cart;
  the order total is computed from the mirrored cart cookie, not the browser.
- **Client state.** Cart lives in `localStorage`, mirrored to a cookie for
  checkout validation; the badge updates from a custom `cartchange` event.
- **Component runtime.** `$runtime` powers add-to-cart, cart editing, search and
  tag filtering, and the checkout summary.
- **Metadata and accessibility.** Per-page title/description/OG tags, canonical
  URLs, one `h1` per page, labelled controls, skip link, keyboard focus styles,
  reduced-motion support, and a `noscript` fallback for the cart.

## Deliberate workarounds

These are places where the sample had to route around framework behaviour.
They exist to keep the app shippable, and each one is evidence for a finding.

- **Catalog content is literal markup.** Imported values are not visible to
  template expressions, and there is no loop directive, so product cards are
  written out in each page rather than generated from `products.js`.
- **The header is static.** `app.html` is compiled once, so the cart badge and
  account name cannot be server-rendered into the shell; the badge updates
  client-side after load.
- **Personalized HTML is kept out of shared caches by middleware.** The
  middleware asks for `Cache-Control: no-store` and `Vary: Cookie` on
  `/account`, `/cart`, and `/checkout` (the server currently overrides the
  first of those — see the findings).
- **Hidden conditional branches remain in the HTML.** `if` without `else`
  leaves the false branch in the document with `style="display:none"`, so the
  sample keeps those branches free of sensitive data.
- **The cart is cookie-mirrored.** `chocola dev` does not run middleware, so the
  cookie mirror is only exercised by `serve` and by the integration test.

## Notes

- Sample copy, prices, addresses, and email addresses are fictional.
- There is no payment processor. Submitting checkout records an order
  reference and total in a cookie.
- The only third-party code is whatever ChocolaKit already depends on; this
  sample adds no packages.
