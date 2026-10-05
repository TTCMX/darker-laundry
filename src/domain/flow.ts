// One tap / swipe / drag on the orders board: what "advance" and "go back"
// mean for an order, depending on where it is. The database decides whether
// it is allowed (transitions, permissions); this only picks the right call.

import type { OrderStatus } from "./orders.js";
import type { Permission } from "./permissions.js";
import { stepActions, type Actor, type ProductionStepLike } from "./production.js";

export interface FlowStep extends ProductionStepLike {
  name: string;
}

export interface FlowStop {
  id: string;
  type: "pickup" | "delivery";
  status: string;
}

export interface FlowOrder {
  status: OrderStatus;
  fulfillment: "delivery" | "walk_in";
  current_step_id: string | null;
  items: number;
  steps: FlowStep[];
  deliveries: FlowStop[];
}

export type Move =
  | { kind: "status"; to: OrderStatus }
  | { kind: "stop"; delivery: string; to: "completed" | "en_route" }
  | { kind: "complete_step"; step: string }
  | { kind: "revert_step"; step: string }
  /** Nothing to move: open the order to capture its services. */
  | { kind: "capture" };

export interface FlowMove {
  label: string;
  move: Move;
}

export interface FlowAccess extends Actor {
  can: (...perms: Permission[]) => boolean;
}

const OPEN_STOP = (d: FlowStop) => !["completed", "failed", "cancelled"].includes(d.status);

const ordered = (steps: FlowStep[]) => [...steps].sort((a, b) => a.position - b.position);

export function nextMove(o: FlowOrder, a: FlowAccess): FlowMove | null {
  const stop = (type: FlowStop["type"]) => o.deliveries.find((d) => d.type === type && OPEN_STOP(d));
  switch (o.status) {
    case "created":
    case "scheduled": {
      const pickup = stop("pickup");
      if (pickup && a.can("delivery.manage")) return { label: "Recolectada", move: { kind: "stop", delivery: pickup.id, to: "completed" } };
      return a.can("orders.edit") ? { label: "Recibida", move: { kind: "status", to: "picked_up" } } : null;
    }
    case "picked_up":
      if (o.items === 0) return a.can("orders.edit") ? { label: "Capturar servicios", move: { kind: "capture" } } : null;
      return a.can("orders.edit", "production.manage") ? { label: "A producción", move: { kind: "status", to: "in_production" } } : null;
    case "in_production": {
      const step = o.steps.find((s) => s.id === o.current_step_id);
      if (!step) return a.can("production.manage") ? { label: "Lista", move: { kind: "status", to: "ready" } } : null;
      return stepActions(step, a).includes("complete") ? { label: `${step.name} lista`, move: { kind: "complete_step", step: step.id } } : null;
    }
    case "ready": {
      if (o.fulfillment === "walk_in") return a.can("orders.edit") ? { label: "Entregada", move: { kind: "status", to: "delivered" } } : null;
      const d = stop("delivery");
      return d && a.can("delivery.manage") ? { label: "En ruta", move: { kind: "stop", delivery: d.id, to: "en_route" } } : null;
    }
    case "out_for_delivery": {
      const d = stop("delivery");
      return d && a.can("delivery.manage") ? { label: "Entregada", move: { kind: "stop", delivery: d.id, to: "completed" } } : null;
    }
    default:
      return null;
  }
}

export function prevMove(o: FlowOrder, a: FlowAccess): FlowMove | null {
  if (!a.can("production.manage")) return null;
  const steps = ordered(o.steps);
  if (o.status === "in_production") {
    const i = steps.findIndex((s) => s.id === o.current_step_id);
    const prev = i > 0 ? steps[i - 1] : null;
    return prev ? { label: `Regresar a ${prev.name}`, move: { kind: "revert_step", step: prev.id } } : null;
  }
  if (o.status === "ready") {
    const last = [...steps].reverse().find((s) => s.status === "done" || s.status === "skipped");
    return last
      ? { label: `Regresar a ${last.name}`, move: { kind: "revert_step", step: last.id } }
      : { label: "Regresar a producción", move: { kind: "status", to: "in_production" } };
  }
  return null;
}
