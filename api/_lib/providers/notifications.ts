// Notification provider abstraction. Email goes through Resend; WhatsApp and
// SMS are sent by staff with one tap (click-to-chat) until a messaging
// provider is connected — adding one means implementing this interface.

import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeHtml } from "../../../src/domain/templates.js";
import { env } from "../env.js";

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  from_name: string;
  reply_to?: string | null;
}

export interface NotificationProvider {
  channel: "email" | "whatsapp" | "sms";
  send(message: OutgoingMessage): Promise<{ provider_message_id: string | null }>;
}

class ResendProvider implements NotificationProvider {
  channel = "email" as const;
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(m: OutgoingMessage) {
    // "Business Name <no-reply@domain>" keeps the verified address but shows the tenant's name.
    const address = this.from.match(/<([^>]+)>/)?.[1] ?? this.from;
    const html = `<div style="font-family:Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f1f1f">${escapeHtml(m.body)
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, "<br>")}</div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        from: `${m.from_name.replace(/[<>"]/g, "")} <${address}>`,
        to: [m.to],
        subject: m.subject,
        text: m.body,
        html,
        reply_to: m.reply_to ?? undefined,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message ?? "error"}`);
    return { provider_message_id: data.id ?? null };
  }
}

/** Providers able to send automatically for this tenant, by channel. */
export async function tenantNotificationProviders(
  db: SupabaseClient,
  tenantId: string,
): Promise<Partial<Record<string, NotificationProvider>>> {
  const providers: Partial<Record<string, NotificationProvider>> = {};
  const { data: secret } = await db
    .from("tenant_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider", "resend")
    .maybeSingle();
  const tenantKey = (secret?.secrets as { api_key?: string; from?: string } | undefined) ?? {};
  const apiKey = tenantKey.api_key ?? env.resendApiKey;
  const from = tenantKey.from ?? env.emailFrom;
  if (apiKey && from) providers.email = new ResendProvider(apiKey, from);
  return providers;
}
