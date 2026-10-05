// How a business operates. Chosen by the owner during the trial, then fixed
// by the plan (each model is priced differently). The database enforces it
// (app.orders_check_fulfillment / app.deliveries_check_model); the UI shows
// only the features that apply.

export type OperationModel = "walk_in" | "delivery" | "hybrid";

export const OPERATION_MODELS: { value: OperationModel; label: string; description: string; icon: string }[] = [
  {
    value: "walk_in",
    label: "Solo mostrador",
    description: "Los clientes traen y recogen su ropa en tu local. Sin recolecciones, rutas ni couriers.",
    icon: "storefront",
  },
  {
    value: "delivery",
    label: "Todo a domicilio",
    description: "Recoges y entregas todo en casa del cliente. Cada orden lleva recolección y entrega.",
    icon: "local_shipping",
  },
  {
    value: "hybrid",
    label: "Híbrida",
    description: "Mostrador y domicilio. Cada orden se marca como A domicilio o Mostrador.",
    icon: "sync_alt",
  },
];

export const OPERATION_LABEL: Record<OperationModel, string> = Object.fromEntries(OPERATION_MODELS.map((m) => [m.value, m.label])) as Record<OperationModel, string>;

export interface Operation {
  model: OperationModel;
  /** Pickups, deliveries, routes, couriers, delivery zones. */
  delivery: boolean;
  /** Orders received and handed over at the counter. */
  counter: boolean;
  /** Both kinds coexist: label orders. */
  hybrid: boolean;
  /** Fulfillment for new orders. */
  defaultFulfillment: "delivery" | "walk_in";
}

export function operation(model: OperationModel | null | undefined): Operation {
  const m: OperationModel = model === "walk_in" || model === "delivery" ? model : "hybrid";
  return {
    model: m,
    delivery: m !== "walk_in",
    counter: m !== "delivery",
    hybrid: m === "hybrid",
    defaultFulfillment: m === "delivery" ? "delivery" : "walk_in",
  };
}
