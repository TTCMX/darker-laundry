// POST /api/webhooks/mercadopago?tenant=<id>
//
// Never trusts the notification body: it only carries an id. The payment is
// fetched from MercadoPago with the tenant's own credentials and recorded
// through an idempotent function, so replays and forged calls cannot add
// money or mark anything as paid.

import { handle, json } from "../_lib/http.js";
import { paymentProvider, tenantPaymentProvider } from "../_lib/providers/payments.js";
import { adminClient } from "../_lib/supabase.js";

export const POST = handle(async (request) => {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  const body = await request.json().catch(() => ({}));
  if (!tenantId) return json({ ignored: "missing tenant" });

  const db = adminClient();
  const online = await tenantPaymentProvider(db, tenantId);
  if (!online || online.provider.id !== paymentProvider("mercadopago").id) return json({ ignored: "not configured" });

  const notification = online.provider.parseWebhook({ headers: request.headers, query: url.searchParams, body }, online.credentials);
  if (!notification) return json({ ignored: "no data id" });

  const { data: seen } = await db
    .from("webhook_events")
    .select("id, processed_at")
    .eq("provider", "mercadopago")
    .eq("event_key", notification.event_key)
    .maybeSingle();
  if (seen?.processed_at) return json({ ok: true, replay: true });
  if (!seen) {
    await db.from("webhook_events").insert({
      provider: "mercadopago",
      event_key: notification.event_key,
      tenant_id: tenantId,
      payload: body,
    });
  }

  let result: unknown = { ignored: "not a payment" };
  let error: string | null = null;
  try {
    if (notification.payment_id) {
      const payment = await online.provider.fetchPayment(notification.payment_id, online.credentials);
      if (payment.external_reference) {
        const { data, error: dbError } = await db.rpc("svc_record_provider_payment", {
          p_tenant: tenantId,
          p_order: payment.external_reference,
          p_provider: "mercadopago",
          p_provider_payment_id: payment.id,
          p_status: payment.status,
          p_amount_cents: payment.amount_cents,
          p_raw: payment.raw,
        });
        if (dbError) throw new Error(dbError.message);
        result = data;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[webhook:mercadopago]", error);
  }

  await db
    .from("webhook_events")
    .update({ processed_at: error ? null : new Date().toISOString(), error })
    .eq("provider", "mercadopago")
    .eq("event_key", notification.event_key);

  // A 5xx makes MercadoPago retry later, which is what we want on failure.
  return json(error ? { ok: false } : { ok: true, result }, error ? 500 : 200);
});
