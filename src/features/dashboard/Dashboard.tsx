// Home, laid out like the original app: four numbers that matter today, the
// operational traffic light, the pipeline at a glance, what's ready to hand
// over and shortcuts.

import { useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Page } from "../../app/Shell";
import { useSheetNavigate } from "../../app/sheet";
import type { OrderStatus } from "../../domain/orders";
import { dateTime, money, relative } from "../../lib/format";
import { rpc, useWorkflows } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import { Badge, Icon, Loading, initials } from "../../ui/components";
import { ISSUE_TYPE_LABEL, OrderStatusBadge, SEVERITY_LABEL, SEVERITY_TONE } from "../shared";

interface Summary {
  day: string;
  orders_today: number;
  sales_today_cents: number;
  collected_today_cents: number;
  pickups_today: number;
  pickups_done_today: number;
  deliveries_today: number;
  deliveries_done_today: number;
  in_production: number;
  ready: number;
  overdue: number;
  pending_payments_count: number;
  pending_payments_cents: number;
  open_quality_issues: number;
  production: { step: string; count: number }[];
  overdue_orders: { id: string; number: number; status: OrderStatus; promised_at: string; customer_name: string }[];
  failed_deliveries: { id: string; type: string; failure_reason: string; order_id: string; number: number; customer_name: string }[];
  unpaid_delivered: { id: string; number: number; balance_cents: number; customer_name: string }[];
  quality_issues: { id: string; severity: string; type: string; description: string; phase_name: string | null; order_id: string; number: number }[];
}

interface OpenOrder {
  id: string;
  number: number;
  status: OrderStatus;
  fulfillment: "delivery" | "walk_in";
  current_step_id: string | null;
  total_cents: number;
  balance_cents: number;
  customers: { name: string };
  order_items: { name: string }[];
  order_production_steps: { id: string; name: string; workflow_step_id: string | null }[];
}

const STEP_COLORS = ["#7b61d9", "#4c7fd0", "#2a9bb5", "#b25db4", "#5b3fd1", "#d0577b"];

function Kpi({ label, value, meta, icon, tone, onClick }: { label: string; value: ReactNode; meta: ReactNode; icon: string; tone: string; onClick?: () => void }) {
  return (
    <button type="button" className={`hkpi ${tone}`} onClick={onClick} disabled={!onClick}>
      <span className="hkpi-head">
        <span className="hkpi-label">{label}</span>
        <span className="hkpi-icon">
          <Icon name={icon} />
        </span>
      </span>
      <span className="hkpi-value num">{value}</span>
      <span className="hkpi-meta">{meta}</span>
    </button>
  );
}

function QuickLink({ title, sub, icon, onClick, dark }: { title: string; sub: string; icon: string; onClick: () => void; dark?: boolean }) {
  return (
    <button type="button" className={`hlink${dark ? " dark" : ""}`} onClick={onClick}>
      <span className="hlink-icon">
        <Icon name={icon} />
      </span>
      <span className="grow">
        <span className="hlink-title">{title}</span>
        <span className="hlink-sub">{sub}</span>
      </span>
      <Icon name="chevron_right" />
    </button>
  );
}

