// Payment state is always derived from the payment ledger, never stored as a
// flag someone toggles. The database has the authoritative implementation
// (`app.recompute_order_payment`); this one mirrors it for previews and is
// covered by the same cases in the unit and database tests.

import type { Cents } from "./money.js";

export type PaymentMethod = "cash" | "card" | "transfer" | "online";
export type PaymentKind = "payment" | "refund";
export type PaymentRecordStatus = "pending" | "succeeded" | "failed";
export type OrderPaymentStatus = "pending" | "partially_paid" | "paid" | "refunded" | "failed";

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  online: "Pago en línea",
};

export const PAYMENT_STATUS_LABEL: Record<OrderPaymentStatus, string> = {
  pending: "Pendiente",
  partially_paid: "Pago parcial",
  paid: "Pagada",
  refunded: "Reembolsada",
  failed: "Pago fallido",
};

export interface LedgerEntry {
  kind: PaymentKind;
  status: PaymentRecordStatus;
  amount_cents: Cents;
  created_at: string;
}

export interface PaymentState {
  amount_paid_cents: Cents;
  balance_cents: Cents;
  status: OrderPaymentStatus;
}

/** `hasItems`: an order with no items yet (pickup booked before pricing) is pending, not paid. */
export function derivePaymentState(totalCents: Cents, ledger: LedgerEntry[], hasItems = true): PaymentState {
  const ok = ledger.filter((e) => e.status === "succeeded");
  const paid = ok.filter((e) => e.kind === "payment").reduce((s, e) => s + e.amount_cents, 0);
  const refunded = ok.filter((e) => e.kind === "refund").reduce((s, e) => s + e.amount_cents, 0);
  const net = paid - refunded;
  const balance = Math.max(0, totalCents - net);

  let status: OrderPaymentStatus;
  if (refunded > 0 && net <= 0) status = "refunded";
  else if (net > 0 && net >= totalCents) status = "paid";
  else if (net > 0) status = "partially_paid";
  else if (totalCents === 0 && hasItems) status = "paid";
  else {
    const last = [...ledger].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
    status = last?.status === "failed" ? "failed" : "pending";
  }
  return { amount_paid_cents: net, balance_cents: balance, status };
}
