import { useSheetNavigate } from "../../app/sheet";
import type { FlowMove } from "../../domain/flow";
import { rpc, useAction } from "../../lib/queries";
import { useToast } from "../../ui/components";

/** Runs one board move (advance / go back) for an order. */
export function useMoveOrder() {
  const toast = useToast();
  const open = useSheetNavigate();
  const act = useAction(
    async ({ id, m }: { id: string; number: number; m: FlowMove }) => {
      const mv = m.move;
      switch (mv.kind) {
        case "status":
          return mv.to === "in_production" ? rpc("start_production", { p_order: id }) : rpc("set_order_status", { p_order: id, p_status: mv.to });
        case "stop":
          return rpc("update_delivery_status", { p_delivery: mv.delivery, p_status: mv.to, p_note: null, p_failure_reason: null, p_proof_paths: [] });
        case "complete_step":
          return rpc("complete_production_step", { p_step: mv.step });
        case "undo":
          return rpc("undo_order_step", { p_order: id, p_reason: null });
        case "capture":
          return;
      }
    },
    { invalidate: [["board"], ["orders"], ["order"], ["dashboard"], ["deliveries"], ["delivery"]] },
  );
  const run = (order: { id: string; number: number }, m: FlowMove | null, back = false) => {
    if (!m) {
      toast.show(back ? `#${order.number} no puede regresar desde aquí` : `#${order.number}: ábrela para continuar`);
      return;
    }
    if (m.move.kind === "capture") return open(`/orders/${order.id}/edit`);
    act.mutate({ id: order.id, number: order.number, m }, { onSuccess: () => toast.show(`#${order.number} · ${m.label}`) });
  };
  return { run, pendingId: act.isPending ? act.variables?.id : undefined };
}
