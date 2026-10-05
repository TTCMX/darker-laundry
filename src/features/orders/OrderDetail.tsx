import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Page } from "../../app/Shell";
import { useSheet, useSheetNavigate } from "../../app/sheet";
import { nextMove, prevMove } from "../../domain/flow";
import { useMoveOrder } from "./useMoveOrder";
import { NOTIFICATION_EVENT_LABEL, type NotificationEvent } from "../../domain/templates";
import { ORDER_STATUS_LABEL, isOpenStatus, type OrderStatus } from "../../domain/orders";
import { PAYMENT_METHOD_LABEL } from "../../domain/payments";
import { remainingMinutes, riskLevel, stepActions } from "../../domain/production";
import { renderNotification, trackingUrl, whatsappLink } from "../../domain/notifications";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { dateOnly, dateTime, money, qty, unitLabel } from "../../lib/format";
import { rpc, signedUrl, useAction, useMemberNames, useTeam } from "../../lib/queries";
import { useAuth, useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type {
  Address,
  AuditRow,
  Customer,
  Delivery,
  NotificationRow,
  Order,
  OrderItem,
  Payment,
  ProductionStep,
  QualityIssue,
} from "../../lib/types";
import { Badge, Banner, Button, Card, Empty, Icon, IconButton, Loading, Menu, Select, Tabs, useToast } from "../../ui/components";
import { formatAddress, mapsUrl } from "../customers/CustomerDialogs";
import {
  DELIVERY_TYPE_LABEL,
  DeliveryStatusBadge,
  FulfillmentBadge,
  ISSUE_STATUS_LABEL,
  ISSUE_TYPE_LABEL,
  KvRow,
  OrderStatusBadge,
  PaymentBadge,
  PriorityBadge,
  RiskBadge,
  SEVERITY_LABEL,
  SEVERITY_TONE,
} from "../shared";
import { BrowserReceipt, PrintReceiptButton } from "./PrintReceipt";
import { AddPhotoButton, OrderPhotoGallery, useOrderPhotos } from "./OrderPhotos";
import { EditStopDialog, IssueDialog, PaymentDialog, ReasonDialog, RefundDialog, ResolveIssueDialog, ScheduleDialog } from "./OrderDialogs";

interface OrderBundle {
  order: Order & { customers: Customer };
  items: OrderItem[];
  steps: ProductionStep[];
  deliveries: Delivery[];
  payments: Payment[];
  issues: QualityIssue[];
  notifications: NotificationRow[];
  addresses: Address[];
  history: AuditRow[];
}

export function useOrderBundle(id: string) {
  return useQuery({
    queryKey: ["order", id],
    queryFn: async (): Promise<OrderBundle> => {
      const o = await supabase.from("orders").select("*, customers(*)").eq("id", id).single();
      if (o.error) throw o.error;
      const order = o.data as OrderBundle["order"];
      const [items, steps, deliveries, payments, issues, notifications, addresses, history] = await Promise.all([
        supabase.from("order_items").select("*").eq("order_id", id).order("position"),
        supabase.from("order_production_steps").select("*").eq("order_id", id).order("position"),
        supabase.from("deliveries").select("*").eq("order_id", id).order("created_at"),
        supabase.from("payments").select("*").eq("order_id", id).order("created_at"),
        supabase.from("quality_issues").select("*").eq("order_id", id).order("created_at", { ascending: false }),
        supabase.from("notifications").select("*").eq("order_id", id).order("created_at", { ascending: false }),
        supabase.from("customer_addresses").select("*").eq("customer_id", order.customer_id).order("is_default", { ascending: false }),
        supabase.from("audit_log").select("*").eq("order_id", id).order("occurred_at", { ascending: false }).limit(300),
      ]);
      return {
        order,
        items: (items.data ?? []) as OrderItem[],
        steps: (steps.data ?? []) as ProductionStep[],
        deliveries: (deliveries.data ?? []) as Delivery[],
        payments: (payments.data ?? []) as Payment[],
        issues: (issues.data ?? []) as QualityIssue[],
        notifications: (notifications.data ?? []) as NotificationRow[],
        addresses: (addresses.data ?? []) as Address[],
        history: (history.data ?? []) as AuditRow[],
      };
    },
  });
}

type TabKey = "summary" | "production" | "delivery" | "payments" | "quality" | "photos" | "messages" | "history";

export function OrderDetail() {
  const { id = "" } = useParams();
  const q = useOrderBundle(id);
  const photoRows = useOrderPhotos(id);
  const navigate = useNavigate();
  const sheetNavigate = useSheetNavigate();
  const sheet = useSheet();
  const { run: runMove, pendingId: movingId } = useMoveOrder();
  const toast = useToast();
  const { user } = useAuth();
  const { can, settings, tenantId, ops } = useTenant();
  const name = useMemberNames();
  const team = useTeam();
  const [tab, setTab] = useState<TabKey>("summary");
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [scheduling, setScheduling] = useState<"pickup" | "delivery" | null>(null);
  const [reporting, setReporting] = useState(false);
  const [resolving, setResolving] = useState<QualityIssue | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [editingStop, setEditingStop] = useState<Delivery | null>(null);

  const remove = useAction((reason: string) => rpc("delete_order", { p_order: id, p_reason: reason }), {
    success: "Orden eliminada",
    invalidate: [["orders"], ["board"], ["dashboard"], ["deliveries"], ["analytics"], ["customers"]],
  });
  const setStatus = useAction((args: { status: OrderStatus; note?: string }) => rpc("set_order_status", { p_order: id, p_status: args.status, p_note: args.note ?? null }), {
    success: "Estado actualizado",
  });
  const startProduction = useAction(() => rpc("start_production", { p_order: id }), { success: "Enviada a producción" });
  const stepAction = useAction(
    (a: { kind: "assign" | "complete" | "start" | "revert"; step: string; user?: string | null }) =>
      a.kind === "assign"
        ? rpc("assign_production_step", { p_step: a.step, p_user: a.user ?? null })
        : a.kind === "complete"
          ? rpc("complete_production_step", { p_step: a.step })
          : a.kind === "start"
            ? rpc("start_production_step", { p_step: a.step })
            : rpc("revert_production_step", { p_step: a.step, p_reason: null }),
  );
  const reminder = useAction(() => rpc("queue_payment_reminder", { p_order: id }), { success: "Recordatorio en cola", invalidate: [["order"]] });
  const markNotification = useAction((a: { id: string; status: "sent" | "cancelled" }) => rpc("mark_notification", { p_notification: a.id, p_status: a.status }), {
    invalidate: [["order"]],
    dispatch: false,
  });
  const sendEmail = useAction((nid: string) => api("/api/notifications/send", { tenant_id: tenantId, notification_id: nid }), {
    success: "Correo enviado",
    invalidate: [["order"]],
    dispatch: false,
  });

  if (q.isLoading) return <Page title="Orden" back="/orders"><Loading /></Page>;
  if (q.error || !q.data) {
    return (
      <Page title="Orden" back="/orders">
        <Empty icon="search_off" title="No encontramos esta orden">
          {errorMessage(q.error)}
        </Empty>
      </Page>
    );
  }

  const { order, items, steps, deliveries, payments, issues, notifications, addresses, history } = q.data;
  const customer = order.customers;
  const open = isOpenStatus(order.status);
  const risk = open ? riskLevel(order.promised_at, new Date(), remainingMinutes(steps as never), settings.operations) : "normal";
  const link = trackingUrl(window.location.origin, order.public_token);
  const pickup = deliveries.find((d) => d.type === "pickup" && !["failed", "cancelled"].includes(d.status));
  const delivery = deliveries.find((d) => d.type === "delivery" && !["failed", "cancelled"].includes(d.status));
  const openIssues = issues.filter((i) => i.status === "open" || i.status === "in_progress").length;
  const pendingMessages = notifications.filter((n) => n.status === "pending" && n.mode === "manual").length;
  const actor = { user_id: user?.id ?? "", can_work: can("production.work"), can_manage: can("production.manage") };
  const canEditStops = can("delivery.manage", "orders.edit");
  // Pickup orders can be booked before knowing what the customer sends.
  const needsItems = items.length === 0 && open;
  const photoCount =
    (photoRows.data?.length ?? 0) +
    deliveries.reduce((n, d) => n + d.proof_paths.length, 0) +
    issues.reduce((n, i) => n + i.photo_paths.length, 0);
  const captureItems = (
    <Button icon="edit_note" onClick={() => sheetNavigate(`/orders/${id}/edit`)}>
      Capturar servicios
    </Button>
  );

  // Same advance / go back as the board (one step at a time).
  const flowOrder = { status: order.status, fulfillment: order.fulfillment, current_step_id: order.current_step_id, items: items.length, steps, deliveries };
  const flowAccess = { ...actor, can };
  const next = nextMove(flowOrder, flowAccess);
  const prev = prevMove(flowOrder, flowAccess);
  const advance = next && next.move.kind !== "capture" && (
    <Button icon="arrow_forward" onClick={() => runMove(order, next)} loading={movingId === order.id}>
      {next.label}
    </Button>
  );
  const back = prev && (
    <Button variant="outlined" icon="undo" onClick={() => runMove(order, prev, true)} disabled={movingId === order.id}>
      {prev.label}
    </Button>
  );

  // Primary next step for the order, depending on its status.
  const primary = (() => {
    if (!can("orders.edit")) return null;
    switch (order.status) {
      case "created":
      case "scheduled":
        return (
          <>
            {order.fulfillment === "delivery" && !pickup && order.status === "created" && (
              <Button variant="tonal" icon="event" onClick={() => setScheduling("pickup")}>
                Programar recolección
              </Button>
            )}
            <Button variant="tonal" icon="inventory_2" onClick={() => setStatus.mutate({ status: "picked_up" })} loading={setStatus.isPending}>
              Recibir en tienda
            </Button>
            {needsItems ? (
              captureItems
            ) : (
              <Button icon="local_laundry_service" onClick={() => startProduction.mutate(undefined)} loading={startProduction.isPending}>
                Enviar a producción
              </Button>
            )}
          </>
        );
      case "picked_up":
        return (
          <>
            {back}
            {needsItems ? (
              captureItems
            ) : (
              <Button icon="local_laundry_service" onClick={() => startProduction.mutate(undefined)} loading={startProduction.isPending}>
                Enviar a producción
              </Button>
            )}
          </>
        );
      case "in_production":
        return (
          <>
            {back}
            {advance}
            {can("production.manage") && (
              <Button variant="outlined" icon="check_circle" onClick={() => setStatus.mutate({ status: "ready" })}>
                Marcar lista
              </Button>
            )}
          </>
        );
      case "out_for_delivery":
        return (
          <>
            {back}
            {advance}
          </>
        );
      case "delivered":
        return back;
      case "ready":
        return (
          <>
            {back}
            {order.fulfillment === "delivery" && advance}
            {order.fulfillment === "delivery" && ops.delivery && !delivery && (
              <Button variant="tonal" icon="local_shipping" onClick={() => setScheduling("delivery")}>
                Programar entrega
              </Button>
            )}
            {ops.counter && (
              <Button icon="done_all" onClick={() => setStatus.mutate({ status: "delivered" })} loading={setStatus.isPending}>
                Entregar en mostrador
              </Button>
            )}
          </>
        );
      default:
        return null;
    }
  })();

  const shareTracking = () => {
    if (!customer.phone_normalized) return;
    const text = `Hola ${customer.name.split(" ")[0]}, aquí puedes seguir tu orden #${order.number}: ${link}`;
    window.open(whatsappLink(customer.phone_normalized, text), "_blank", "noopener");
  };

  const showPhotos = async (paths: string[]) => {
    const urls = await Promise.all(paths.map(signedUrl));
    setPhotos(urls.filter((u): u is string => !!u));
  };

  return (
    <Page
      title={`Orden #${order.number}`}
      back="/orders"
      actions={
        <>
        {can("orders.edit") && order.status !== "cancelled" && (
          <IconButton icon="edit" label="Editar orden" onClick={() => sheetNavigate(`/orders/${id}/edit`)} />
        )}
        <PrintReceiptButton bundle={q.data} link={link} />
        <Menu trigger={(toggle) => <IconButton icon="more_vert" label="Más acciones" onClick={toggle} />}>
          {(close) => (
            <>
              {can("orders.edit") && order.status !== "cancelled" && (
                <button onClick={() => sheetNavigate(`/orders/${id}/edit`)}>
                  <Icon name="edit" /> Editar servicios y precio
                </button>
              )}
              <button
                onClick={() => {
                  close();
                  navigator.clipboard?.writeText(link).then(() => toast.show("Link copiado"));
                }}
              >
                <Icon name="link" /> Copiar link de seguimiento
              </button>
              <a href={link} target="_blank" rel="noreferrer" onClick={close}>
                <Icon name="open_in_new" /> Ver como cliente
              </a>
              <button
                onClick={() => {
                  close();
                  window.print();
                }}
              >
                <Icon name="print" /> Imprimir (navegador)
              </button>
              {can("quality.report") && (
                <button
                  onClick={() => {
                    close();
                    setReporting(true);
                  }}
                >
                  <Icon name="report" /> Reportar incidencia
                </button>
              )}
              {can("orders.cancel") && open && (
                <button
                  onClick={() => {
                    close();
                    setCancelling(true);
                  }}
                >
                  <Icon name="block" /> Cancelar orden
                </button>
              )}
              {can("orders.cancel") && (
                <button
                  onClick={() => {
                    close();
                    if (payments.length) {
                      toast.show("La orden tiene pagos: cancélala y reembolsa en lugar de eliminarla.", { error: true });
                      return;
                    }
                    setDeleting(true);
                  }}
                >
                  <Icon name="delete" /> Eliminar orden
                </button>
              )}
            </>
          )}
        </Menu>
        </>
      }
    >
      <div className="col gap-16">
        <Card>
          <div className="row between wrap gap-16">
            <div className="col gap-4 grow">
              <div className="row wrap">
                <OrderStatusBadge status={order.status} />
                <PaymentBadge status={order.payment_status} />
                <RiskBadge risk={risk} />
                <PriorityBadge priority={order.priority} />
                <FulfillmentBadge fulfillment={order.fulfillment} />
              </div>
              <Link to={`/customers/${customer.id}`} className="title-l" style={{ color: "var(--on-surface)", marginTop: 8 }}>
                {customer.name}
              </Link>
              <div className="body-m muted">
                {[customer.phone, customer.email].filter(Boolean).join(" · ")}
                {customer.phone_normalized && (
                  <>
                    {" · "}
                    <a href="#" onClick={(e) => (e.preventDefault(), shareTracking())}>
                      Enviar seguimiento por WhatsApp
                    </a>
                  </>
                )}
              </div>
              <div className="body-m muted">
                Creada {dateTime(order.created_at)} · Prometida {dateTime(order.promised_at)}
              </div>
            </div>
            <div className="col" style={{ alignItems: "flex-end" }}>
              <span className="headline-m num">{money(order.total_cents)}</span>
              {order.balance_cents > 0 && order.status !== "cancelled" ? (
                <span className="body-m" style={{ color: "var(--error)" }}>
                  Saldo {money(order.balance_cents)}
                </span>
              ) : (
                <span className="body-m muted">Pagado {money(order.amount_paid_cents)}</span>
              )}
            </div>
          </div>
          {needsItems && (
            <Banner tone="warning" icon="edit_note">
              Esta orden aún no tiene servicios. Captúralos al recibir la ropa para calcular el total y enviarla a producción.
            </Banner>
          )}
          {order.status === "cancelled" && (
            <Banner tone="error">
              Cancelada {dateTime(order.cancelled_at)}
              {order.cancel_reason ? `: ${order.cancel_reason}` : ""}
            </Banner>
          )}
          {
            <div className="row wrap mt-16 no-print">
              {primary}
              {can("payments.record") && order.balance_cents > 0 && order.status !== "cancelled" && (
                <Button variant={primary ? "outlined" : "filled"} icon="payments" onClick={() => setPaying(true)}>
                  Cobrar {money(order.balance_cents)}
                </Button>
              )}
              <AddPhotoButton orderId={order.id} onAdded={() => setTab("photos")} />
            </div>
          }
        </Card>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "summary", label: "Resumen" },
            { value: "production", label: `Producción${steps.length ? ` ${steps.filter((s) => s.status === "done").length}/${steps.length}` : ""}` },
            ...(order.fulfillment === "delivery" || deliveries.length ? [{ value: "delivery" as const, label: "Entregas" }] : []),
            { value: "payments", label: "Pagos" },
            { value: "quality", label: `Incidencias${openIssues ? ` (${openIssues})` : ""}` },
            { value: "messages", label: `Mensajes${pendingMessages ? ` (${pendingMessages})` : ""}` },
            { value: "photos", label: `Fotos${photoCount ? ` (${photoCount})` : ""}` },
            { value: "history", label: "Historial" },
          ]}
        />

        {tab === "summary" && (
          <div className="grid cols-2" style={{ alignItems: "start" }}>
            <Card title="Servicios" variant="flush">
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <div>{i.name}</div>
                          {i.notes && <div className="body-s muted">{i.notes}</div>}
                          {i.volume_savings_cents > 0 && (
                            <div className="body-s" style={{ color: "var(--tertiary)" }}>
                              Precio por volumen −{money(i.volume_savings_cents)}
                            </div>
                          )}
                        </td>
                        <td className="right nowrap muted">
                          {qty(i.quantity)} {unitLabel(i.unit)} × {money(i.unit_price_cents)}
                        </td>
                        <td className="right nowrap num">{money(i.gross_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: 16 }}>
                <dl className="kv" style={{ margin: 0 }}>
                  {(order.pricing?.steps ?? []).map((s) => (
                    <KvRow key={s.key} label={s.label} value={money(s.amount_cents)} strong={s.key === "total"} />
                  ))}
                  {!!order.pricing?.tax_included_cents && <KvRow label="IVA incluido" value={money(order.pricing.tax_included_cents)} />}
                  <KvRow label="Pagado" value={money(order.amount_paid_cents)} />
                  <KvRow label="Saldo" value={money(order.balance_cents)} strong />
                </dl>
              </div>
            </Card>
            <div className="col gap-16">
              {(order.notes || order.internal_notes) && (
                <Card title="Notas">
                  {order.notes && <p style={{ marginTop: 0 }}>{order.notes}</p>}
                  {order.internal_notes && (
                    <Banner icon="lock">
                      <span className="body-s">Interna:</span> {order.internal_notes}
                    </Banner>
                  )}
                </Card>
              )}
              <Card title="Progreso">
                <ul className="timeline">
                  {steps.map((s) => (
                    <li key={s.id}>
                      <span className={`node ${s.status === "done" ? "done" : s.id === order.current_step_id ? "current" : ""}`} />
                      <div className="title-s">{s.name}</div>
                      <div className="body-s muted">
                        {s.status === "done"
                          ? `${name(s.completed_by)} · ${dateTime(s.completed_at)}`
                          : s.status === "skipped"
                            ? "Omitida"
                            : s.assigned_to
                              ? `Asignada a ${name(s.assigned_to)}`
                              : "Libre"}
                      </div>
                    </li>
                  ))}
                  {steps.length === 0 && <p className="muted">La producción aún no inicia.</p>}
                </ul>
              </Card>
              {(pickup || delivery) && (
                <Card title="Logística">
                  {[pickup, delivery].filter(Boolean).map((d) => (
                    <div key={d!.id} className="row between" style={{ padding: "4px 0" }}>
                      <span>
                        {DELIVERY_TYPE_LABEL[d!.type]} · {dateOnly(d!.scheduled_date)} {d!.window_label ?? ""}
                      </span>
                      <div className="row gap-4">
                        <DeliveryStatusBadge status={d!.status} />
                        {canEditStops && !["completed", "failed", "cancelled"].includes(d!.status) && (
                          <IconButton icon="edit" label="Editar" onClick={() => setEditingStop(d!)} />
                        )}
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </div>
          </div>
        )}

        {tab === "production" && (
          <Card variant="flush">
            {steps.length === 0 ? (
              <Empty icon="local_laundry_service" title="La producción aún no inicia">
                {can("orders.edit") && ["created", "scheduled", "picked_up"].includes(order.status) && (
                  <Button icon="play_arrow" onClick={() => startProduction.mutate(undefined)} loading={startProduction.isPending}>
                    Enviar a producción
                  </Button>
                )}
              </Empty>
            ) : (
              <div className="list">
                {steps.map((s) => {
                  const actions = order.status === "in_production" ? stepActions(s, actor) : ["none"];
                  const isCurrent = s.id === order.current_step_id;
                  return (
                    <div key={s.id} className="list-item" style={{ flexWrap: "wrap" }}>
                      <span className="lead" style={s.status === "done" ? undefined : { background: "var(--surface-container-high)", color: "var(--on-surface-variant)" }}>
                        {s.status === "done" ? <Icon name="check" /> : s.position}
                      </span>
                      <div className="grow">
                        <div className="headline">
                          {s.name} {isCurrent && <Badge tone="primary">Actual</Badge>}
                        </div>
                        <div className="supporting">
                          Responsable: {name(s.assigned_to)}
                          {s.status === "done" && ` · Hecha por ${name(s.completed_by)} ${dateTime(s.completed_at)}`}
                          {s.status === "in_progress" && ` · En proceso desde ${dateTime(s.started_at)}`}
                          {s.status === "skipped" && " · Omitida"}
                        </div>
                      </div>
                      <div className="row wrap">
                        {isCurrent && actions.includes("reassign") && (
                          <Select
                            value={s.assigned_to ?? ""}
                            onChange={(e) => stepAction.mutate({ kind: "assign", step: s.id, user: e.target.value || null })}
                            placeholder="Sin asignar"
                            className="sm"
                            options={(team.data ?? []).filter((m) => m.active && m.role_home !== "courier").map((m) => ({ value: m.user_id, label: m.display_name }))}
                          />
                        )}
                        {isCurrent && actions.includes("claim") && (
                          <Button variant="tonal" size="sm" onClick={() => stepAction.mutate({ kind: "assign", step: s.id, user: user?.id })}>
                            Tomar
                          </Button>
                        )}
                        {isCurrent && actions.includes("complete") && (
                          <Button size="sm" icon="check" onClick={() => stepAction.mutate({ kind: "complete", step: s.id })} loading={stepAction.isPending}>
                            Completar
                          </Button>
                        )}
                        {s.status === "done" && can("production.manage") && ["in_production", "ready"].includes(order.status) && (
                          <IconButton icon="undo" label="Regresar a esta fase" onClick={() => stepAction.mutate({ kind: "revert", step: s.id })} />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {tab === "delivery" && (
          <div className="col gap-16">
            <div className="row wrap">
              {can("delivery.manage", "orders.edit") && !pickup && ["created", "scheduled"].includes(order.status) && (
                <Button variant="tonal" icon="event" onClick={() => setScheduling("pickup")}>
                  Programar recolección
                </Button>
              )}
              {can("delivery.manage", "orders.edit") && !delivery && open && (
                <Button variant="tonal" icon="local_shipping" onClick={() => setScheduling("delivery")}>
                  Programar entrega
                </Button>
              )}
            </div>
            {deliveries.length === 0 ? (
              <Card>
                <Empty icon="local_shipping" title="Sin recolecciones ni entregas" />
              </Card>
            ) : (
              deliveries.map((d) => (
                <Card key={d.id}>
                  <div className="row between wrap">
                    <div className="col gap-4">
                      <div className="title-m">
                        {DELIVERY_TYPE_LABEL[d.type]} · {dateOnly(d.scheduled_date)} {d.window_label ?? ""}
                      </div>
                      <a className="body-m" href={mapsUrl(d.address)} target="_blank" rel="noreferrer">
                        <Icon name="location_on" size="sm" /> {formatAddress(d.address)}
                      </a>
                      <div className="body-s muted">
                        Courier: {name(d.courier_id)}
                        {d.completed_at && ` · ${d.status === "failed" ? "Falló" : "Completada"} ${dateTime(d.completed_at)} por ${name(d.completed_by)}`}
                      </div>
                      {d.failure_reason && <div className="body-s error-text">Motivo: {d.failure_reason}</div>}
                      {d.notes && <div className="body-s">{d.notes}</div>}
                    </div>
                    <div className="row wrap">
                      <DeliveryStatusBadge status={d.status} />
                      {d.proof_paths.length > 0 && (
                        <Button variant="text" icon="photo_library" onClick={() => showPhotos(d.proof_paths)}>
                          {d.proof_paths.length}
                        </Button>
                      )}
                      {canEditStops && !["completed", "failed", "cancelled"].includes(d.status) && (
                        <Button variant="tonal" size="sm" icon="edit" onClick={() => setEditingStop(d)}>
                          Editar
                        </Button>
                      )}
                      {canEditStops && d.status === "failed" && open && !(d.type === "pickup" ? pickup : delivery) &&
                        (d.type === "delivery" || ["created", "scheduled"].includes(order.status)) && (
                        <Button variant="tonal" size="sm" icon="event_repeat" onClick={() => setScheduling(d.type)}>
                          Reprogramar
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === "payments" && (
          <Card
            title={`Pagado ${money(order.amount_paid_cents)} de ${money(order.total_cents)}`}
            action={
              <div className="row">
                {can("notifications.send") && order.balance_cents > 0 && open && (
                  <Button variant="text" icon="notifications" onClick={() => reminder.mutate(undefined)}>
                    Recordatorio
                  </Button>
                )}
                {can("payments.record", "notifications.send") && order.balance_cents > 0 && order.status !== "cancelled" && (
                  <PaymentLinkButton tenantId={tenantId} orderId={order.id} />
                )}
              </div>
            }
            variant="flush"
          >
            {payments.length === 0 ? (
              <Empty icon="payments" title="Sin pagos registrados" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Método</th>
                      <th>Registró</th>
                      <th>Estado</th>
                      <th className="right">Monto</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td className="nowrap">{dateTime(p.created_at)}</td>
                        <td>
                          {p.kind === "refund" ? "Reembolso · " : ""}
                          {PAYMENT_METHOD_LABEL[p.method]}
                          {p.provider !== "manual" && <span className="body-s muted"> · {p.provider}</span>}
                          {p.notes && <div className="body-s muted">{p.notes}</div>}
                        </td>
                        <td>{p.recorded_by ? name(p.recorded_by) : "Sistema"}</td>
                        <td>
                          <Badge tone={p.status === "succeeded" ? "success" : p.status === "failed" ? "error" : "warning"}>
                            {p.status === "succeeded" ? "Aplicado" : p.status === "failed" ? "Fallido" : "Pendiente"}
                          </Badge>
                        </td>
                        <td className="right num nowrap">{p.kind === "refund" ? `−${money(p.amount_cents)}` : money(p.amount_cents)}</td>
                        <td className="right">
                          {can("payments.refund") && p.kind === "payment" && p.status === "succeeded" && (
                            <IconButton icon="undo" label="Reembolsar" onClick={() => setRefunding(p)} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === "quality" && (
          <div className="col gap-16">
            {can("quality.report") && (
              <div className="row">
                <Button variant="tonal" icon="report" onClick={() => setReporting(true)}>
                  Reportar incidencia
                </Button>
              </div>
            )}
            {issues.length === 0 ? (
              <Card>
                <Empty icon="verified" title="Sin incidencias" />
              </Card>
            ) : (
              issues.map((i) => (
                <Card key={i.id}>
                  <div className="row between top wrap">
                    <div className="col gap-4 grow">
                      <div className="row wrap">
                        <Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge>
                        <Badge tone="outline">{ISSUE_TYPE_LABEL[i.type] ?? i.type}</Badge>
                        <Badge tone={i.status === "resolved" ? "success" : i.status === "dismissed" ? "neutral" : "warning"}>{ISSUE_STATUS_LABEL[i.status]}</Badge>
                      </div>
                      <div className="body-l">{i.description}</div>
                      <div className="body-s muted">
                        {i.phase_name ? `Fase: ${i.phase_name} · ` : ""}Reportó {name(i.reported_by)} {dateTime(i.created_at)}
                        {i.responsible_user_id && ` · Responsable: ${name(i.responsible_user_id)}`}
                      </div>
                      {i.resolution && <div className="body-m">Resolución: {i.resolution}</div>}
                    </div>
                    <div className="row">
                      {i.photo_paths.length > 0 && <IconButton icon="photo_library" label="Ver fotos" onClick={() => showPhotos(i.photo_paths)} />}
                      {can("quality.manage") && (
                        <Button variant="text" onClick={() => setResolving(i)}>
                          Seguimiento
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === "messages" && (
          <Card variant="flush">
            {notifications.length === 0 ? (
              <Empty icon="chat" title="Sin mensajes">
                Los mensajes se generan con los cambios de la orden según las plantillas de Ajustes.
              </Empty>
            ) : (
              <div className="list">
                {notifications.map((n) => {
                  const rendered = renderNotification(n, window.location.origin);
                  return (
                    <div key={n.id} className="list-item" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                      <Icon name={n.channel === "email" ? "mail" : "chat"} />
                      <div className="grow" style={{ minWidth: 200 }}>
                        <div className="headline">
                          {NOTIFICATION_EVENT_LABEL[n.event as NotificationEvent] ?? n.event} · {n.recipient}
                        </div>
                        <div className="supporting" style={{ whiteSpace: "pre-wrap" }}>
                          {rendered.body}
                        </div>
                        <div className="body-s muted">
                          {n.status === "sent" ? `Enviado ${dateTime(n.sent_at)}` : n.status === "failed" ? `Falló: ${n.last_error ?? ""}` : n.status === "cancelled" ? "Cancelado" : n.mode === "auto" ? "En cola (automático)" : "Pendiente de enviar"}
                        </div>
                      </div>
                      {can("notifications.send") && ["pending", "failed"].includes(n.status) && (
                        <div className="row">
                          {n.channel === "whatsapp" ? (
                            <Button
                              size="sm"
                              icon="send"
                              onClick={() => {
                                window.open(whatsappLink(n.recipient, rendered.body), "_blank", "noopener");
                                markNotification.mutate({ id: n.id, status: "sent" });
                              }}
                            >
                              WhatsApp
                            </Button>
                          ) : (
                            <Button size="sm" icon="send" onClick={() => sendEmail.mutate(n.id)} loading={sendEmail.isPending}>
                              Enviar
                            </Button>
                          )}
                          <IconButton icon="close" label="Descartar" onClick={() => markNotification.mutate({ id: n.id, status: "cancelled" })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {tab === "photos" && (
          <Card title="Fotos" action={<AddPhotoButton orderId={order.id} />}>
            <OrderPhotoGallery
              orderId={order.id}
              extra={[
                ...deliveries.flatMap((d) =>
                  d.proof_paths.map((path) => ({
                    path,
                    label: d.type === "pickup" ? "Recolección" : "Entrega",
                    at: d.completed_at,
                    by: d.completed_by,
                  })),
                ),
                ...issues.flatMap((i) =>
                  i.photo_paths.map((path) => ({ path, label: `Incidencia${i.phase_name ? ` · ${i.phase_name}` : ""}`, at: i.created_at, by: i.reported_by })),
                ),
              ]}
            />
          </Card>
        )}

        {tab === "history" && (
          <Card>
            <OrderHistory history={history} steps={steps} name={name} />
          </Card>
        )}
      </div>

      <PaymentDialog open={paying} order={order} onClose={() => setPaying(false)} />
      <RefundDialog open={!!refunding} payment={refunding} onClose={() => setRefunding(null)} />
      {scheduling && <ScheduleDialog open type={scheduling} order={order} addresses={addresses} onClose={() => setScheduling(null)} />}
      {editingStop && <EditStopDialog stop={editingStop} onClose={() => setEditingStop(null)} />}
      <IssueDialog open={reporting} order={order} steps={steps} onClose={() => setReporting(false)} />
      <ResolveIssueDialog open={!!resolving} issue={resolving} onClose={() => setResolving(null)} />
      <ReasonDialog
        open={cancelling}
        title={`Cancelar orden #${order.number}`}
        label="Motivo"
        confirmLabel="Cancelar orden"
        danger
        loading={setStatus.isPending}
        onClose={() => setCancelling(false)}
        onConfirm={(reason) => setStatus.mutate({ status: "cancelled", note: reason }, { onSuccess: () => setCancelling(false) })}
      />
      <ReasonDialog
        open={deleting}
        title={`Eliminar orden #${order.number}`}
        label="Motivo (queda en la Bitácora)"
        confirmLabel="Eliminar definitivamente"
        danger
        loading={remove.isPending}
        onClose={() => setDeleting(false)}
        onConfirm={(reason) =>
          remove.mutate(reason, {
            onSuccess: () => {
              setDeleting(false);
              if (sheet) sheet.close();
              else navigate("/orders", { replace: true });
            },
          })
        }
      />
      {photos.length > 0 && (
        <div className="scrim" onClick={() => setPhotos([])}>
          <div className="row wrap" style={{ justifyContent: "center", maxHeight: "90dvh", overflow: "auto" }}>
            {photos.map((u) => (
              <img key={u} src={u} alt="" style={{ maxWidth: "min(90vw, 640px)", borderRadius: 12 }} />
            ))}
          </div>
        </div>
      )}
      <BrowserReceipt bundle={q.data} link={link} />
    </Page>
  );
}

function PaymentLinkButton({ tenantId, orderId }: { tenantId: string; orderId: string }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setLoading(true);
    try {
      const r = await api<{ url: string }>("/api/payments/link", { tenant_id: tenantId, order_id: orderId });
      await navigator.clipboard?.writeText(r.url).catch(() => {});
      toast.show("Link de pago copiado", { action: { label: "Abrir", run: () => window.open(r.url, "_blank", "noopener") } });
    } catch (err) {
      toast.show(errorMessage(err), { error: true });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="text" icon="add_link" onClick={run} loading={loading}>
      Link de pago
    </Button>
  );
}

const FIELD_LABEL: Record<string, string> = {
  total_cents: "total",
  priority: "prioridad",
  promised_at: "fecha prometida",
  notes: "notas",
  internal_notes: "notas internas",
  customer_id: "cliente",
};

function describe(row: AuditRow, stepName: (id: string | null) => string, name: (id: string | null) => string): string | null {
  const a = row.after ?? {};
  const b = row.before ?? {};
  switch (row.entity_type) {
    case "orders":
      if (row.action === "insert") return "Creó la orden";
      if ("status" in a) {
        const note = row.context?.note ? ` — ${row.context.note}` : "";
        return `Cambió el estado a ${ORDER_STATUS_LABEL[a.status as OrderStatus] ?? a.status}${note}`;
      }
      if ("total_cents" in a) return `Actualizó el precio: ${money(Number(b.total_cents))} → ${money(Number(a.total_cents))}`;
      if ("payment_status" in a || "amount_paid_cents" in a || "current_step_id" in a || "workflow_id" in a) return null;
      {
        const fields = Object.keys(a).map((k) => FIELD_LABEL[k]).filter(Boolean);
        return fields.length ? `Editó ${fields.join(", ")}` : null;
      }
    case "order_production_steps": {
      const s = stepName(row.entity_id);
      if (row.action === "insert") return null;
      if (a.status === "done") return `Completó ${s}`;
      if (a.status === "in_progress") return `Inició ${s}`;
      if (a.status === "pending" && b.status === "done") return `Reabrió ${s}${row.context?.note ? ` — ${row.context.note}` : ""}`;
      if (a.status === "skipped") return `Omitió ${s}`;
      if ("assigned_to" in a) return a.assigned_to ? `Asignó ${s} a ${name(a.assigned_to as string)}` : `Liberó ${s}`;
      return null;
    }
    case "deliveries": {
      const t = DELIVERY_TYPE_LABEL[((a.type ?? b.type) as "pickup" | "delivery") ?? "delivery"] ?? "Parada";
      if (row.action === "insert") return `Programó ${t.toLowerCase()} para ${dateOnly(a.scheduled_date as string)}`;
      if ("status" in a) {
        const labels: Record<string, string> = {
          en_route: "en camino",
          arrived: "llegó al domicilio",
          completed: "completada",
          failed: `fallida${a.failure_reason ? `: ${a.failure_reason}` : ""}`,
          cancelled: "cancelada",
          assigned: "asignada",
        };
        return `${t}: ${labels[a.status as string] ?? a.status}`;
      }
      if ("courier_id" in a) return `${t}: courier ${name(a.courier_id as string)}`;
      return null;
    }
    case "payments":
      if (row.action !== "insert") return "status" in a ? `Pago en línea: ${a.status}` : null;
      return a.kind === "refund"
        ? `Registró reembolso de ${money(Number(a.amount_cents))}`
        : `Registró pago de ${money(Number(a.amount_cents))} (${PAYMENT_METHOD_LABEL[a.method as keyof typeof PAYMENT_METHOD_LABEL] ?? a.method})${a.status !== "succeeded" ? ` · ${a.status}` : ""}`;
    case "quality_issues":
      if (row.action === "insert") return `Reportó incidencia: ${a.description}`;
      if ("status" in a) return `Incidencia ${ISSUE_STATUS_LABEL[a.status as string]?.toLowerCase() ?? a.status}`;
      return null;
    case "payment_links":
      return row.action === "insert" ? `Generó link de pago por ${money(Number(a.amount_cents))}` : null;
    default:
      return null;
  }
}

function OrderHistory({ history, steps, name }: { history: AuditRow[]; steps: ProductionStep[]; name: (id: string | null) => string }) {
  const stepMap = new Map(steps.map((s) => [s.id, s.name]));
  const stepName = (id: string | null) => (id ? (stepMap.get(id) ?? "fase") : "fase");
  const rows = history
    .map((h) => ({ h, text: describe(h, stepName, name) }))
    .filter((r): r is { h: AuditRow; text: string } => !!r.text);
  if (!rows.length) return <Empty icon="history" title="Sin historial" />;
  return (
    <ul className="timeline">
      {rows.map(({ h, text }) => (
        <li key={h.id}>
          <span className="node done" />
          <div className="body-m">{text}</div>
          <div className="body-s muted">
            {dateTime(h.occurred_at)} · {h.actor_type === "webhook" ? "Pago en línea" : h.actor_type === "system" ? "Sistema" : name(h.actor_id)}
          </div>
        </li>
      ))}
    </ul>
  );
}
