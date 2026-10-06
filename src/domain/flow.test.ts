import { describe, expect, it } from "vitest";
import { nextMove, prevMove, type FlowAccess, type FlowOrder, type FlowStep } from "./flow.js";

const all: FlowAccess = { user_id: "u1", can_work: true, can_manage: true, can: () => true };
const worker: FlowAccess = { user_id: "u2", can_work: true, can_manage: false, can: (...p) => p.includes("production.work") };

const step = (id: string, position: number, status: FlowStep["status"] = "pending"): FlowStep => ({
  id,
  name: `Fase ${id}`,
  position,
  status,
  assigned_to: null,
  requires_assignment: false,
  estimated_minutes: null,
});

const base: FlowOrder = { status: "created", fulfillment: "walk_in", current_step_id: null, items: 2, steps: [], deliveries: [] };

describe("board flow", () => {
  it("receives scheduled orders, completing the pickup stop when there is one", () => {
    expect(nextMove(base, all)?.move).toEqual({ kind: "status", to: "picked_up" });
    const withPickup = { ...base, status: "scheduled" as const, deliveries: [{ id: "d1", type: "pickup" as const, status: "scheduled" }] };
    expect(nextMove(withPickup, all)?.move).toEqual({ kind: "stop", delivery: "d1", to: "completed" });
  });

  it("asks for services before production", () => {
    expect(nextMove({ ...base, status: "picked_up", items: 0 }, all)?.move).toEqual({ kind: "capture" });
    expect(nextMove({ ...base, status: "picked_up" }, all)?.move).toEqual({ kind: "status", to: "in_production" });
  });

  it("completes the current step and goes back to the previous one", () => {
    const o: FlowOrder = { ...base, status: "in_production", steps: [step("a", 1, "done"), step("b", 2)], current_step_id: "b" };
    expect(nextMove(o, all)).toEqual({ label: "Fase b lista", move: { kind: "complete_step", step: "b" } });
    expect(prevMove(o, all)).toEqual({ label: "Regresar a Fase a", move: { kind: "undo" } });
    expect(prevMove(o, worker)).toBeNull(); // someone else finished it
    const own = { ...o, steps: [{ ...step("a", 1, "done"), completed_by: "u2" }, step("b", 2)] };
    expect(prevMove(own, worker)?.label).toBe("Regresar a Fase a");
    expect(nextMove(o, worker)?.move.kind).toBe("complete_step");
  });

  it("ready orders: counter hands over, delivery goes on the route", () => {
    const ready: FlowOrder = { ...base, status: "ready", steps: [step("a", 1, "done"), step("b", 2, "done")] };
    expect(nextMove(ready, all)?.move).toEqual({ kind: "status", to: "delivered" });
    expect(prevMove(ready, all)?.label).toBe("Regresar a Fase b");
    const skipped = { ...ready, steps: [step("a", 1, "done"), step("b", 2, "skipped"), step("c", 3, "skipped")] };
    expect(prevMove(skipped, all)?.label).toBe("Regresar a Fase b");
    const delivery = { ...ready, fulfillment: "delivery" as const };
    expect(nextMove(delivery, all)).toBeNull();
    const stops = [{ id: "s", type: "delivery" as const, status: "scheduled" }];
    expect(nextMove({ ...delivery, deliveries: stops }, all)?.move).toEqual({ kind: "stop", delivery: "s", to: "en_route" });
    expect(nextMove({ ...delivery, status: "out_for_delivery", deliveries: stops }, all)?.move).toEqual({ kind: "stop", delivery: "s", to: "completed" });
  });

  it("fat-finger mistakes can be undone", () => {
    expect(nextMove({ ...base, status: "delivered" }, all)).toBeNull();
    expect(prevMove({ ...base, status: "delivered" }, all)?.label).toBe("Regresar a Listas");
    expect(prevMove({ ...base, status: "out_for_delivery", fulfillment: "delivery" }, all)?.label).toBe("Regresar a Listas");
    // Counter orders start in production: nothing before the first phase.
    const first: FlowOrder = { ...base, status: "in_production", steps: [step("a", 1)], current_step_id: "a" };
    expect(prevMove(first, all)).toBeNull();
    const collected = { ...first, fulfillment: "delivery" as const, deliveries: [{ id: "p", type: "pickup" as const, status: "completed" }] };
    expect(prevMove(collected, all)?.label).toBe("Regresar a por recolectar");
    expect(prevMove({ ...collected, deliveries: [] }, all)?.label).toBe("Deshacer recibida");
    expect(prevMove({ ...base, status: "created" }, all)).toBeNull();
    expect(prevMove({ ...base, status: "cancelled" }, all)).toBeNull();
  });
});
