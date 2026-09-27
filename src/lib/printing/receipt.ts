// Turns an order into a printable ticket (ReceiptDoc). Amounts come from the
// stored pricing breakdown, the single source of truth, so the ticket always
// matches what the customer sees online.

import { pointsEarned, type LoyaltySettings } from "../../domain/loyalty";
import { PAYMENT_METHOD_LABEL } from "../../domain/payments";
import type { ReceiptSettings } from "../../domain/settings";
import type { Order, OrderItem, Payment } from "../types";
import type { ReceiptDoc, ReceiptLine } from "./escpos";

export interface ReceiptInput {
  business: { name: string; legal_name?: string | null; tax_id?: string | null; phone?: string | null; address?: string | null };
  settings: ReceiptSettings;
  loyaltySettings: LoyaltySettings;
  order: Pick<
    Order,
    "number" | "status" | "fulfillment" | "created_at" | "promised_at" | "notes" | "total_cents" | "amount_paid_cents" | "balance_cents" | "pricing"
  >;
  customer: { name: string; phone?: string | null };
  /** Delivery address, already formatted. */
  address?: string | null;
  items: Pick<OrderItem, "name" | "quantity" | "unit" | "unit_price_cents" | "list_total_cents" | "notes">[];
  payments: Pick<Payment, "kind" | "method" | "status" | "amount_cents">[];
  /** Points already credited for this order, and the customer's balance. */
  loyalty: { earned: number; balance: number } | null;
  trackingUrl: string;
  printedAt: Date;
  fmt: {
    money: (cents: number) => string;
    dateTime: (iso: string) => string;
    qty: (n: number) => string;
    unit: (u: string) => string;
  };
}

export function composeReceipt(r: ReceiptInput): ReceiptDoc {
  const { order, fmt, settings } = r;
  const m = fmt.money;
  const header = [
    r.business.legal_name && r.business.legal_name !== r.business.name ? r.business.legal_name : "",
    r.business.tax_id ? `RFC: ${r.business.tax_id}` : "",
    r.business.address ?? "",
    r.business.phone ? `Tel. ${r.business.phone}` : "",
    ...settings.header.split("\n"),
  ].filter((l) => l.trim());

  const info = [
    `Orden #${order.number}`,
    `Fecha: ${fmt.dateTime(order.created_at)}`,
    ...(order.promised_at && !["delivered", "cancelled"].includes(order.status) ? [`Entrega: ${fmt.dateTime(order.promised_at)}`] : []),
    `Cliente: ${r.customer.name}`,
    ...(r.customer.phone ? [`Tel. ${r.customer.phone}`] : []),
    ...(r.address ? [r.address] : []),
    ...(order.status === "cancelled" ? ["*** ORDEN CANCELADA ***"] : []),
  ];

  const items: ReceiptLine[] = r.items.map((i) => ({
    left: i.name,
    right: m(i.list_total_cents),
    detail: [`  ${fmt.qty(i.quantity)} ${fmt.unit(i.unit)} x ${m(i.unit_price_cents)}`, i.notes ? `  ${i.notes}` : ""].filter(Boolean).join("\n"),
  }));

  const totals: ReceiptLine[] = [];
  const p = order.pricing;
  if (r.items.length === 0) {
    totals.push({ left: "Registraremos tus prendas y el total al recibir tu ropa." });
  } else if (p) {
    for (const s of p.steps) {
      if (s.key === "list_subtotal" && p.steps.length <= 2) continue;
      totals.push({ left: s.label, right: m(s.amount_cents), bold: s.key === "total" });
    }
    if (p.tax_mode === "inclusive" && p.tax_included_cents > 0) {
      totals.push({ left: `IVA incluido (${p.tax_rate_percent}%)`, right: m(p.tax_included_cents) });
    }
  } else {
    totals.push({ left: "Total", right: m(order.total_cents), bold: true });
  }

  const paid = r.payments.filter((x) => x.status === "succeeded");
  const payments: ReceiptLine[] = paid.map((x) => ({
    left: x.kind === "refund" ? `Reembolso (${PAYMENT_METHOD_LABEL[x.method] ?? x.method})` : (PAYMENT_METHOD_LABEL[x.method] ?? x.method),
    right: m(x.kind === "refund" ? -x.amount_cents : x.amount_cents),
  }));
  if (r.items.length > 0 && order.status !== "cancelled") {
    if (paid.length > 1) payments.push({ left: "Pagado", right: m(order.amount_paid_cents) });
    if (order.balance_cents > 0) payments.push({ left: "Por cobrar", right: m(order.balance_cents), bold: true });
    else if (order.total_cents > 0) payments.push({ left: "PAGADO", bold: true });
  }

  const loyalty: ReceiptLine[] = [];
  if (settings.show_loyalty && r.loyalty && (r.loyaltySettings.enabled || r.loyalty.balance > 0)) {
    const redeemed = p?.points_redeemed ?? 0;
    if (redeemed > 0) loyalty.push({ left: "Puntos usados", right: String(redeemed) });
    if (r.loyalty.earned > 0) loyalty.push({ left: "Puntos ganados", right: String(r.loyalty.earned) });
    else if (order.status !== "cancelled") {
      const pending = pointsEarned(order.total_cents, r.loyaltySettings);
      if (pending > 0) loyalty.push({ left: "Puntos a ganar", right: String(pending), detail: "Se acreditan al entregar y pagar." });
    }
    loyalty.push({ left: "Tus puntos", right: String(r.loyalty.balance) });
  }

  const footer = [
    ...(settings.tracking_link && !settings.tracking_qr ? ["Sigue tu orden en:", r.trackingUrl] : []),
    ...(settings.tracking_qr ? ["Escanea para seguir tu orden"] : []),
    ...settings.footer.split("\n"),
    `Impreso ${fmt.dateTime(r.printedAt.toISOString())}`,
  ].filter((l) => l.trim());

  return {
    title: r.business.name,
    header,
    info,
    items,
    totals,
    sections: [payments, loyalty],
    notes: order.notes ? [`Notas: ${order.notes}`] : [],
    footer,
    qr: settings.tracking_qr ? r.trackingUrl : null,
    annotationSpace: settings.annotation_space,
  };
}
