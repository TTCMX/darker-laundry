// "Pedidos": the whole life of every open order on one board, like the
// original app. Columns follow the order (to pick up → to capture → each
// production phase → ready → on the route → delivered today). A tap opens the
// order; swipe right / left (phone) or drag to another column (computer)
// moves it one step forward or back.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Page } from "../../app/Shell";
import { useSheetNavigate } from "../../app/sheet";
import { nextMove, prevMove, type FlowMove, type FlowOrder } from "../../domain/flow";
import { remainingMinutes, riskLevel, type RiskLevel } from "../../domain/production";
import { dateOnly, money, qty, unitLabel, todayISO, zonedStart } from "../../lib/format";
import { useMemberNames, useWorkflows } from "../../lib/queries";
import { useMoveOrder } from "./useMoveOrder";
import { useAuth, useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { DeliveryStatus, Order, ProductionStep } from "../../lib/types";
import { Banner, Icon, Loading } from "../../ui/components";
import { errorMessage } from "../../lib/errors";
import { FulfillmentBadge } from "../shared";

type Stop = { id: string; type: "pickup" | "delivery"; status: DeliveryStatus; scheduled_date: string; window_label: string | null; courier_id: string | null };

type BoardOrder = Order & {
  customers: { name: string; notes: string | null };
  order_items: { name: string; quantity: number; unit: string }[];
  order_production_steps: ProductionStep[];
  deliveries: Stop[];
};

interface Column {
  key: string;
  title: string;
  color: string;
  orders: BoardOrder[];
  collapsible?: boolean;
}

const STEP_COLORS: string[] = ["#7b61d9", "#4c7fd0", "#2a9bb5", "#b25db4", "#5b3fd1", "#d0577b"];
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2 } as const;
const RISK_RANK: Record<RiskLevel, number> = { overdue: 0, at_risk: 1, approaching: 2, normal: 3 };
const OPEN_STOP = (d: Stop) => !["completed", "failed", "cancelled"].includes(d.status);
const SELECT =
  "*, customers(name, notes), order_items(name, quantity, unit), order_production_steps!order_production_steps_tenant_id_order_id_fkey(*), deliveries(id, type, status, scheduled_date, window_label, courier_id)";

