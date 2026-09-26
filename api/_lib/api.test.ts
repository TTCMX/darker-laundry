import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderNotification, trackingUrl } from "../../src/domain/notifications.js";
import { fromDbError } from "./http.js";
import { mercadoPago, verifyMercadoPagoSignature } from "./providers/mercadopago.js";

describe("MercadoPago webhook signature", () => {
  const secret = "s3cr3t";
  const sign = (dataId: string, requestId: string, ts: string) =>
    createHmac("sha256", secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest("hex");

  it("accepts a valid signature and rejects tampering", () => {
    const headers = new Headers({ "x-signature": `ts=1700000000,v1=${sign("123", "req-1", "1700000000")}`, "x-request-id": "req-1" });
    expect(verifyMercadoPagoSignature(headers, "123", secret)).toBe(true);
    expect(verifyMercadoPagoSignature(headers, "124", secret)).toBe(false);
    expect(verifyMercadoPagoSignature(headers, "123", "other")).toBe(false);
    expect(verifyMercadoPagoSignature(new Headers(), "123", secret)).toBe(false);
  });

  it("parses payment notifications and enforces the secret when set", () => {
    const n = mercadoPago.parseWebhook(
      { headers: new Headers({ "x-request-id": "r" }), query: new URLSearchParams(), body: { type: "payment", data: { id: 99 } } },
      { access_token: "x" },
    );
    expect(n).toEqual({ event_key: "req:r", payment_id: "99" });
    expect(() =>
      mercadoPago.parseWebhook(
        { headers: new Headers(), query: new URLSearchParams(), body: { type: "payment", data: { id: 99 } } },
        { access_token: "x", webhook_secret: secret },
      ),
    ).toThrow(/signature/);
  });
});

describe("notification rendering", () => {
  it("renders money, dates and the tracking link", () => {
    const r = renderNotification(
      {
        channel: "whatsapp",
        recipient: "+525512345678",
        subject_template: "Orden #{{order_number}}",
        body_template: "Hola {{customer_name}}: saldo {{balance}}. {{tracking_url}} {{pickup_date}}",
        variables: {
          customer_name: "Ana",
          order_number: 7,
          balance_cents: 12345,
          currency: "MXN",
          tracking_token: "abc",
          pickup_date: "2026-06-15",
        },
      },
      "https://app.example.com/",
    );
    expect(r.subject).toBe("Orden #7");
    expect(r.body).toContain("$123.45");
    expect(r.body).toContain("https://app.example.com/t/abc");
    expect(r.body).toMatch(/15 de junio/);
    expect(trackingUrl("https://x.com", null)).toBe("");
  });
});

describe("db error mapping", () => {
  it("maps SQLSTATEs to HTTP statuses", () => {
    expect(fromDbError({ code: "42501", message: "x" })?.status).toBe(403);
    expect(fromDbError({ code: "P0002", message: "x" })?.status).toBe(404);
    expect(fromDbError({ code: "22023", message: "x" })?.status).toBe(422);
    expect(fromDbError(null)).toBeNull();
  });
});
