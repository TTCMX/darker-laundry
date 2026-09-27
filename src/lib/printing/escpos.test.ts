import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { buildReceipt, CMD, layout, row, toAscii, wrap, type ReceiptDoc } from "./escpos";
import { composeReceipt, type ReceiptInput } from "./receipt";

const doc: ReceiptDoc = {
  title: "Lavandería Sol",
  header: ["Tel. 555"],
  info: ["Orden #7"],
  items: [{ left: "Lavado por kilo", right: "$157.50", detail: "4.5 kg x $35.00" }],
  totals: [{ left: "Total", right: "$157.50", bold: true }],
  sections: [[{ left: "Efectivo", right: "$100.00" }], []],
  notes: [],
  footer: ["¡Gracias!"],
};

const bytesOf = (a: readonly number[]) => a.join(",");
const contains = (hay: Uint8Array, needle: readonly number[]) => Array.from(hay).join(",").includes(bytesOf(needle));

describe("escpos", () => {
  it("prints plain ASCII", () => {
    expect(toAscii("Recolección ¡Gracias! Año · “hola”")).toBe('Recoleccion Gracias! Ano - "hola"');
    expect(toAscii("$1,234.50 MXN")).toBe("$1,234.50 MXN");
  });

  it("aligns amounts to the paper width and wraps long labels", () => {
    expect(row("Total", "$10.00", 32)).toEqual(["Total" + " ".repeat(21) + "$10.00"]);
    const long = row("Edredón matrimonial con tratamiento antimanchas", "$180.00", 32);
    expect(long.every((l) => l.length <= 32)).toBe(true);
    expect(long[long.length - 1]!.endsWith("$180.00")).toBe(true);
    expect(wrap("supercalifragilisticoespialidoso-extra-largo", 10).every((l) => l.length <= 10)).toBe(true);
  });

  it("never exceeds the paper width", () => {
    for (const width of [32, 48] as const) {
      for (const l of layout(doc, width)) {
        if ("text" in l) expect(l.text.length).toBeLessThanOrEqual(l.big ? width / 2 : width);
      }
    }
  });

  it("builds the same command stream as the internal app", () => {
    const bytes = buildReceipt(doc);
    expect(Array.from(bytes.slice(0, 2))).toEqual([...CMD.INIT]);
    expect(contains(bytes, CMD.BIG)).toBe(true);
    expect(contains(bytes, CMD.BOLD)).toBe(true);
    expect(Array.from(bytes.slice(-4))).toEqual([...CMD.CUT]);
    expect(Array.from(bytes).every((b) => b < 128)).toBe(true);
  });

  it("adds a QR only when asked", () => {
    const qr = [0x1d, 0x28, 0x6b];
    expect(contains(buildReceipt(doc), qr)).toBe(false);
    expect(contains(buildReceipt({ ...doc, qr: "https://x.test/t/abc" }), qr)).toBe(true);
  });
});

describe("composeReceipt", () => {
  const base: ReceiptInput = {
    business: { name: "Lavandería Sol", phone: "555" },
    settings: DEFAULT_SETTINGS.receipts,
    loyaltySettings: { ...DEFAULT_SETTINGS.loyalty, enabled: true, points_per_step: 1, step_cents: 1000 },
    order: {
      number: 7,
      status: "created",
      fulfillment: "walk_in",
      created_at: "2026-09-27T10:00:00Z",
      promised_at: null,
      notes: "Sin suavizante",
      total_cents: 15000,
      amount_paid_cents: 5000,
      balance_cents: 10000,
      pricing: {
        points_redeemed: 0,
        tax_mode: "none",
        tax_rate_percent: 16,
        tax_included_cents: 0,
        steps: [
          { key: "list_subtotal", label: "Subtotal", amount_cents: 15000 },
          { key: "total", label: "Total", amount_cents: 15000 },
        ],
      } as never,
    },
    customer: { name: "Ana" },
    items: [{ name: "Lavado", quantity: 3, unit: "kg", unit_price_cents: 5000, list_total_cents: 15000, notes: null }],
    payments: [
      { kind: "payment", method: "cash", status: "succeeded", amount_cents: 5000 },
      { kind: "payment", method: "online", status: "pending", amount_cents: 10000 },
    ],
    loyalty: { earned: 0, balance: 40 },
    trackingUrl: "https://app.test/t/abc",
    printedAt: new Date("2026-09-27T10:05:00Z"),
    fmt: { money: (c) => `$${(c / 100).toFixed(2)}`, dateTime: (iso) => iso.slice(0, 16), qty: String, unit: (u) => u },
  };
  const text = (d: ReceiptDoc) => layout(d).map((l) => ("text" in l ? l.text : `[QR ${l.qr}]`)).join("\n");

  it("uses the stored breakdown and shows only settled payments", () => {
    const t = text(composeReceipt(base));
    expect(t).toContain("Orden #7");
    expect(t).toMatch(/Total\s+\$150\.00/);
    expect(t).not.toContain("Subtotal"); // same as total: skipped
    expect(t).toMatch(/Efectivo\s+\$50\.00/);
    expect(t).not.toContain("Pago en linea");
    expect(t).toMatch(/Por cobrar\s+\$100\.00/);
    expect(t).toMatch(/Puntos a ganar\s+15/);
    expect(t).toMatch(/Tus puntos\s+40/);
    expect(t).toContain("Notas: Sin suavizante");
    expect(t).toContain("https://app.test/t/abc");
  });

  it("handles orders without items and paid orders", () => {
    const empty = text(composeReceipt({ ...base, items: [], order: { ...base.order, total_cents: 0, balance_cents: 0, pricing: null } }));
    expect(empty).toContain("Registraremos tus prendas");
    expect(empty).not.toContain("Por cobrar");
    const paid = text(composeReceipt({ ...base, order: { ...base.order, amount_paid_cents: 15000, balance_cents: 0 } }));
    expect(paid).toContain("PAGADO");
  });

  it("respects the ticket settings", () => {
    const d = composeReceipt({
      ...base,
      settings: { ...base.settings, tracking_qr: true, show_loyalty: false, annotation_space: true, footer: "Vuelve pronto" },
    });
    expect(d.qr).toBe("https://app.test/t/abc");
    expect(d.annotationSpace).toBe(true);
    const t = text(d);
    expect(t).not.toContain("puntos");
    expect(t).toContain("Vuelve pronto");
  });
});
