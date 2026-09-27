import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAGES,
  PricingError,
  quote,
  type Discount,
  type PricingContext,
  type PricingInput,
  type PricingProduct,
  type VolumeRule,
} from "./index.js";

const NOW = new Date("2026-06-15T12:00:00Z");

const product = (p: Partial<PricingProduct> & { id: string; base_price_cents: number }): PricingProduct => ({
  sku: p.id.toUpperCase(),
  name: p.id,
  unit: "piece",
  category_id: null,
  taxable: true,
  variable_price: false,
  active: true,
  ...p,
});

const discount = (d: Partial<Discount> & { id: string; kind: Discount["kind"]; value: number }): Discount => ({
  name: d.id,
  code: null,
  product_ids: [],
  category_ids: [],
  min_order_cents: null,
  max_discount_cents: null,
  starts_at: null,
  ends_at: null,
  usage_limit: null,
  usage_count: 0,
  active: true,
  ...d,
});

const PRODUCTS = [
  product({ id: "wash", base_price_cents: 3500, unit: "kg", category_id: "laundry" }),
  product({ id: "shirt", base_price_cents: 4500, category_id: "laundry" }),
  product({ id: "sneakers", base_price_cents: 15000, unit: "pair", category_id: "shoes" }),
  product({ id: "repair", base_price_cents: 0, variable_price: true, category_id: "other" }),
  product({ id: "old", base_price_cents: 1000, active: false }),
];

// Same shape as the legacy public price list: exact packages for 1–5 pairs and
// $100 each from six on.
const SNEAKER_VOLUME: VolumeRule = {
  id: "vol-sneakers",
  name: "Sneakers by volume",
  active: true,
  product_id: "sneakers",
  category_id: null,
  priority: 0,
  starts_at: null,
  ends_at: null,
  config: {
    packages: [
      { qty: 1, total_cents: 15000 },
      { qty: 2, total_cents: 28000 },
      { qty: 3, total_cents: 39000 },
      { qty: 4, total_cents: 48000 },
      { qty: 5, total_cents: 55000 },
    ],
    tiers: [{ min_qty: 6, unit_price_cents: 10000 }],
  },
};

const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  products: PRODUCTS,
  volume_rules: [SNEAKER_VOLUME],
  discounts: [],
  tax: { mode: "none", rate_percent: 0, delivery_fee_taxable: false },
  settings: { stages: DEFAULT_STAGES, discount_stacking: "parallel" },
  ...over,
});

const input = (over: Partial<PricingInput> = {}): PricingInput => ({
  items: [],
  discount_ids: [],
  delivery: null,
  now: NOW,
  ...over,
});

describe("base price", () => {
  it("multiplies unit price by quantity, including fractional kg", () => {
    const r = quote(input({ items: [{ product_id: "wash", quantity: 4.5 }] }), ctx());
    expect(r.lines[0]!.list_total_cents).toBe(15750);
    expect(r.total_cents).toBe(15750);
  });

  it("requires a price for variable-price products and ad-hoc lines", () => {
    expect(() => quote(input({ items: [{ product_id: "repair", quantity: 1 }] }), ctx())).toThrow(PricingError);
    const r = quote(
      input({
        items: [
          { product_id: "repair", quantity: 2, unit_price_cents: 12000 },
          { product_id: null, name: "Stain removal", quantity: 1, unit_price_cents: 5000 },
        ],
      }),
      ctx(),
    );
    expect(r.total_cents).toBe(29000);
    expect(r.lines[1]!.name).toBe("Stain removal");
    expect(r.lines.every((l) => l.custom_price)).toBe(true);
  });

  it("ignores a client-sent price for catalog products", () => {
    const r = quote(input({ items: [{ product_id: "shirt", quantity: 1, unit_price_cents: 1 }] }), ctx());
    expect(r.total_cents).toBe(4500);
  });

  it("rejects unknown, inactive products and non-positive quantities", () => {
    expect(() => quote(input({ items: [{ product_id: "nope", quantity: 1 }] }), ctx())).toThrow(/not found/);
    expect(() => quote(input({ items: [{ product_id: "old", quantity: 1 }] }), ctx())).toThrow(/inactive/);
    expect(() => quote(input({ items: [{ product_id: "shirt", quantity: 0 }] }), ctx())).toThrow(/quantity/);
    expect(() => quote(input({ items: [{ product_id: "shirt", quantity: -1 }] }), ctx())).toThrow(/quantity/);
  });
});

