// Example ticket for the settings preview and the test print.

import type { TenantSettings } from "../../domain/settings";
import type { PricingResult } from "../../domain/pricing";
import { dateTime, money, qty, unitLabel } from "../format";
import type { TenantRow } from "../types";
import type { ReceiptDoc } from "./escpos";
import { composeReceipt } from "./receipt";

export function sampleReceipt(tenant: Pick<TenantRow, "name" | "legal_name" | "tax_id" | "phone" | "address">, settings: TenantSettings): ReceiptDoc {
  const now = new Date();
  const items = [
    { name: "Lavado por kilo", quantity: 4.5, unit: "kg", unit_price_cents: 3500, list_total_cents: 15750, notes: null },
    { name: "Edredón matrimonial", quantity: 1, unit: "piece", unit_price_cents: 18000, list_total_cents: 18000, notes: "Mancha en esquina" },
  ];
  const pricing = {
    points_redeemed: 0,
    tax_mode: settings.tax.mode,
    tax_rate_percent: settings.tax.rate_percent,
    tax_included_cents: settings.tax.mode === "inclusive" ? Math.round((33750 * settings.tax.rate_percent) / (100 + settings.tax.rate_percent)) : 0,
    steps: [
      { key: "list_subtotal", label: "Subtotal", amount_cents: 33750 },
      { key: "discount:sample", label: "Descuento de bienvenida", amount_cents: -3375 },
      { key: "total", label: "Total", amount_cents: 30375 },
    ],
  } as unknown as PricingResult;
  return composeReceipt({
    business: tenant,
    settings: settings.receipts,
    loyaltySettings: settings.loyalty,
    order: {
      number: 1024,
      status: "created",
      fulfillment: "walk_in",
      created_at: now.toISOString(),
      promised_at: new Date(now.getTime() + 48 * 3600_000).toISOString(),
      notes: null,
      total_cents: 30375,
      amount_paid_cents: 10000,
      balance_cents: 20375,
      pricing,
    },
    customer: { name: "Ana López", phone: "55 1234 5678" },
    items,
    payments: [{ kind: "payment", method: "cash", status: "succeeded", amount_cents: 10000 }],
    loyalty: settings.loyalty.enabled ? { earned: 0, balance: 120 } : null,
    trackingUrl: `${typeof window !== "undefined" ? window.location.origin : ""}/t/ejemplo`,
    printedAt: now,
    fmt: { money, dateTime, qty, unit: unitLabel },
  });
}
