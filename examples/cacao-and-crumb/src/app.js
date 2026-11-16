import { CART_KEY, cartTotals, readCart } from "/lib/cart.js";

const badge = document.getElementById("cart-count");

function renderBadge() {
  if (!badge) return;
  const { count } = cartTotals(readCart());
  badge.textContent = String(count);
  badge.hidden = count === 0;
  const link = badge.closest(".cart-link");
  if (link) {
    link.setAttribute(
      "aria-label",
      count === 0 ? "Cart, empty" : `Cart, ${count} item${count === 1 ? "" : "s"}`
    );
  }
}

function onCartChange() {
  renderBadge();
}

renderBadge();
window.addEventListener("cartchange", onCartChange);
window.addEventListener("storage", (event) => {
  if (event.key === CART_KEY) renderBadge();
});