describe("volume pricing", () => {
  const sneakers = (n: number) => quote(input({ items: [{ product_id: "sneakers", quantity: n }] }), ctx());

  it("uses exact packages", () => {
    expect([1, 2, 3, 4, 5].map((n) => sneakers(n).total_cents)).toEqual([15000, 28000, 39000, 48000, 55000]);
  });

  it("uses the unit tier from its minimum quantity", () => {
    expect(sneakers(6).total_cents).toBe(60000);
    expect(sneakers(13).total_cents).toBe(130000);
    expect(sneakers(6).volume_savings_cents).toBe(30000);
  });

  it("never makes a line more expensive than list price", () => {
    const cheap = ctx({ products: PRODUCTS.map((p) => (p.id === "sneakers" ? { ...p, base_price_cents: 9000 } : p)) });
    const r = quote(input({ items: [{ product_id: "sneakers", quantity: 2 }] }), cheap);
    expect(r.total_cents).toBe(18000);
    expect(r.lines[0]!.volume_rule_id).toBeNull();
  });

  it("packages only apply to whole quantities; tiers apply to any quantity", () => {
    const kgRule: VolumeRule = {
      ...SNEAKER_VOLUME,
      id: "vol-kg",
      product_id: "wash",
      config: { packages: [{ qty: 3, total_cents: 9000 }], tiers: [{ min_qty: 10, unit_price_cents: 3000 }] },
    };
    const c = ctx({ volume_rules: [kgRule] });
    expect(quote(input({ items: [{ product_id: "wash", quantity: 3 }] }), c).total_cents).toBe(9000);
    expect(quote(input({ items: [{ product_id: "wash", quantity: 3.5 }] }), c).total_cents).toBe(12250);
    expect(quote(input({ items: [{ product_id: "wash", quantity: 12.5 }] }), c).total_cents).toBe(37500);
  });

  it("category rules apply, product rules win over category rules", () => {
    const categoryRule: VolumeRule = {
      ...SNEAKER_VOLUME,
      id: "vol-shoes",
      product_id: null,
      category_id: "shoes",
      priority: 100,
      config: { tiers: [{ min_qty: 1, unit_price_cents: 5000 }] },
    };
    const both = ctx({ volume_rules: [categoryRule, SNEAKER_VOLUME] });
    expect(quote(input({ items: [{ product_id: "sneakers", quantity: 2 }] }), both).total_cents).toBe(28000);
    const onlyCategory = ctx({ volume_rules: [categoryRule] });
    expect(quote(input({ items: [{ product_id: "sneakers", quantity: 2 }] }), onlyCategory).total_cents).toBe(10000);
  });

  it("respects rule activity and date windows", () => {
    const inactive = ctx({ volume_rules: [{ ...SNEAKER_VOLUME, active: false }] });
    expect(quote(input({ items: [{ product_id: "sneakers", quantity: 6 }] }), inactive).total_cents).toBe(90000);
    const future = ctx({ volume_rules: [{ ...SNEAKER_VOLUME, starts_at: "2026-07-01T00:00:00Z" }] });
    expect(quote(input({ items: [{ product_id: "sneakers", quantity: 6 }] }), future).total_cents).toBe(90000);
  });

  it("does not apply to custom-price lines", () => {
    const r = quote(input({ items: [{ product_id: "repair", quantity: 6, unit_price_cents: 20000 }] }), ctx());
    expect(r.total_cents).toBe(120000);
  });
});

