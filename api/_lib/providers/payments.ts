// Payment provider abstraction. The rest of the system only knows this
// interface; MercadoPago is the first implementation. Adding Stripe, Conekta
// or Clip means adding one file here, not touching orders or the ledger.

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "../http.js";
import { mercadoPago } from "./mercadopago.js";

export type ProviderPaymentStatus = "pending" | "succeeded" | "failed";

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  amount_cents: number;
  currency: string;
  /** Our order id, as sent when creating the link. */
  external_reference: string | null;
  raw: unknown;
}

export interface CreateLinkInput {
  order_id: string;
  order_number: number;
  amount_cents: number;
  currency: string;
  title: string;
  statement_descriptor?: string | null;
  notification_url: string;
  back_url: string;
  payer_email?: string | null;
}

export interface PaymentLink {
  url: string;
  provider_ref: string | null;
  expires_at: string | null;
}

export interface WebhookInput {
  headers: Headers;
  query: URLSearchParams;
  body: unknown;
}

export interface WebhookNotification {
  /** Unique id of the notification, for replay protection. */
  event_key: string;
  /** Present when the notification concerns a payment. */
  payment_id: string | null;
}

export interface PaymentProvider {
  id: string;
  createLink(input: CreateLinkInput, credentials: ProviderCredentials): Promise<PaymentLink>;
  fetchPayment(paymentId: string, credentials: ProviderCredentials): Promise<ProviderPayment>;
  parseWebhook(input: WebhookInput, credentials: ProviderCredentials): WebhookNotification | null;
  /** Checks credentials against the provider (used when saving settings). */
  verifyCredentials(credentials: ProviderCredentials): Promise<{ ok: boolean; account?: string }>;
}

export interface ProviderCredentials {
  access_token: string;
  webhook_secret?: string | null;
}

const PROVIDERS: Record<string, PaymentProvider> = { mercadopago: mercadoPago };

export function paymentProvider(id: string): PaymentProvider {
  const p = PROVIDERS[id];
  if (!p) throw new HttpError(400, `Unknown payment provider ${id}`);
  return p;
}

/** The tenant's enabled online payment provider and its credentials. */
export async function tenantPaymentProvider(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ provider: PaymentProvider; credentials: ProviderCredentials; config: Record<string, unknown> } | null> {
  const { data: integration } = await db
    .from("tenant_integrations")
    .select("provider, enabled, config")
    .eq("tenant_id", tenantId)
    .eq("provider", "mercadopago")
    .maybeSingle();
  if (!integration?.enabled) return null;
  const { data: secret } = await db
    .from("tenant_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider", integration.provider)
    .maybeSingle();
  const secrets = (secret?.secrets ?? {}) as Partial<ProviderCredentials>;
  if (!secrets.access_token) return null;
  return {
    provider: paymentProvider(integration.provider),
    credentials: { access_token: secrets.access_token, webhook_secret: secrets.webhook_secret ?? null },
    config: (integration.config ?? {}) as Record<string, unknown>,
  };
}
