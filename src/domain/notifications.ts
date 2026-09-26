// Turns a queued notification (template + variable snapshot) into the final
// text. Used by the server dispatcher (automatic sends) and by the back
// office (manual WhatsApp), so both render exactly the same message.

import { formatMoney } from "./money.js";
import { ORDER_STATUS_LABEL, type OrderStatus } from "./orders.js";
import { renderTemplate } from "./templates.js";

export interface QueuedNotification {
  channel: string;
  recipient: string;
  subject_template: string | null;
  body_template: string;
  variables: Record<string, unknown>;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function formatDate(value: unknown, locale: string, timeZone: string, withTime: boolean): string {
  if (!value) return "";
  const raw = String(value);
  // Plain dates ("2026-06-15") are calendar days: do not shift them by time zone.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00Z`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(locale, {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? "UTC" : timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

export function trackingUrl(appUrl: string, token: unknown): string {
  return token ? `${appUrl.replace(/\/$/, "")}/t/${token}` : "";
}

export function notificationVariables(vars: Record<string, unknown>, appUrl: string): Record<string, string> {
  const currency = str(vars.currency) || "MXN";
  const locale = str(vars.locale) || "es-MX";
  const timeZone = str(vars.timezone) || "America/Mexico_City";
  const money = (v: unknown) => (typeof v === "number" ? formatMoney(v, currency, locale) : "");
  return {
    customer_name: str(vars.customer_name),
    business_name: str(vars.business_name),
    business_phone: str(vars.business_phone),
    order_number: str(vars.order_number),
    status: ORDER_STATUS_LABEL[vars.status as OrderStatus] ?? str(vars.status),
    step: str(vars.step),
    total: money(vars.total_cents),
    balance: money(vars.balance_cents),
    promised_date: formatDate(vars.promised_at, locale, timeZone, true),
    pickup_date: formatDate(vars.pickup_date, locale, timeZone, false),
    pickup_window: str(vars.pickup_window),
    tracking_url: trackingUrl(appUrl, vars.tracking_token),
  };
}

export function renderNotification(n: QueuedNotification, appUrl: string): { subject: string; body: string } {
  const vars = notificationVariables(n.variables ?? {}, appUrl);
  return {
    subject: renderTemplate(n.subject_template ?? "", vars).trim(),
    body: renderTemplate(n.body_template, vars).trim(),
  };
}

export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}
