// MercadoPago implementation of the payment provider interface.
// Docs: Checkout Pro preferences, Payments API and webhook signatures.

import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http.js";
import type { PaymentProvider, ProviderPaymentStatus } from "./payments.js";

const API = "https://api.mercadopago.com";

async function mpFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

const STATUS: Record<string, ProviderPaymentStatus> = {
  approved: "succeeded",
  authorized: "pending",
  pending: "pending",
  in_process: "pending",
  in_mediation: "pending",
  rejected: "failed",
  cancelled: "failed",
  // Refunds and chargebacks are recorded as refunds in the app by staff;
  // the original payment did happen.
  refunded: "succeeded",
  charged_back: "succeeded",
};

/**
 * Validates the "x-signature" header: HMAC-SHA256 over
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" with the webhook secret.
 */
export function verifyMercadoPagoSignature(
  headers: Headers,
  dataId: string,
  secret: string,
): boolean {
  const signature = headers.get("x-signature") ?? "";
  const requestId = headers.get("x-request-id") ?? "";
  const parts = Object.fromEntries(
    signature.split(",").map((p) => {
      const [k, ...v] = p.trim().split("=");
      return [k, v.join("=")];
    }),
  );
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const mercadoPago: PaymentProvider = {
  id: "mercadopago",

  async createLink(input, credentials) {
    const res = await mpFetch("/checkout/preferences", credentials.access_token, {
      method: "POST",
      headers: { "x-idempotency-key": `${input.order_id}:${input.amount_cents}:${Date.now()}` },
      body: JSON.stringify({
        items: [
          {
            id: input.order_id,
            title: input.title,
            quantity: 1,
            unit_price: input.amount_cents / 100,
            currency_id: input.currency,
          },
        ],
        external_reference: input.order_id,
        notification_url: input.notification_url,
        back_urls: { success: input.back_url, pending: input.back_url, failure: input.back_url },
        auto_return: "approved",
        binary_mode: true,
        statement_descriptor: input.statement_descriptor ?? undefined,
        payer: input.payer_email ? { email: input.payer_email } : undefined,
        // Cash vouchers take days to settle: keep them out of the link.
        payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] },
        expires: true,
        expiration_date_to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      console.error("[mercadopago] preference", res.status, data);
      throw new HttpError(502, "MercadoPago rejected the payment link");
    }
    return {
      url: String(data.init_point),
      provider_ref: data.id ? String(data.id) : null,
      expires_at: data.expiration_date_to ? String(data.expiration_date_to) : null,
    };
  },

  async fetchPayment(paymentId, credentials) {
    const res = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`, credentials.access_token);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new HttpError(502, `MercadoPago payment lookup failed (${res.status})`);
    return {
      id: String(data.id),
      status: STATUS[String(data.status)] ?? "pending",
      amount_cents: Math.round(Number(data.transaction_amount ?? 0) * 100),
      currency: String(data.currency_id ?? ""),
      external_reference: data.external_reference ? String(data.external_reference) : null,
      raw: {
        id: data.id,
        status: data.status,
        status_detail: data.status_detail,
        payment_type_id: data.payment_type_id,
        transaction_amount: data.transaction_amount,
        date_approved: data.date_approved,
      },
    };
  },

  parseWebhook({ headers, query, body }, credentials) {
    const b = (body ?? {}) as { type?: string; topic?: string; action?: string; data?: { id?: string | number }; id?: string | number };
    const type = b.type ?? b.topic ?? query.get("type") ?? query.get("topic");
    const dataId = String(b.data?.id ?? query.get("data.id") ?? query.get("id") ?? "");
    if (!dataId) return null;
    if (credentials.webhook_secret && !verifyMercadoPagoSignature(headers, dataId, credentials.webhook_secret)) {
      throw new HttpError(401, "Invalid webhook signature");
    }
    const requestId = headers.get("x-request-id");
    return {
      event_key: requestId ? `req:${requestId}` : `${type}:${b.action ?? ""}:${dataId}:${b.id ?? ""}`,
      payment_id: type === "payment" ? dataId : null,
    };
  },

  async verifyCredentials(credentials) {
    const res = await mpFetch("/users/me", credentials.access_token);
    if (!res.ok) return { ok: false };
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: true, account: String(data.nickname ?? data.email ?? data.id ?? "") };
  },
};
