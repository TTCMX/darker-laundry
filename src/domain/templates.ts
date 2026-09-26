// Notification templates use {{variable}} placeholders. Unknown variables
// render as empty strings so a typo never leaks "{{x}}" to a customer.

export const NOTIFICATION_EVENTS = [
  "order_created",
  "pickup_scheduled",
  "order_received",
  "production_update",
  "order_ready",
  "out_for_delivery",
  "order_delivered",
  "payment_reminder",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABEL: Record<NotificationEvent, string> = {
  order_created: "Orden creada",
  pickup_scheduled: "Recolección agendada",
  order_received: "Orden recibida",
  production_update: "Avance de producción",
  order_ready: "Orden lista",
  out_for_delivery: "En camino",
  order_delivered: "Entregada",
  payment_reminder: "Recordatorio de pago",
};

export const TEMPLATE_VARIABLES = [
  "customer_name",
  "business_name",
  "order_number",
  "status",
  "step",
  "total",
  "balance",
  "promised_date",
  "tracking_url",
  "pickup_date",
  "pickup_window",
] as const;

export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
