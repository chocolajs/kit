// Catalog data shared by pages, components, and the client-side cart.
// Prices are integer cents so totals never accumulate float error.

export const SHIPPING_FLAT = 500;
export const FREE_SHIPPING_AT = 3500;

export const products = [
  {
    slug: "70-dark",
    name: "70% Dark",
    price: 900,
    origin: "Esmeraldas, Ecuador",
    note: "Dried cherry, cocoa nib, molasses",
    tags: ["dark", "single origin", "vegan"],
    tone: "#3b2317",
    art: "/assets/70-dark.svg",
    blurb:
      "Our house bar: a slow-roasted Nacional cacao, stone-ground for 48 hours and tempered to a clean snap.",
    ingredients: "Cacao beans, cane sugar, cocoa butter.",
  },
  {
    slug: "milk-sea-salt",
    name: "Milk & Sea Salt",
    price: 1100,
    origin: "Piura, Peru",
    note: "Caramel, fleur de sel, toasted milk",
    tags: ["milk", "best seller"],
    tone: "#a8764a",
    art: "/assets/milk-sea-salt.svg",
    blurb:
      "Forty-five percent milk chocolate finished with fleur de sel harvested in Guérande. Sweet, saline, impossible to share.",
    ingredients: "Cacao beans, cane sugar, cocoa butter, whole milk powder, sea salt.",
  },
  {
    slug: "hazelnut-praline",
    name: "Hazelnut Praline",
    price: 1200,
    origin: "Piedmont, Italy",
    note: "Roasted hazelnut, brown butter, vanilla",
    tags: ["praline", "nut", "gift"],
    tone: "#7a4a24",
    art: "/assets/hazelnut-praline.svg",
    blurb:
      "Piedmont hazelnuts roasted in-house, folded into a brown-butter praline and set in a 60% dark shell.",
    ingredients: "Cacao beans, cane sugar, cocoa butter, hazelnuts, butter, vanilla.",
  },
  {
    slug: "citrus-nib",
    name: "Citrus Nib",
    price: 1000,
    origin: "Esmeraldas, Ecuador",
    note: "Candied orange, cocoa nib, lemon peel",
    tags: ["dark", "vegan", "seasonal"],
    tone: "#8a5a1e",
    art: "/assets/citrus-nib.svg",
    blurb:
      "Candied orange and lemon peel steeped in cocoa butter, then scattered with toasted nibs for crunch.",
    ingredients: "Cacao beans, cane sugar, cocoa butter, orange peel, lemon peel, cocoa nibs.",
  },
];

export function findProduct(slug) {
  return products.find((product) => product.slug === slug) || null;
}

export const featuredSlugs = ["70-dark", "milk-sea-salt", "hazelnut-praline"];
