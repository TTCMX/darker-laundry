// POST /api/payments/link — staff creates a payment link for an order.
import { requireMember, requirePermission, requireUser } from "../_lib/auth.js";
import { handle, json, readJson } from "../_lib/http.js";
import { createPaymentLink } from "../_lib/payment-links.js";
import { adminClient } from "../_lib/supabase.js";

export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const body = await readJson<{ tenant_id: string; order_id: string }>(request);
  const member = await requireMember(user.id, body.tenant_id);
  requirePermission(member, "payments.record", "notifications.send");
  const link = await createPaymentLink(adminClient(), body.tenant_id, body.order_id, user.id);
  return json(link);
});
