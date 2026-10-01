// General order lifecycle. This is universal across laundries and is NOT the
// production workflow: production steps are configured per tenant and live
// inside the "in_production" status.
//
// The database enforces these transitions (see the `app.order_transitions`
// table in the migrations); this copy only drives which buttons the UI shows.
// A unit test checks both stay identical.

export const ORDER_STATUSES = [
  "created",
  "scheduled",
  "picked_up",
  "in_production",
  "ready",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  created: "Creada",
  scheduled: "Recolección agendada",
  picked_up: "Recibida",
  in_production: "En producción",
  ready: "Lista",
  out_for_delivery: "En camino",
  delivered: "Entregada",
  cancelled: "Cancelada",
};

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  created: ["scheduled", "picked_up", "in_production", "cancelled"],
  scheduled: ["picked_up", "in_production", "cancelled"],
  picked_up: ["in_production", "cancelled"],
  in_production: ["ready", "cancelled"],
  ready: ["out_for_delivery", "delivered", "in_production"],
  out_for_delivery: ["delivered", "ready"],
  delivered: [],
  cancelled: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

export const isOpenStatus = (s: OrderStatus) => s !== "delivered" && s !== "cancelled";

export type OrderPriority = "normal" | "high" | "urgent";

export const PRIORITY_LABEL: Record<OrderPriority, string> = {
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

/** Customer-facing progress (tracking page), in order. */
export const TRACKING_STAGES: { key: string; label: string; statuses: OrderStatus[] }[] = [
  { key: "received", label: "Recibida", statuses: ["created", "scheduled", "picked_up"] },
  { key: "production", label: "En proceso", statuses: ["in_production"] },
  { key: "ready", label: "Lista", statuses: ["ready"] },
  { key: "delivery", label: "En camino", statuses: ["out_for_delivery"] },
  { key: "delivered", label: "Entregada", statuses: ["delivered"] },
];

export const trackingStageIndex = (s: OrderStatus): number =>
  TRACKING_STAGES.findIndex((st) => st.statuses.includes(s));
