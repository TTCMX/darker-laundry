// Loads everything the pricing engine needs for one tenant, from the
// database, with the service role. The browser loads the same rows (through
// RLS) for its live quote; the server result is the one that is stored.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Discount, PricingContext, PricingProduct, VolumeRule } from "../../src/domain/pricing/index.js";
import { resolveSettings, type TenantSettings } from "../../src/domain/settings.js";
import { HttpError } from "./http.js";

export interface TenantRow {
  id: string;
  name: string;
  currency: string;
  country: string;
  timezone: string;
  phone: string | null;
  email: string | null;
  settings: TenantSettings;
}

export async function loadTenant(db: SupabaseClient, tenantId: string): Promise<TenantRow> {
  const { data, error } = await db
    .from("tenants")
    .select("id, name, currency, country, timezone, phone, email, settings")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Business not found");
  return { ...data, settings: resolveSettings(data.settings) } as TenantRow;
}

/** `excludeOrderId`: when re-pricing an order, its own discount usage does not count against limits. */
export async function loadPricingContext(
  db: SupabaseClient,
  tenant: TenantRow,
  excludeOrderId?: string | null,
): Promise<PricingContext> {
  let usageQuery = db
    .from("order_discounts")
    .select("discount_id, orders!inner(status)")
    .eq("tenant_id", tenant.id)
    .neq("orders.status", "cancelled");
  if (excludeOrderId) usageQuery = usageQuery.neq("order_id", excludeOrderId);

  const [products, rules, discounts, usage] = await Promise.all([
    db
      .from("products")
      .select("id, sku, name, unit, category_id, base_price_cents, taxable, variable_price, active")
      .eq("tenant_id", tenant.id),
    db
      .from("pricing_rules")
      .select("id, name, active, product_id, category_id, priority, starts_at, ends_at, config")
      .eq("tenant_id", tenant.id)
      .eq("active", true),
    db
      .from("discounts")
      .select(
        "id, name, code, kind, value, product_ids, category_ids, min_order_cents, max_discount_cents, starts_at, ends_at, usage_limit, active",
      )
      .eq("tenant_id", tenant.id),
    usageQuery,
  ]);
  for (const r of [products, rules, discounts, usage]) if (r.error) throw r.error;

  const usageCount = new Map<string, number>();
  for (const u of usage.data ?? []) usageCount.set(u.discount_id, (usageCount.get(u.discount_id) ?? 0) + 1);

  return {
    products: (products.data ?? []).map((p) => ({ ...p, base_price_cents: Number(p.base_price_cents) }) as PricingProduct),
    volume_rules: (rules.data ?? []) as VolumeRule[],
    discounts: (discounts.data ?? []).map(
      (d) =>
        ({
          ...d,
          value: Number(d.value),
          min_order_cents: d.min_order_cents === null ? null : Number(d.min_order_cents),
          max_discount_cents: d.max_discount_cents === null ? null : Number(d.max_discount_cents),
          usage_count: usageCount.get(d.id) ?? 0,
        }) as Discount,
    ),
    tax: tenant.settings.tax,
    settings: tenant.settings.pricing,
  };
}
