// POST /api/public/pay — the customer pays the balance from the tracking page.
// Authorized by the order's unguessable tracking token.
import { handle, HttpError, json, readJson } from "../_lib/http.js";
import { createPaymentLink } from "../_lib/payment-links.js";
import { adminClient } from "../_lib/supabase.js";

export const POST = handle(async (request) => {
  const { token } = await readJson<{ token?: string }>(request);
  if (!token || token.length < 32) throw new HttpError(400, "Invalid link");
  const db = adminClient();
  const { data: order } = await db.from("orders").select("id, tenant_id").eq("public_token", token).maybeSingle();
  if (!order) throw new HttpError(404, "Order not found");
  const link = await createPaymentLink(db, order.tenant_id, order.id, null);
  return json(link);
});