export function Dashboard() {
  const { tenantId, tenant, ops, can } = useTenant();
  const navigate = useNavigate();
  const openOrder = useSheetNavigate();
  const workflows = useWorkflows();
  const [lightOpen, setLightOpen] = useState(false);
  const q = useQuery({
    queryKey: ["dashboard", tenantId],
    queryFn: () => rpc<Summary>("dashboard_summary", { p_tenant: tenantId }),
    refetchInterval: 60_000,
  });
  const orders = useQuery({
    queryKey: ["dashboard", tenantId, "open-orders"],
    enabled: can("orders.view", "production.view"),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("id, number, status, fulfillment, current_step_id, total_cents, balance_cents, customers(name), order_items(name), order_production_steps!order_production_steps_tenant_id_order_id_fkey(id, name, workflow_step_id)")
        .eq("tenant_id", tenantId)
        .not("status", "in", "(delivered,cancelled)")
        .order("promised_at", { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return data as unknown as OpenOrder[];
    },
  });

  const s = q.data;
  const open = orders.data ?? [];
  const ready = open.filter((o) => o.status === "ready");

  // Pipeline: the same columns as the board.
  const defaultWf = workflows.data?.workflows.find((w) => w.is_default) ?? workflows.data?.workflows[0];
  const wfSteps = (workflows.data?.steps ?? []).filter((x) => x.workflow_id === defaultWf?.id && x.active).sort((a, b) => a.position - b.position);
  const stepName = (o: OpenOrder) => o.order_production_steps.find((x) => x.id === o.current_step_id)?.name ?? "En producción";
  const pipeline: { key: string; label: string; color: string; count: number }[] = [
    { key: "pickup", label: "Por recolectar", color: "#c9962b", count: open.filter((o) => ["created", "scheduled"].includes(o.status) && o.fulfillment === "delivery").length },
    { key: "received", label: "Por capturar", color: "#c9762b", count: open.filter((o) => o.status === "picked_up" || (o.status === "created" && o.fulfillment === "walk_in")).length },
  ];
  const names = [...new Set([...wfSteps.map((x) => x.name), ...open.filter((o) => o.status === "in_production").map(stepName)])];
  names.forEach((n, i) =>
    pipeline.push({ key: `step:${n}`, label: n, color: STEP_COLORS[i % STEP_COLORS.length] ?? "#7b61d9", count: open.filter((o) => o.status === "in_production" && stepName(o) === n).length }),
  );
  pipeline.push({ key: "ready", label: "Listas", color: "#1f9d6b", count: ready.length });
  pipeline.push({ key: "route", label: "En ruta", color: "#ef6a47", count: open.filter((o) => o.status === "out_for_delivery").length });
  const shown = pipeline.filter((p) => p.count > 0);
  const total = shown.reduce((n, p) => n + p.count, 0);

  const alerts = s ? s.overdue_orders.length + s.failed_deliveries.length + s.unpaid_delivered.length + s.quality_issues.length : 0;
  const light = !s
    ? null
    : s.overdue > 0 || s.failed_deliveries.length > 0
      ? { tone: "red", label: "Atención inmediata", sub: `${s.overdue} atrasada${s.overdue === 1 ? "" : "s"}${s.failed_deliveries.length ? ` · ${s.failed_deliveries.length} visita${s.failed_deliveries.length === 1 ? "" : "s"} fallida${s.failed_deliveries.length === 1 ? "" : "s"}` : ""}` }
      : alerts > 0
        ? { tone: "amber", label: "Revisa pendientes", sub: `${alerts} pendiente${alerts === 1 ? "" : "s"} por atender` }
        : { tone: "green", label: "Operación en orden", sub: "Sin atrasos ni incidencias" };

  return (
    <Page title={`Hola, ${tenant?.display_name?.split(" ")[0] ?? ""}`} fab>
      {!s ? (
        <Loading />
      ) : (
        <div className="home">
          <div className="hkpis">
            <Kpi label="Activos" icon="inventory_2" tone="amber" value={open.length} meta="pedidos en el pipeline" onClick={() => navigate("/orders")} />
            {ops.delivery ? (
              <Kpi
                label="Paradas hoy"
                icon="local_shipping"
                tone="blue"
                value={s.pickups_today + s.deliveries_today}
                meta={`${s.pickups_today} recolecciones · ${s.deliveries_today} entregas`}
                onClick={can("delivery.view", "delivery.manage") ? () => navigate("/delivery") : undefined}
              />
            ) : (
              <Kpi label="En producción" icon="local_laundry_service" tone="blue" value={s.in_production} meta="en alguna fase" onClick={() => navigate("/orders")} />
            )}
            <Kpi label="Listos" icon="check_circle" tone="green" value={s.ready} meta={ops.delivery ? "para entregar o enviar" : "para entregar"} onClick={() => navigate("/orders")} />
            <Kpi
              label="Por cobrar"
              icon="account_balance_wallet"
              tone="gold"
              value={money(s.pending_payments_cents)}
              meta={`${s.pending_payments_count} pedido${s.pending_payments_count === 1 ? "" : "s"} pendiente${s.pending_payments_count === 1 ? "" : "s"}`}
              onClick={can("payments.view") ? () => navigate("/payments") : undefined}
            />
          </div>

          {light && (
            <div className={`hlight ${light.tone}`}>
              <button type="button" className="hlight-head" onClick={() => setLightOpen((v) => !v)} aria-expanded={lightOpen}>
                <span className="hlight-dot" />
                <span className="grow">
                  <span className="hlight-label">{light.label}</span>
                  <span className="hlight-sub">{light.sub}</span>
                </span>
                <span className="hlight-more">
                  <span className="desktop-only">Detalle</span>
                  <Icon name={lightOpen ? "expand_less" : "expand_more"} />
                </span>
              </button>
              {lightOpen && (
                <div className="hlight-body">
                  <div className="hlight-today">
                    <span>
                      Hoy <strong className="num">{s.orders_today}</strong> órdenes nuevas
                    </span>
                    <span>
                      Venta <strong className="num">{money(s.sales_today_cents)}</strong>
                    </span>
                    <span>
                      Cobrado <strong className="num">{money(s.collected_today_cents)}</strong>
                    </span>
                    {ops.delivery && (
                      <span>
                        Paradas hechas <strong className="num">{s.pickups_done_today + s.deliveries_done_today}/{s.pickups_today + s.deliveries_today}</strong>
                      </span>
                    )}
                  </div>
                  {alerts === 0 ? (
                    <div className="body-s muted">Nada pendiente.</div>
                  ) : (
                    <div className="list">
                      {s.overdue_orders.map((o) => (
                        <button key={`o${o.id}`} className="list-item clickable hlight-row" onClick={() => openOrder(`/orders/${o.id}`)}>
                          <Icon name="alarm" className="error-text" />
                          <span className="grow">
                            <span className="headline">
                              #{o.number} · {o.customer_name}
                            </span>
                            <span className="supporting">Atrasada {relative(o.promised_at)}</span>
                          </span>
                          <OrderStatusBadge status={o.status} />
                        </button>
                      ))}
                      {s.failed_deliveries.map((d) => (
                        <button key={`d${d.id}`} className="list-item clickable hlight-row" onClick={() => openOrder(`/orders/${d.order_id}`)}>
                          <Icon name="wrong_location" className="error-text" />
                          <span className="grow">
                            <span className="headline">
                              #{d.number} · {d.customer_name}
                            </span>
                            <span className="supporting">
                              {d.type === "pickup" ? "Recolección" : "Entrega"} fallida: {d.failure_reason}
                            </span>
                          </span>
                        </button>
                      ))}
                      {s.quality_issues.map((i) => (
                        <button key={`q${i.id}`} className="list-item clickable hlight-row" onClick={() => openOrder(`/orders/${i.order_id}`)}>
                          <Icon name="report" />
                          <span className="grow">
                            <span className="headline">
                              #{i.number} · {ISSUE_TYPE_LABEL[i.type] ?? i.type}
                              {i.phase_name ? ` en ${i.phase_name}` : ""}
                            </span>
                            <span className="supporting truncate">{i.description}</span>
                          </span>
                          <Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity as keyof typeof SEVERITY_LABEL]}</Badge>
                        </button>
                      ))}
                      {s.unpaid_delivered.map((o) => (
                        <button key={`p${o.id}`} className="list-item clickable hlight-row" onClick={() => openOrder(`/orders/${o.id}`)}>
                          <Icon name="money_off" />
                          <span className="grow">
                            <span className="headline">
                              #{o.number} · {o.customer_name}
                            </span>
                            <span className="supporting">Entregada con saldo pendiente</span>
                          </span>
                          <span className="title-s num">{money(o.balance_cents)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="home-grid">
            <div className="col gap-14">
              <button type="button" className="hcard hpipe" onClick={() => navigate("/orders")}>
                <span className="row between">
                  <span className="hcard-label">Pipeline</span>
                  <span className="hcard-link">Ver tablero →</span>
                </span>
                {total > 0 ? (
                  <>
                    <span className="hpipe-bar">
                      {shown.map((p) => (
                        <span key={p.key} style={{ flex: p.count, background: p.color }} title={`${p.label}: ${p.count}`} />
                      ))}
                    </span>
                    <span className="hpipe-legend">
                      {shown.map((p) => (
                        <span key={p.key}>
                          <span className="sw" style={{ background: p.color } as CSSProperties} />
                          {p.label} <strong className="num">{p.count}</strong>
                        </span>
                      ))}
                    </span>
                  </>
                ) : (
                  <span className="body-s muted">Sin pedidos activos</span>
                )}
              </button>

              {ready.length > 0 && (
                <div className="hcard">
                  <div className="row between">
                    <span className="hcard-label green">Listos para entregar</span>
                    <span className="hcount green">{ready.length}</span>
                  </div>
                  <div className="hready">
                    {ready.map((o) => (
                      <button key={o.id} type="button" className="hready-row" onClick={() => openOrder(`/orders/${o.id}`)}>
                        <span className="hready-avatar">{initials(o.customers.name)}</span>
                        <span className="grow">
                          <span className="hready-name truncate">{o.customers.name}</span>
                          <span className="hready-sub truncate">
                            #{o.number} · {o.order_items.length} servicio{o.order_items.length === 1 ? "" : "s"}
                            {o.order_items.length ? ` · ${o.order_items.slice(0, 2).map((i) => i.name).join(", ")}` : ""}
                          </span>
                        </span>
                        {o.fulfillment === "delivery" && ops.hybrid && <Icon name="local_shipping" className="muted" />}
                        <span className="hready-total num">{money(o.total_cents)}</span>
                        <Icon name="chevron_right" className="muted" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="col gap-10">
              <QuickLink title="Archivo" sub="Buscar cualquier pedido, también entregados" icon="inventory_2" onClick={() => navigate("/orders/archive")} />
              {can("reports.view") && <QuickLink title="Ventas" sub={`Hoy ${money(s.sales_today_cents)} · cobrado ${money(s.collected_today_cents)}`} icon="monitoring" onClick={() => navigate("/analytics")} />}
              {ops.delivery && can("delivery.execute") && <QuickLink title="Vista Delivery" sub="Ruta y entregas del día" icon="two_wheeler" onClick={() => navigate("/courier")} dark />}
              {can("settings.manage") && <QuickLink title="Back Office" sub="Catálogo, equipo y ajustes" icon="settings" onClick={() => navigate("/settings")} dark />}
              <p className="body-s muted" style={{ margin: "4px 4px 0" }}>
                Actualizado {dateTime(new Date().toISOString())}
              </p>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
