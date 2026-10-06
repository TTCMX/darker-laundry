// POST /api/notifications/send — staff sends one queued email now
// (manual-mode templates, or a retry of a failed one).
import { renderNotification } from "../../src/domain/notifications.js";
import { requireMember, requirePermission, requireUser } from "../_lib/auth.js";
import { env } from "../_lib/env.js";
import { handle, HttpError, json, readJson } from "../_lib/http.js";
import { tenantNotificationProviders } from "../_lib/providers/notifications.js";
import { adminClient } from "../_lib/supabase.js";

export const POST = handle(async (request) => {
  const user = await requireUser(request);
  const { tenant_id, notification_id } = await readJson<{ tenant_id: string; notification_id: string }>(request);
  const member = await requireMember(user.id, tenant_id);
  requirePermission(member, "notifications.send");

  const db = adminClient();
  const { data: n } = await db
    .from("notifications")
    .select("id, channel, recipient, subject_template, body_template, variables, attempts, status")
    .eq("id", notification_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (!n) throw new HttpError(404, "Notification not found");
  if (!["pending", "failed"].includes(n.status)) throw new HttpError(409, "Already processed");

  const provider = (await tenantNotificationProviders(db, tenant_id))[n.channel];
  if (!provider) throw new HttpError(409, `No provider configured for ${n.channel}`);

  const { data: claimed } = await db
    .from("notifications")
    .update({ status: "sending", attempts: n.attempts + 1, claimed_at: new Date().toISOString() })
    .eq("id", n.id)
    .in("status", ["pending", "failed"])
    .select("id");
  if (!claimed?.length) throw new HttpError(409, "Already being sent");

  const { data: tenant } = await db.from("tenants").select("name, email").eq("id", tenant_id).single();
  const { subject, body } = renderNotification(n, env.appUrl);
  try {
    const r = await provider.send({ to: n.recipient, subject: subject || tenant!.name, body, from_name: tenant!.name, reply_to: tenant!.email });
    await db
      .from("notifications")
      .update({ status: "sent", sent_at: new Date().toISOString(), sent_by: user.id, provider_message_id: r.provider_message_id, last_error: null })
      .eq("id", n.id);
    return json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("notifications").update({ status: "failed", last_error: message.slice(0, 500) }).eq("id", n.id);
    throw new HttpError(502, "The email could not be sent");
  }
});
