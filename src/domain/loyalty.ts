// Loyalty program: optional and fully configured per tenant.
//
// Points are EARNED by the database when an order is delivered and fully paid
// (app.loyalty_settle), and REDEEMED in the pricing engine's "credits" stage.
// `pointsEarned` mirrors the database formula for previews; both are covered
// by the same cases in the unit and database tests.

import type { Cents } from "./money.js";

export interface LoyaltySettings {
  enabled: boolean;
  /** "amount": points per money spent. "orders": fixed points per order. */
  earn_mode: "amount" | "orders";
  /** amount mode: `points_per_step` points for every `step_cents` spent. */
  points_per_step: number;
  step_cents: Cents;
  /** orders mode: points for each completed order. */
  points_per_order: number;
  /** Orders below this total earn nothing (null = no minimum). */
  min_order_cents: Cents | null;
  /** Value of one point when redeemed, in cents. */
  point_value_cents: Cents;
  /** Minimum points per redemption. */
  min_redeem_points: number;
}

export const DEFAULT_LOYALTY: LoyaltySettings = {
  enabled: false,
  earn_mode: "amount",
  points_per_step: 1,
  step_cents: 1000,
  points_per_order: 10,
  min_order_cents: null,
  point_value_cents: 100,
  min_redeem_points: 0,
};

/** Points an order earns for a given total (money actually charged). */
export function pointsEarned(totalCents: Cents, s: LoyaltySettings): number {
  if (!s.enabled || totalCents <= 0) return 0;
  if (s.min_order_cents !== null && totalCents < s.min_order_cents) return 0;
  if (s.earn_mode === "orders") return Math.max(0, Math.floor(s.points_per_order));
  if (s.step_cents <= 0) return 0;
  return Math.floor(totalCents / s.step_cents) * Math.max(0, Math.floor(s.points_per_step));
}

/** Human description for settings and the tracking page. */
export function describeLoyalty(s: LoyaltySettings, money: (c: number) => string): string {
  const earn =
    s.earn_mode === "orders"
      ? `${s.points_per_order} puntos por cada orden`
      : `${s.points_per_step} ${s.points_per_step === 1 ? "punto" : "puntos"} por cada ${money(s.step_cents)}`;
  return `${earn}. Cada punto vale ${money(s.point_value_cents)}.`;
}
