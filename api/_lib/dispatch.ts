// Sends queued automatic notifications. Each row is claimed atomically
// (pending → sending) before sending, so concurrent runs never send twice.

import type { SupabaseClient } from "@supabase/supabase-js";
import { renderNotification } from "../../src/domain/notifications.js";
import { resolveSettings } from "../../src/domain/settings.js";
import { env } from "./env.js";
import { tenantNotificationProviders } from "./providers/notifications.js";

const MAX_ATTEMPTS = 3;

export async function dispatchTenant(db: SupabaseClient, tenantId: string, limit = 50) {
  const { data: tenant } = await db.from("tenants").select("name, email, settings").eq("id", tenantId).maybeSingle();
  if (!tenant) return { sent: 0, failed: 0 };
  const settings = resolveSettings(tenant.settings);
  const providers = await tenantNotificationProviders(db, tenantId);
  const channels = Object.keys(providers).filter((c) => (c === "email" ? settings.notifications.email_enabled : true));
  if (!channels.length) return { sent: 0, failed: 0 };

  const { data: queued } = await db
    .from("notifications")
    .select("id, channel, recipient, subject_template, body_template, variables, attempts")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .eq("mode", "auto")
    .in("channel", channels)
    .order("created_at")
    .limit(limit);

  let sent = 0;
  let failed = 0;
  for (const n of queued ?? []) {
    const { data: claimed } = await db
      .from("notifications")
      .update({ status: "sending", attempts: n.attempts + 1, claimed_at: new Date().toISOString() })
      .eq("id", n.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    const provider = providers[n.channel]!;
    const { subject, body } = renderNotification(n, env.appUrl);
    try {
      const r = await provider.send({
        to: n.recipient,
        subject: subject || tenant.name,
        body,
        from_name: tenant.name,
        reply_to: settings.notifications.reply_to ?? tenant.email,
      });
      await db
        .from("notifications")
        .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: r.provider_message_id, last_error: null })
        .eq("id", n.id);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .from("notifications")
        .update({ status: n.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending", last_error: message.slice(0, 500) })
        .eq("id", n.id);
      failed++;
    }
  }
  return { sent, failed };
}

export async function dispatchAll(db: SupabaseClient) {
  const { data } = await db.from("notifications").select("tenant_id").eq("status", "pending").eq("mode", "auto").limit(1000);
  const tenants = [...new Set((data ?? []).map((r) => r.tenant_id as string))];
  const results: Record<string, unknown> = {};
  for (const t of tenants) results[t] = await dispatchTenant(db, t);
  // Rows stuck in "sending" (a crashed run) go back to the queue; ones a run
  // claimed in the last 15 minutes may still be in flight.
  const stale = new Date(Date.now() - 15 * 60_000).toISOString();
  await db
    .from("notifications")
    .update({ status: "pending" })
    .eq("status", "sending")
    .or(`claimed_at.lt.${stale},and(claimed_at.is.null,created_at.lt.${stale})`);
  return results;
}