describe("discounts", () => {
  const items = [
    { product_id: "wash", quantity: 10 }, // 35000
    { product_id: "shirt", quantity: 2 }, // 9000
  ];

  it("applies a percentage to the whole order", () => {
    const r = quote(
      input({ items, discount_ids: ["d10"] }),
      ctx({ discounts: [discount({ id: "d10", kind: "percentage", value: 10 })] }),
    );
    expect(r.discount_cents).toBe(4400);
    expect(r.total_cents).toBe(39600);
  });

  it("applies a fixed amount, capped at the eligible amount", () => {
    const c = ctx({ discounts: [discount({ id: "f", kind: "fixed", value: 100000 })] });
    const r = quote(input({ items, discount_ids: ["f"] }), c);
    expect(r.discount_cents).toBe(44000);
    expect(r.total_cents).toBe(0);
  });

  it("restricts discounts to products or categories", () => {
    const c = ctx({
      discounts: [
        discount({ id: "shirts", kind: "percentage", value: 50, product_ids: ["shirt"] }),
        discount({ id: "laundry", kind: "fixed", value: 1000, category_ids: ["shoes"] }),
      ],
    });
    const r = quote(input({ items, discount_ids: ["shirts", "laundry"] }), c);
    expect(r.applied_discounts.map((d) => d.amount_cents)).toEqual([4500]);
    expect(r.rejected_discounts).toEqual([{ id: "laundry", reason: "no_eligible_items" }]);
    expect(r.lines[1]!.discount_cents).toBe(4500);
    expect(r.lines[0]!.discount_cents).toBe(0);
  });

  it("parallel stacking computes each discount on the pre-discount price", () => {
    const c = ctx({
      discounts: [
        discount({ id: "a", kind: "percentage", value: 20 }),
        discount({ id: "b", kind: "percentage", value: 15 }),
      ],
    });
    const r = quote(input({ items: [{ product_id: "shirt", quantity: 10 }], discount_ids: ["a", "b"] }), c);
    expect(r.discount_cents).toBe(15750); // 35% of 45000
  });

  it("sequential stacking computes each discount on what is left", () => {
    const c = ctx({
      settings: { stages: DEFAULT_STAGES, discount_stacking: "sequential" },
      discounts: [
        discount({ id: "a", kind: "percentage", value: 20 }),
        discount({ id: "b", kind: "percentage", value: 15 }),
      ],
    });
    const r = quote(input({ items: [{ product_id: "shirt", quantity: 10 }], discount_ids: ["a", "b"] }), c);
    // 20% then 15% of the remaining 80% = 32%, not 35%.
    expect(r.discount_cents).toBe(14400);
  });

  it("caps percentage discounts with max_discount", () => {
    const c = ctx({ discounts: [discount({ id: "p", kind: "percentage", value: 50, max_discount_cents: 5000 })] });
    expect(quote(input({ items, discount_ids: ["p"] }), c).discount_cents).toBe(5000);
  });

  it("stacked discounts never exceed the eligible amount", () => {
    const c = ctx({
      discounts: [
        discount({ id: "a", kind: "percentage", value: 80 }),
        discount({ id: "b", kind: "percentage", value: 80 }),
      ],
    });
    const r = quote(input({ items, discount_ids: ["a", "b"] }), c);
    expect(r.total_cents).toBe(0);
    expect(r.lines.every((l) => l.net_cents >= 0)).toBe(true);
  });

  it("rejects discounts that are inactive, out of window, used up or below minimum", () => {
    const c = ctx({
      discounts: [
        discount({ id: "inactive", kind: "fixed", value: 100, active: false }),
        discount({ id: "future", kind: "fixed", value: 100, starts_at: "2027-01-01T00:00:00Z" }),
        discount({ id: "past", kind: "fixed", value: 100, ends_at: "2026-01-01T00:00:00Z" }),
        discount({ id: "used", kind: "fixed", value: 100, usage_limit: 5, usage_count: 5 }),
        discount({ id: "min", kind: "fixed", value: 100, min_order_cents: 1_000_000 }),
      ],
    });
    const r = quote(input({ items, discount_ids: ["inactive", "future", "past", "used", "min", "ghost"] }), c);
    expect(r.discount_cents).toBe(0);
    expect(r.rejected_discounts.map((x) => x.reason)).toEqual([
      "inactive",
      "not_started",
      "expired",
      "usage_limit",
      "min_order",
      "not_found",
    ]);
  });

  it("ignores duplicated discount ids", () => {
    const c = ctx({ discounts: [discount({ id: "f", kind: "fixed", value: 1000 })] });
    expect(quote(input({ items, discount_ids: ["f", "f"] }), c).discount_cents).toBe(1000);
  });

  it("discounts apply after volume pricing", () => {
    const c = ctx({ discounts: [discount({ id: "p", kind: "percentage", value: 15 })] });
    const r = quote(input({ items: [{ product_id: "sneakers", quantity: 13 }], discount_ids: ["p"] }), c);
    expect(r.subtotal_cents).toBe(130000);
    expect(r.total_cents).toBe(110500);
  });
});

