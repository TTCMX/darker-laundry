// POST /api/orders/save — create or re-price an order.
//
// The price is always computed here with the shared pricing engine, from the
// catalog in the database; the client only sends what was ordered. The
// resulting breakdown is stored with the order and is what the customer sees.

import { deliveryRule, type ZoneLike } from "../../src/domain/delivery.js";
import { PricingError, quote, type PricingItemInput } from "../../src/domain/pricing/index.js";
import { requireMember, requirePermission, requireUser } from "../_lib/auth.js";
import { fromDbError, handle, HttpError, json, readJson } from "../_lib/http.js";
import { loadPricingContext, loadTenant } from "../_lib/pricing-context.js";
import { adminClient } from "../_lib/supabase.js";

interface SaveOrderBody {
  tenant_id: string;
  order: {
    id?: string | null;
    customer_id: string;
    fulfillment?: "delivery" | "walk_in";
    priority?: "normal" | "high" | "urgent";
    promised_at?: string | null;
    notes?: string | null;
    internal_notes?: string | null;
    pickup_address_id?: string | null;
    delivery_address_id?: string | null;
    delivery_zone_id?: string | null;
  };
  items: PricingItemInput[];
  discount_ids?: string[];
  delivery_fee_override_cents?: number | null;
  points_to_redeem?: number | null;
}

export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const body = await readJson<SaveOrderBody>(request);
  const member = await requireMember(user.id, body.tenant_id);
  requirePermission(member, body.order?.id ? "orders.edit" : "orders.create");

  if (!body.order?.customer_id) throw new HttpError(422, "customer_id is required");
  // Items may be empty: pickups are often booked before knowing what the
  // customer will send. They are captured when the laundry is received.
  if (!Array.isArray(body.items)) throw new HttpError(422, "items must be a list");
  if (body.items.length > 200) throw new HttpError(422, "Too many items");

  const db = adminClient();
  const tenant = await loadTenant(db, body.tenant_id);
  const ctx = await loadPricingContext(db, tenant, body.order.id ?? null);
  const fulfillment = body.order.fulfillment ?? "delivery";

  // Zone: explicit, or the one of the delivery address.
  let zoneId = body.order.delivery_zone_id ?? null;
  if (!zoneId && body.order.delivery_address_id) {
    const { data } = await db
      .from("customer_addresses")
      .select("zone_id")
      .eq("id", body.order.delivery_address_id)
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    zoneId = data?.zone_id ?? null;
  }
  let zone: ZoneLike | null = null;
  if (zoneId) {
    const { data } = await db
      .from("delivery_zones")
      .select("id, fee_cents, free_over_cents, min_order_cents, active")
      .eq("id", zoneId)
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    zone = data
      ? {
          ...data,
          fee_cents: Number(data.fee_cents),
          free_over_cents: data.free_over_cents === null ? null : Number(data.free_over_cents),
          min_order_cents: data.min_order_cents === null ? null : Number(data.min_order_cents),
        }
      : null;
  }
  const { rule, min_order_cents } = deliveryRule(fulfillment, zone, tenant.settings);

  const hasOverride = body.delivery_fee_override_cents !== null && body.delivery_fee_override_cents !== undefined;
  if (hasOverride) requirePermission(member, "orders.price_override");

  // Loyalty: the customer can only use points they have (this order's own
  // redemption is given back first when editing).
  const pointsRequested = Math.max(0, Math.floor(Number(body.points_to_redeem) || 0));
  if (pointsRequested > 0) {
    const { data: ledger, error: ledgerError } = await db
      .from("loyalty_transactions").select("points, order_id, kind").eq("tenant_id", tenant.id).eq("customer_id", body.order.customer_id);
    if (ledgerError) throw ledgerError;
    const available = (ledger ?? [])
      .filter((t) => !(body.order.id && t.order_id === body.order.id && t.kind === "redeem"))
      .reduce((sum, t) => sum + Number(t.points), 0);
    if (pointsRequested > available) throw new HttpError(422, "not enough loyalty points", "points");
  }

  let pricing;
  try {
    pricing = quote(
      {
        items: body.items.map((i) => ({
          product_id: i.product_id ?? null,
          quantity: Number(i.quantity),
          unit_price_cents: i.unit_price_cents ?? null,
          name: i.name ?? null,
          notes: i.notes ?? null,
        })),
        discount_ids: body.discount_ids ?? [],
        delivery: rule,
        delivery_fee_override_cents: hasOverride ? body.delivery_fee_override_cents : null,
        points_to_redeem: pointsRequested,
        now: new Date(),
      },
      ctx,
    );
  } catch (err) {
    if (err instanceof PricingError) throw new HttpError(422, err.message, err.code);
    throw err;
  }

  if (
    body.items.length > 0 &&
    min_order_cents !== null &&
    pricing.subtotal_cents - pricing.discount_cents < min_order_cents &&
    !member.permissions.has("orders.price_override")
  ) {
    throw new HttpError(422, "The order is below the minimum for delivery", "min_order");
  }

  const { data, error } = await db.rpc("svc_save_order", {
    p_actor: user.id,
    p_tenant: tenant.id,
    p_order: {
      ...body.order,
      fulfillment,
      delivery_zone_id: zone?.id ?? null,
      delivery_fee_override: hasOverride,
    },
    p_pricing: pricing,
  });
  const dbError = fromDbError(error);
  if (dbError) throw dbError;

  return json({ order: data, pricing });
});