// Phones and tablets: swipe. A mouse: drag and drop.
const isTouch = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function OrdersBoard() {
  const { tenantId, tenant, can, settings, ops } = useTenant();
  const { user } = useAuth();
  const qc = useQueryClient();
  const open = useSheetNavigate();
  const name = useMemberNames();
  const workflows = useWorkflows();
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const [showDelivered, setShowDelivered] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; col: number } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // The source of a drag, readable during the drag itself (state lags a render).
  const dragRef = useRef<{ id: string; col: number } | null>(null);

  const q = useQuery({
    queryKey: ["board", tenantId],
    refetchInterval: 30_000,
    queryFn: async () => {
      const since = zonedStart(todayISO(), tenant?.timezone ?? "UTC");
      const [active, delivered] = await Promise.all([
        supabase
          .from("orders")
          .select(SELECT)
          .eq("tenant_id", tenantId)
          .not("status", "in", "(delivered,cancelled)")
          .order("promised_at", { ascending: true, nullsFirst: false })
          .limit(500),
        supabase.from("orders").select(SELECT).eq("tenant_id", tenantId).eq("status", "delivered").gte("delivered_at", since).order("delivered_at", { ascending: false }).limit(100),
      ]);
      if (active.error) throw active.error;
      if (delivered.error) throw delivered.error;
      return { active: active.data as BoardOrder[], delivered: delivered.data as BoardOrder[] };
    },
  });

  // Live: whatever anyone changes shows up here.
  useEffect(() => {
    if (!tenantId) return;
    // A single action touches several rows (order, phases, stops): refetch
    // once per burst of changes, not once per row.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries({ queryKey: ["board", tenantId] }), 400);
    };
    const channel = supabase.channel(`board-${tenantId}`);
    for (const table of ["orders", "order_production_steps", "deliveries"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `tenant_id=eq.${tenantId}` }, refresh);
    }
    channel.subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [tenantId, qc]);

  const { run, pendingId } = useMoveOrder();

  const actor = { user_id: user?.id ?? "", can_work: can("production.work"), can_manage: can("production.manage"), can };
  const flow = (o: BoardOrder): FlowOrder => ({
    status: o.status,
    fulfillment: o.fulfillment,
    current_step_id: o.current_step_id,
    items: o.order_items.length,
    steps: o.order_production_steps,
    deliveries: o.deliveries,
  });

  const isMineNow = (o: BoardOrder) => {
    if (o.status !== "in_production") return false;
    const s = o.order_production_steps.find((x) => x.id === o.current_step_id);
    return !!s && (s.assigned_to === user?.id || (!s.assigned_to && can("production.work")));
  };

  const columns = useMemo<Column[]>(() => {
    const now = new Date();
    const risk = (o: BoardOrder) => riskLevel(o.promised_at, now, remainingMinutes(o.order_production_steps), settings.operations);
    const term = search.trim().toLowerCase().replace(/^#/, "");
    const matches = (o: BoardOrder) => !term || o.customers.name.toLowerCase().includes(term) || String(o.number) === term;
    const active = (q.data?.active ?? [])
      .filter(matches)
      .filter((o) => !mine || isMineNow(o))
      .sort(
        (a, b) =>
          RISK_RANK[risk(a)] - RISK_RANK[risk(b)] ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          String(a.promised_at).localeCompare(String(b.promised_at)),
      );

    const cols: Column[] = [];
    const pickup = active.filter((o) => ["created", "scheduled"].includes(o.status) && o.fulfillment === "delivery");
    if (ops.delivery || pickup.length) cols.push({ key: "pickup", title: "Por recolectar", color: "#c9962b", orders: pickup });
    const received = active.filter((o) => o.status === "picked_up" || (o.status === "created" && o.fulfillment === "walk_in"));
    cols.push({ key: "received", title: "Por capturar", color: "#c9762b", orders: received });

    const defaultWf = workflows.data?.workflows.find((w) => w.is_default) ?? workflows.data?.workflows[0];
    const wfSteps = (workflows.data?.steps ?? []).filter((s) => s.workflow_id === defaultWf?.id && s.active).sort((a, b) => a.position - b.position);
    const byStep = new Map<string, Column>();
    wfSteps.forEach((s, i) => {
      const c: Column = { key: s.id, title: s.name, color: STEP_COLORS[i % STEP_COLORS.length] ?? "#7b61d9", orders: [] };
      byStep.set(s.id, c);
      byStep.set(`name:${s.name}`, c);
      cols.push(c);
    });
    for (const o of active.filter((x) => x.status === "in_production")) {
      const s = o.order_production_steps.find((x) => x.id === o.current_step_id);
      let col = (s?.workflow_step_id && byStep.get(s.workflow_step_id)) || (s && byStep.get(`name:${s.name}`));
      if (!col) {
        const key = `name:${s?.name ?? "?"}`;
        col = { key, title: s?.name ?? "En producción", color: STEP_COLORS[byStep.size % STEP_COLORS.length] ?? "#7b61d9", orders: [] };
        byStep.set(key, col);
        cols.push(col);
      }
      col.orders.push(o);
    }
    cols.push({ key: "ready", title: "Listas", color: "#1f9d6b", orders: active.filter((o) => o.status === "ready") });
    const route = active.filter((o) => o.status === "out_for_delivery");
    if (ops.delivery || route.length) cols.push({ key: "route", title: "En ruta", color: "#ef6a47", orders: route });
    if (!mine) {
      cols.push({ key: "delivered", title: "Entregadas hoy", color: "#8a8071", orders: (q.data?.delivered ?? []).filter(matches), collapsible: true });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, workflows.data, search, mine, user?.id, settings.operations, ops.delivery]);

  const allActive = q.data?.active ?? [];
  const mineCount = allActive.filter(isMineNow).length;

  const drop = (target: number) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    setOver(null);
    if (!d || d.col === target) return;
    const o = allActive.find((x) => x.id === d.id) ?? q.data?.delivered.find((x) => x.id === d.id);
    if (!o) return;
    run(o, target > d.col ? nextMove(flow(o), actor) : prevMove(flow(o), actor), target < d.col);
  };

  return (
    <Page title="Pedidos" fab>
      <div className="board-tools">
        <div className="search">
          <Icon name="search" />
          <input placeholder="Buscar por cliente o número" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {can("production.work") && (
          <div className="chips">
            <button className={`chip${!mine ? " on" : ""}`} onClick={() => setMine(false)}>
              Todos · {allActive.length}
            </button>
            <button className={`chip${mine ? " on" : ""}`} onClick={() => setMine(true)}>
              Me toca ahora · {mineCount}
            </button>
          </div>
        )}
      </div>
      {q.error ? (
        <Banner tone="error">No se pudo cargar el tablero: {errorMessage(q.error)}</Banner>
      ) : q.isLoading || workflows.isLoading ? (
        <Loading />
      ) : (
        <div className="kanban">
          {columns.map((col, index) => {
            const collapsed = col.collapsible && !showDelivered;
            const target = dragging && over === index && dragging.col !== index;
            return (
              <section
                key={col.key}
                className={`kcol${target ? " drop" : ""}`}
                style={{ "--col": col.color } as CSSProperties}
                aria-label={col.title}
                onDragOver={(e) => {
                  if (!dragRef.current) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOver(index);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((v) => (v === index ? null : v));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(index);
                }}
              >
                <button
                  type="button"
                  className="kcol-head"
                  onClick={col.collapsible ? () => setShowDelivered((v) => !v) : undefined}
                  disabled={!col.collapsible}
                >
                  <span className="kdot" />
                  <span className="kcol-title">{col.title}</span>
                  <span className="kcount">{col.orders.length}</span>
                  {col.collapsible && <Icon name={showDelivered ? "expand_less" : "expand_more"} size="sm" />}
                  {target && <span className="kdrop-hint">Soltar aquí</span>}
                </button>
                {!collapsed &&
                  (col.orders.length === 0 ? (
                    <div className="kempty">{target ? `Mover a ${col.title}` : "Sin pedidos"}</div>
                  ) : (
                    col.orders.map((o) => (
                      <BoardCard
                        key={o.id}
                        order={o}
                        next={col.key === "delivered" ? null : nextMove(flow(o), actor)}
                        prev={prevMove(flow(o), actor)}
                        busy={pendingId === o.id}
                        stepWho={(() => {
                          const s = o.status === "in_production" ? o.order_production_steps.find((x) => x.id === o.current_step_id) : null;
                          return s ? (s.assigned_to ? name(s.assigned_to) : "Libre") : null;
                        })()}
                        courier={(() => {
                          const d = o.deliveries.find((x) => OPEN_STOP(x) && x.courier_id);
                          return d?.courier_id ? name(d.courier_id) : null;
                        })()}
                        showMoney={can("payments.view", "orders.edit")}
                        onOpen={() => open(`/orders/${o.id}`)}
                        onMove={(back) => run(o, back ? prevMove(flow(o), actor) : nextMove(flow(o), actor), back)}
                        onDragStart={() => {
                          dragRef.current = { id: o.id, col: index };
                          // Re-rendering inside dragstart cancels the drag in Chrome.
                          setTimeout(() => setDragging(dragRef.current), 0);
                        }}
                        onDragEnd={() => {
                          dragRef.current = null;
                          setDragging(null);
                          setOver(null);
                        }}
                        draggable
                      />
                    ))
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </Page>
  );
}

function DateChip({ o }: { o: BoardOrder }) {
  const { settings } = useTenant();
  const stop = (type: Stop["type"]) => o.deliveries.find((d) => d.type === type && OPEN_STOP(d));
  if (o.status === "created" || o.status === "scheduled") {
    const p = stop("pickup");
    if (!p) return o.fulfillment === "delivery" ? <span className="kchip warn"><Icon name="event_busy" /> Sin recolección</span> : null;
    return (
      <>
        <span className="kchip pickup">
          <Icon name="inventory_2" /> {dateOnly(p.scheduled_date)}
        </span>
        {p.window_label && (
          <span className="kchip window">
            <Icon name="schedule" /> {p.window_label}
          </span>
        )}
      </>
    );
  }
  const d = o.fulfillment === "delivery" && ["ready", "out_for_delivery"].includes(o.status) ? stop("delivery") : null;
  if (d) {
    return (
      <span className="kchip ok">
        <Icon name="local_shipping" /> {dateOnly(d.scheduled_date)}
        {d.window_label ? ` · ${d.window_label}` : ""}
      </span>
    );
  }
  if (!o.promised_at || o.status === "delivered") return null;
  const risk = riskLevel(o.promised_at, new Date(), remainingMinutes(o.order_production_steps), settings.operations);
  return (
    <span className={`kchip risk-${risk}`} title="Fecha prometida">
      <Icon name={o.fulfillment === "delivery" ? "local_shipping" : "storefront"} /> {dateOnly(o.promised_at)}
    </span>
  );
}

function BoardCard({
  order: o,
  next,
  prev,
  busy,
  stepWho,
  courier,
  showMoney,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
  draggable,
}: {
  order: BoardOrder;
  next: FlowMove | null;
  prev: FlowMove | null;
  busy: boolean;
  stepWho: string | null;
  courier: string | null;
  showMoney: boolean;
  onOpen: () => void;
  onMove: (back: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  draggable: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; dx: number; swiping: boolean } | null>(null);
  const suppressClick = useRef(false);
  const items = o.order_items;

  const reset = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 0.2s, opacity 0.2s";
    el.style.transform = "";
    el.style.opacity = "";
    el.dataset.swipe = "";
  };

  return (
    <article
      ref={ref}
      className={`kcard${busy ? " busy" : ""}${o.priority !== "normal" ? ` prio-${o.priority}` : ""}`}
      draggable={draggable && !isTouch()}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", o.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (!t) return;
        touch.current = { x: t.clientX, y: t.clientY, dx: 0, swiping: false };
        if (ref.current) ref.current.style.transition = "none";
      }}
      onTouchMove={(e) => {
        const s = touch.current;
        if (!s) return;
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        if (!s.swiping && Math.abs(dy) > Math.abs(dx)) return;
        if (Math.abs(dx) > 14) s.swiping = true;
        if (!s.swiping || !ref.current) return;
        s.dx = dx;
        ref.current.style.transform = `translateX(${dx * 0.45}px)`;
        ref.current.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 320));
        ref.current.dataset.swipe = dx > 60 && next ? "next" : dx < -60 && prev ? "prev" : "";
      }}
      onTouchEnd={() => {
        const s = touch.current;
        touch.current = null;
        reset();
        if (!s?.swiping) return;
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 350);
        if (s.dx > 60) onMove(false);
        else if (s.dx < -60) onMove(true);
      }}
      onTouchCancel={() => {
        touch.current = null;
        reset();
      }}
      onClick={() => {
        if (!suppressClick.current) onOpen();
      }}
    >
      <div className="kcard-top">
        <div className="grow">
          <div className="kname truncate">{o.customers.name}</div>
          <div className="kchips">
            <span className="knum">#{o.number}</span>
            <FulfillmentBadge fulfillment={o.fulfillment} />
            <DateChip o={o} />
            {o.priority !== "normal" && <span className="kchip prio">{o.priority === "urgent" ? "Urgente" : "Alta"}</span>}
          </div>
        </div>
        {showMoney && o.total_cents > 0 && (
          <div className="kmoney">
            <div className="num">{money(o.total_cents)}</div>
            {o.balance_cents > 0 && o.status !== "cancelled" && <div className="kdue">debe {money(o.balance_cents)}</div>}
          </div>
        )}
      </div>
      {items.length > 0 ? (
        <div className="kitems">
          {items
            .slice(0, 4)
            .map((i) => `${qty(i.quantity)} ${unitLabel(i.unit)} ${i.name}`)
            .join(" · ")}
          {items.length > 4 ? ` +${items.length - 4}` : ""}
        </div>
      ) : (
        <div className="kitems missing">Sin servicios capturados</div>
      )}
      {(o.notes || o.customers.notes) && (
        <div className="knote">
          <Icon name="sticky_note_2" /> <span className="truncate">{o.notes || o.customers.notes}</span>
        </div>
      )}
      {(stepWho || courier) && (
        <div className="kwho">
          {stepWho && (
            <span>
              <Icon name="person" /> {stepWho}
            </span>
          )}
          {courier && (
            <span>
              <Icon name="two_wheeler" /> {courier}
            </span>
          )}
        </div>
      )}
      {(next || prev) && (
        <div className="kactions">
          {prev && (
            <button
              type="button"
              className="kback"
              title={prev.label}
              aria-label={prev.label}
              onClick={(e) => {
                e.stopPropagation();
                onMove(true);
              }}
            >
              <Icon name="undo" />
            </button>
          )}
          {next && (
            <button
              type="button"
              className="knext"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onMove(false);
              }}
            >
              {next.label} <Icon name="arrow_forward" />
            </button>
          )}
          <span className="khint">{isTouch() ? "‹ desliza ›" : <Icon name="drag_indicator" />}</span>
        </div>
      )}
    </article>
  );
}