describe("delivery fee", () => {
  const items = [{ product_id: "shirt", quantity: 2 }]; // 9000

  it("is added and never discounted", () => {
    const c = ctx({ discounts: [discount({ id: "all", kind: "percentage", value: 100 })] });
    const r = quote(input({ items, discount_ids: ["all"], delivery: { fee_cents: 5000, free_over_cents: null } }), c);
    expect(r.delivery_fee_cents).toBe(5000);
    expect(r.total_cents).toBe(5000);
  });

  it("is waived when the discounted subtotal reaches the threshold", () => {
    const free = quote(input({ items, delivery: { fee_cents: 5000, free_over_cents: 9000 } }), ctx());
    expect(free.delivery_fee_cents).toBe(0);
    expect(free.delivery_fee_waived).toBe(true);

    const c = ctx({ discounts: [discount({ id: "d", kind: "fixed", value: 100 })] });
    const notFree = quote(
      input({ items, discount_ids: ["d"], delivery: { fee_cents: 5000, free_over_cents: 9000 } }),
      c,
    );
    expect(notFree.delivery_fee_cents).toBe(5000);
  });

  it("can be overridden by staff", () => {
    const r = quote(
      input({ items, delivery: { fee_cents: 5000, free_over_cents: null }, delivery_fee_override_cents: 0 }),
      ctx(),
    );
    expect(r.delivery_fee_cents).toBe(0);
  });
});

describe("orders without items", () => {
  it("price to zero, with no delivery fee until items are captured", () => {
    const r = quote(input({ items: [], delivery: { fee_cents: 5000, free_over_cents: null } }), ctx());
    expect(r.total_cents).toBe(0);
    expect(r.delivery_fee_cents).toBe(0);
    expect(r.lines).toEqual([]);
    expect(r.steps.map((s) => s.key)).toEqual(["list_subtotal", "total"]);
  });
});

describe("tax", () => {
  const items = [
    { product_id: "shirt", quantity: 2 }, // 9000
    { product_id: null, name: "Tip jar", quantity: 1, unit_price_cents: 1000 },
  ];

  it("exclusive mode adds tax on taxable lines and optionally delivery", () => {
    const c = ctx({ tax: { mode: "exclusive", rate_percent: 16, delivery_fee_taxable: true } });
    const r = quote(input({ items, delivery: { fee_cents: 5000, free_over_cents: null } }), c);
    expect(r.tax_cents).toBe(Math.round((9000 + 1000 + 5000) * 0.16));
    expect(r.total_cents).toBe(15000 + r.tax_cents);
  });

  it("exclusive mode taxes the discounted amount", () => {
    const c = ctx({
      tax: { mode: "exclusive", rate_percent: 16, delivery_fee_taxable: false },
      discounts: [discount({ id: "half", kind: "percentage", value: 50 })],
    });
    const r = quote(input({ items: [{ product_id: "shirt", quantity: 2 }], discount_ids: ["half"] }), c);
    expect(r.tax_cents).toBe(720);
    expect(r.total_cents).toBe(5220);
  });

  it("inclusive mode reports contained tax without changing the total", () => {
    const c = ctx({ tax: { mode: "inclusive", rate_percent: 16, delivery_fee_taxable: false } });
    const r = quote(input({ items: [{ product_id: "shirt", quantity: 2 }] }), c);
    expect(r.total_cents).toBe(9000);
    expect(r.tax_cents).toBe(0);
    expect(r.tax_included_cents).toBe(9000 - Math.round(9000 / 1.16));
  });
});

