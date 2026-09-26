import { CUSTOMER_STATUS_LABEL, type CustomerStatus } from "../domain/customers";
import { ORDER_STATUS_LABEL, PRIORITY_LABEL, type OrderPriority, type OrderStatus } from "../domain/orders";
import { PAYMENT_STATUS_LABEL, type OrderPaymentStatus } from "../domain/payments";
import { RISK_LABEL, type RiskLevel } from "../domain/production";
import type { DeliveryStatus } from "../lib/types";
import { Badge, type Tone } from "../ui/components";

const ORDER_TONE: Record<OrderStatus, Tone> = {
  created: "neutral",
  scheduled: "secondary",
  picked_up: "secondary",
  in_production: "primary",
  ready: "success",
  out_for_delivery: "warning",
  delivered: "outline",
  cancelled: "error",
};

const ORDER_ICON: Record<OrderStatus, string> = {
  created: "draft",
  scheduled: "event",
  picked_up: "inventory_2",
  in_production: "local_laundry_service",
  ready: "check_circle",
  out_for_delivery: "local_shipping",
  delivered: "done_all",
  cancelled: "block",
};

export const OrderStatusBadge = ({ status }: { status: OrderStatus }) => (
  <Badge tone={ORDER_TONE[status]} icon={ORDER_ICON[status]}>
    {ORDER_STATUS_LABEL[status]}
  </Badge>
);

const PAY_TONE: Record<OrderPaymentStatus, Tone> = {
  pending: "warning",
  partially_paid: "secondary",
  paid: "success",
  refunded: "neutral",
  failed: "error",
};

export const PaymentBadge = ({ status }: { status: OrderPaymentStatus }) => (
  <Badge tone={PAY_TONE[status]}>{PAYMENT_STATUS_LABEL[status]}</Badge>
);

const RISK_TONE: Record<RiskLevel, Tone> = { normal: "neutral", approaching: "warning", at_risk: "warning", overdue: "error" };
export const RiskBadge = ({ risk }: { risk: RiskLevel }) =>
  risk === "normal" ? null : (
    <Badge tone={RISK_TONE[risk]} icon={risk === "overdue" ? "alarm" : "schedule"}>
      {RISK_LABEL[risk]}
    </Badge>
  );

export const PriorityBadge = ({ priority }: { priority: OrderPriority }) =>
  priority === "normal" ? null : (
    <Badge tone={priority === "urgent" ? "error" : "warning"} icon="priority_high">
      {PRIORITY_LABEL[priority]}
    </Badge>
  );

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  scheduled: "Programada",
  assigned: "Asignada",
  en_route: "En camino",
  arrived: "En el domicilio",
  completed: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
};

const DELIVERY_TONE: Record<DeliveryStatus, Tone> = {
  scheduled: "neutral",
  assigned: "secondary",
  en_route: "warning",
  arrived: "warning",
  completed: "success",
  failed: "error",
  cancelled: "outline",
};

export const DeliveryStatusBadge = ({ status }: { status: DeliveryStatus }) => (
  <Badge tone={DELIVERY_TONE[status]}>{DELIVERY_STATUS_LABEL[status]}</Badge>
);

const CUSTOMER_TONE: Record<CustomerStatus, Tone> = {
  new: "primary",
  active: "success",
  at_risk: "warning",
  inactive: "neutral",
  churned: "error",
};
export const CustomerStatusBadge = ({ status }: { status: CustomerStatus }) => (
  <Badge tone={CUSTOMER_TONE[status]}>{CUSTOMER_STATUS_LABEL[status]}</Badge>
);

export const DELIVERY_TYPE_LABEL = { pickup: "Recolección", delivery: "Entrega" } as const;

export const SEVERITY_LABEL = { low: "Baja", medium: "Media", high: "Alta", critical: "Crítica" } as const;
export const SEVERITY_TONE: Record<string, Tone> = { low: "neutral", medium: "warning", high: "error", critical: "error" };
export const ISSUE_TYPE_LABEL: Record<string, string> = {
  damage: "Daño",
  stain: "Mancha",
  missing_item: "Prenda faltante",
  wrong_process: "Proceso incorrecto",
  delay: "Retraso",
  customer_complaint: "Queja del cliente",
  other: "Otro",
};
export const ISSUE_STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  in_progress: "En atención",
  resolved: "Resuelta",
  dismissed: "Descartada",
};

export function KvRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className={strong ? "title-m" : undefined} style={strong ? { color: "var(--on-surface)" } : undefined}>
        {label}
      </dt>
      <dd className={strong ? "title-m" : undefined}>{value}</dd>
    </>
  );
}
