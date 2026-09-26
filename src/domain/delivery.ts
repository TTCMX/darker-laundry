// Which delivery fee rule applies to an order. Shared by the live quote in
// the browser and the server that stores the price.

import type { DeliveryFeeRule } from "./pricing/types.js";
import type { TenantSettings } from "./settings.js";

export interface ZoneLike {
  id: string;
  fee_cents: number;
  free_over_cents: number | null;
  min_order_cents: number | null;
  active: boolean;
}

export function deliveryRule(
  fulfillment: "delivery" | "walk_in",
  zone: ZoneLike | null,
  settings: TenantSettings,
): { rule: DeliveryFeeRule | null; min_order_cents: number | null } {
  if (fulfillment === "walk_in") return { rule: null, min_order_cents: null };
  if (zone && zone.active) {
    return {
      rule: { fee_cents: zone.fee_cents, free_over_cents: zone.free_over_cents },
      min_order_cents: zone.min_order_cents ?? settings.delivery.min_order_cents,
    };
  }
  return {
    rule: { fee_cents: settings.delivery.default_fee_cents, free_over_cents: settings.delivery.default_free_over_cents },
    min_order_cents: settings.delivery.min_order_cents,
  };
}