describe("stages", () => {
  it("rejects invalid stage configurations", () => {
    const bad = (stages: PricingContext["settings"]["stages"]) =>
      quote(input(), ctx({ settings: { stages, discount_stacking: "parallel" } }));
    expect(() => bad(["discounts", "volume", "tax"])).toThrow(/first/);
    expect(() => bad(["volume", "tax", "discounts"])).toThrow(/last/);
    expect(() => bad(["volume", "discounts", "discounts", "tax"])).toThrow(/Duplicated/);
  });

  it("delivery before discounts compares the threshold with the pre-discount subtotal", () => {
    const c = ctx({
      settings: { stages: ["volume", "delivery_fee", "discounts", "tax"], discount_stacking: "parallel" },
      discounts: [discount({ id: "d", kind: "fixed", value: 100 })],
    });
    const r = quote(
      input({
        items: [{ product_id: "shirt", quantity: 2 }],
        discount_ids: ["d"],
        delivery: { fee_cents: 5000, free_over_cents: 9000 },
      }),
      c,
    );
    expect(r.delivery_fee_cents).toBe(0);
  });
});

describe("invariants", () => {
  // Deterministic pseudo-random generator so failures are reproducible.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it("breakdown always adds up to the total, to the cent", () => {
    const discounts = [
      discount({ id: "p7", kind: "percentage", value: 7 }),
      discount({ id: "p33", kind: "percentage", value: 33.3 }),
      discount({ id: "f", kind: "fixed", value: 1234 }),
      discount({ id: "shoes", kind: "percentage", value: 12, category_ids: ["shoes"] }),
    ];
    for (let i = 0; i < 500; i++) {
      const ids = ["wash", "shirt", "sneakers"];
      const items = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
        const id = ids[Math.floor(rand() * ids.length)]!;
        const qty = id === "wash" ? Math.round(rand() * 200) / 10 + 0.1 : 1 + Math.floor(rand() * 9);
        return { product_id: id, quantity: qty };
      });
      const chosen = discounts.filter(() => rand() < 0.4).map((d) => d.id);
      const r = quote(
        input({
          items,
          discount_ids: chosen,
          delivery: rand() < 0.5 ? { fee_cents: 4900, free_over_cents: rand() < 0.5 ? 50000 : null } : null,
        }),
        ctx({
          discounts,
          settings: { stages: DEFAULT_STAGES, discount_stacking: rand() < 0.5 ? "parallel" : "sequential" },
          tax: { mode: rand() < 0.5 ? "exclusive" : "none", rate_percent: 16, delivery_fee_taxable: rand() < 0.5 },
        }),
      );
      const lineNet = r.lines.reduce((s, l) => s + l.net_cents, 0);
      expect(lineNet).toBe(r.subtotal_cents - r.discount_cents);
      expect(r.applied_discounts.reduce((s, d) => s + d.amount_cents, 0)).toBe(r.discount_cents);
      expect(r.total_cents).toBe(r.subtotal_cents - r.discount_cents + r.delivery_fee_cents + r.tax_cents);
      const stepsSum = r.steps.filter((s) => s.key !== "total").reduce((s, x) => s + x.amount_cents, 0);
      expect(stepsSum).toBe(r.total_cents);
      expect(r.lines.every((l) => l.net_cents >= 0 && Number.isInteger(l.net_cents))).toBe(true);
    }
  });
});
