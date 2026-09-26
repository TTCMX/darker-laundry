import type { SupabaseClient } from "@supabase/supabase-js";
import { trackingUrl } from "../../src/domain/notifications.js";
import { env } from "./env.js";
import { HttpError } from "./http.js";
import { tenantPaymentProvider } from "./providers/payments.js";

/**
 * Creates a payment link for the current balance of an order. The amount
 * always comes from the database, never from the request.
 */
export async function createPaymentLink(db: SupabaseClient, tenantId: string, orderId: string, actorId: string | null) {
  const { data: order } = await db
    .from("orders")
    .select("id, number, status, balance_cents, public_token, customers(email), tenants(name, currency)")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!order) throw new HttpError(404, "Order not found");
  if (order.status === "cancelled") throw new HttpError(422, "The order is cancelled");
  const balance = Number(order.balance_cents);
  if (balance <= 0) throw new HttpError(409, "The order has no balance to pay");

  const online = await tenantPaymentProvider(db, tenantId);
  if (!online) throw new HttpError(409, "Online payments are not configured");

  // Reuse a live link for the same amount instead of creating duplicates.
  const { data: existing } = await db
    .from("payment_links")
    .select("url, amount_cents, expires_at")
    .eq("order_id", orderId)
    .eq("status", "active")
    .eq("amount_cents", balance)
    .gt("expires_at", new Date(Date.now() + 3_600_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return { url: existing.url, amount_cents: balance };

  const tenant = order.tenants as unknown as { name: string; currency: string };
  const customer = order.customers as unknown as { email: string | null } | null;
  const link = await online.provider.createLink(
    {
      order_id: order.id,
      order_number: Number(order.number),
      amount_cents: balance,
      currency: tenant.currency,
      title: `${tenant.name} · Orden #${order.number}`,
      statement_descriptor: (online.config.statement_descriptor as string | undefined) ?? null,
      notification_url: `${env.appUrl}/api/webhooks/${online.provider.id}?tenant=${tenantId}`,
      back_url: trackingUrl(env.appUrl, order.public_token),
      payer_email: customer?.email ?? null,
    },
    online.credentials,
  );

  await db.from("payment_links").insert({
    tenant_id: tenantId,
    order_id: order.id,
    provider: online.provider.id,
    provider_ref: link.provider_ref,
    url: link.url,
    amount_cents: balance,
    created_by: actorId,
    expires_at: link.expires_at,
  });
  return { url: link.url, amount_cents: balance };
}
