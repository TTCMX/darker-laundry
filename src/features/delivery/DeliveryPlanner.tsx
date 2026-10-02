import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "../../app/Shell";
import { dateOnly, money, todayISO } from "../../lib/format";
import { rpc, useAction, useMemberNames, useTeam } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Delivery, Route } from "../../lib/types";
import { Badge, Banner, Button, Card, Checkbox, Dialog, Empty, Icon, IconButton, Loading, Select, TextField } from "../../ui/components";
import { formatAddress, mapsUrl } from "../customers/CustomerDialogs";
import { DELIVERY_TYPE_LABEL, DeliveryStatusBadge, OrderStatusBadge } from "../shared";
import type { OrderStatus } from "../../domain/orders";
import { EditStopDialog } from "../orders/OrderDialogs";

type Stop = Delivery & { orders: { id: string; number: number; status: OrderStatus; balance_cents: number; customers: { name: string; phone: string | null } } };

export function DeliveryPlanner() {
  const { tenantId, can } = useTenant();
  const name = useMemberNames();
  const team = useTeam();
  const [day, setDay] = useState(todayISO());
  const [editing, setEditing] = useState<Route | "new" | null>(null);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const canEdit = can("delivery.manage", "orders.edit");

  const q = useQuery({
    queryKey: ["deliveries", tenantId, day],
    queryFn: async () => {
      const [stops, routes, unscheduled, elsewhere] = await Promise.all([
        supabase
          .from("deliveries")
          .select("*, orders!inner(id, number, status, balance_cents, customers(name, phone))")
          .eq("tenant_id", tenantId)
          .eq("scheduled_date", day)
          .neq("status", "cancelled")
          .order("route_id", { nullsFirst: true })
          .order("stop_position")
          .order("window_start"),
        supabase.from("routes").select("*").eq("tenant_id", tenantId).eq("route_date", day).order("created_at"),
        supabase
          .from("orders")
          .select("id, number, status, fulfillment, customers(name), deliveries(type, status)")
          .eq("tenant_id", tenantId)
          .eq("fulfillment", "delivery")
          .in("status", ["created", "ready"])
          .limit(100),
        // Ready home deliveries scheduled for another day and not on a route yet:
        // a route can take them whatever their day.
        supabase
          .from("deliveries")
          .select("*, orders!inner(id, number, status, balance_cents, customers(name, phone))")
          .eq("tenant_id", tenantId)
          .eq("type", "delivery")
          .in("status", ["scheduled", "assigned"])
          .is("route_id", null)
          .eq("orders.status", "ready")
          .neq("scheduled_date", day)
          .order("scheduled_date")
          .limit(200),
      ]);
      for (const r of [stops, routes, unscheduled, elsewhere]) if (r.error) throw r.error;
      const pending = (unscheduled.data ?? []).filter((o) => {
        const need = o.status === "created" ? "pickup" : "delivery";
        return !(o.deliveries as { type: string; status: string }[]).some((d) => d.type === need && !["failed", "cancelled"].includes(d.status));
      });
      return { stops: (stops.data ?? []) as Stop[], routes: (routes.data ?? []) as Route[], pending, elsewhere: (elsewhere.data ?? []) as Stop[] };
    },
  });

  const stops = q.data?.stops ?? [];
  const unrouted = stops.filter((s) => !s.route_id);
  const elsewhere = q.data?.elsewhere ?? [];
  // Ready home deliveries with no stop at all: the route creates one.
  const readyUnscheduled: Unscheduled[] = (q.data?.pending ?? [])
    .filter((o) => o.status === "ready")
    .map((o) => ({ id: o.id, number: o.number, customer: (o.customers as unknown as { name: string }).name }));
  const routable = unrouted.filter((s) => !["completed", "failed", "cancelled"].includes(s.status)).length + elsewhere.length + readyUnscheduled.length;

  return (
    <Page
      title="Entregas"
      actions={
        <input className="input sm" type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Día" style={{ width: 160 }} />
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : (
        <div className="col gap-16">
          {!!q.data?.pending.length && (
            <Banner tone="warning" icon="pending_actions">
              <div className="title-s">Por programar</div>
              <div className="row wrap mt-8">
                {q.data.pending.map((o) => (
                  <Link key={o.id} className="chip" to={`/orders/${o.id}`}>
                    #{o.number} · {(o.customers as unknown as { name: string }).name} · {o.status === "created" ? "recolección" : "entrega"}
                  </Link>
                ))}
              </div>
            </Banner>
          )}

          <div className="grid cols-2" style={{ alignItems: "start" }}>
            <Card
              title={`Sin ruta (${unrouted.length})`}
              action={
                can("delivery.manage") && (
                  <Button variant="tonal" icon="route" onClick={() => setEditing("new")} disabled={!routable}>
                    Crear ruta
                  </Button>
                )
              }
              variant="flush"
            >
              {unrouted.length === 0 ? <Empty icon="task_alt" title="Todo asignado a rutas" /> : <StopList stops={unrouted} name={name} onEdit={canEdit ? setEditingStop : undefined} />}
            </Card>

            <div className="col gap-16">
              {(q.data?.routes ?? []).length === 0 && (
                <Card>
                  <Empty icon="route" title={`Sin rutas para ${dateOnly(day)}`} />
                </Card>
              )}
              {(q.data?.routes ?? []).map((r) => {
                const rs = stops.filter((s) => s.route_id === r.id).sort((a, b) => (a.stop_position ?? 0) - (b.stop_position ?? 0));
                const done = rs.filter((s) => ["completed", "failed"].includes(s.status)).length;
                return (
                  <Card
                    key={r.id}
                    title={
                      <div className="col gap-4">
                        <h3>{r.name || "Ruta"}</h3>
                        <span className="body-s muted">
                          {name(r.courier_id)} · {done}/{rs.length} paradas
                        </span>
                      </div>
                    }
                    action={
                      <div className="row">
                        <Badge tone={r.status === "completed" ? "success" : r.status === "in_progress" ? "warning" : "neutral"}>
                          {r.status === "completed" ? "Terminada" : r.status === "in_progress" ? "En curso" : "Planeada"}
                        </Badge>
                        {can("delivery.manage") && r.status !== "completed" && <IconButton icon="edit" label="Editar ruta" onClick={() => setEditing(r)} />}
                      </div>
                    }
                    variant="flush"
                  >
                    <StopList stops={rs} name={name} numbered onEdit={canEdit ? setEditingStop : undefined} />
                  </Card>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {editingStop && <EditStopDialog stop={editingStop} onClose={() => setEditingStop(null)} />}
      {editing && (
        <RouteDialog
          day={day}
          route={editing === "new" ? null : editing}
          stops={stops}
          elsewhere={elsewhere}
          unscheduled={readyUnscheduled}
          couriers={(team.data ?? []).filter((m) => m.active && m.role_home === "courier")}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}

function StopList({ stops, name, numbered, onEdit }: { stops: Stop[]; name: (id: string | null) => string; numbered?: boolean; onEdit?: (s: Stop) => void }) {
  return (
    <div className="list">
      {stops.map((s, i) => (
        <div key={s.id} className="list-item" style={{ alignItems: "flex-start" }}>
          <span className="lead" style={s.type === "pickup" ? { background: "var(--secondary-container)", color: "var(--on-secondary-container)" } : undefined}>
            {numbered ? i + 1 : <Icon name={s.type === "pickup" ? "move_to_inbox" : "local_shipping"} size="sm" />}
          </span>
          <div className="grow">
            <div className="headline">
              <Link to={`/orders/${s.orders.id}`}>#{s.orders.number}</Link> · {s.orders.customers.name}
            </div>
            <div className="supporting">
              {DELIVERY_TYPE_LABEL[s.type]} · {s.window_label ?? "Sin horario"} · {name(s.courier_id)}
            </div>
            <a className="body-s" href={mapsUrl(s.address)} target="_blank" rel="noreferrer">
              {formatAddress(s.address)}
            </a>
            {s.type === "delivery" && s.orders.balance_cents > 0 && <div className="body-s error-text">Cobrar {money(s.orders.balance_cents)}</div>}
          </div>
          <div className="col" style={{ alignItems: "flex-end" }}>
            <DeliveryStatusBadge status={s.status} />
            {onEdit && !["completed", "failed", "cancelled"].includes(s.status) && (
              <IconButton icon="edit" label="Editar parada" onClick={() => onEdit(s)} />
            )}
            {s.type === "delivery" && s.orders.status !== "ready" && s.orders.status !== "out_for_delivery" && s.orders.status !== "delivered" && (
              <OrderStatusBadge status={s.orders.status} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface Unscheduled {
  id: string;
  number: number;
  customer: string;
}

const VIRTUAL = "order:";

function RouteDialog({
  day,
  route,
  stops,
  elsewhere,
  unscheduled,
  couriers,
  onClose,
}: {
  day: string;
  route: Route | null;
  stops: Stop[];
  elsewhere: Stop[];
  unscheduled: Unscheduled[];
  couriers: { user_id: string; display_name: string }[];
  onClose: () => void;
}) {
  const { tenantId } = useTenant();
  const [nameValue, setName] = useState(route?.name ?? "");
  const [courier, setCourier] = useState(route?.courier_id ?? couriers[0]?.user_id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setSelected(
      route
        ? stops.filter((s) => s.route_id === route.id).sort((a, b) => (a.stop_position ?? 0) - (b.stop_position ?? 0)).map((s) => s.id)
        : // New route: today's stops plus every ready home delivery, whatever its day.
          [
            ...stops.filter((s) => !s.route_id && !["completed", "failed", "cancelled"].includes(s.status)).map((s) => s.id),
            ...elsewhere.map((s) => s.id),
            ...unscheduled.map((o) => VIRTUAL + o.id),
          ],
    );
  }, [route, stops, elsewhere, unscheduled]);

  const candidates = useMemo(
    () => [
      ...stops.filter((s) => (!s.route_id || s.route_id === route?.id) && !["completed", "failed", "cancelled"].includes(s.status)),
      ...elsewhere,
    ],
    [stops, elsewhere, route],
  );
  const byId = new Map([...stops, ...elsewhere].map((s) => [s.id, s]));
  const virtual = new Map(unscheduled.map((o) => [VIRTUAL + o.id, o]));
  const label = (id: string) => {
    const v = virtual.get(id);
    if (v) return { title: `#${v.number} · ${v.customer}`, detail: "Entrega · sin programar (se programa para este día)" };
    const s = byId.get(id);
    if (!s) return null;
    const when = s.scheduled_date !== day ? `programada ${dateOnly(s.scheduled_date)} → pasa a este día` : (s.window_label ?? "Sin horario");
    return { title: `#${s.orders.number} · ${s.orders.customers.name}`, detail: `${DELIVERY_TYPE_LABEL[s.type]} · ${when} · ${formatAddress(s.address)}` };
  };
  const move = (id: string, dir: -1 | 1) =>
    setSelected((ids) => {
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return ids;
      const next = [...ids];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const save = useAction(
    async () => {
      // Ready orders without a delivery stop get one for the route's day.
      const ids: string[] = [];
      for (const id of selected) {
        ids.push(
          id.startsWith(VIRTUAL)
            ? await rpc<string>("schedule_delivery", { p_order: id.slice(VIRTUAL.length), p_type: "delivery", p_date: day })
            : id,
        );
      }
      return rpc("save_route", {
        p_tenant: tenantId,
        p_route: route?.id ?? null,
        p_date: day,
        p_name: nameValue || null,
        p_courier: courier || null,
        p_delivery_ids: ids,
      });
    },
    { success: "Ruta guardada", invalidate: [["deliveries"], ["courier"], ["board"], ["order"]], dispatch: false },
  );

  return (
    <Dialog
      open
      wide
      title={route ? "Editar ruta" : "Nueva ruta"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={!selected.length} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Guardar ruta
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <div className="grid cols-2">
          <TextField label="Nombre" placeholder="Ruta mañana" value={nameValue} onChange={(e) => setName(e.target.value)} />
          <Select label="Courier" value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Sin courier" options={couriers.map((c) => ({ value: c.user_id, label: c.display_name }))} />
        </div>
        {couriers.length === 0 && <Banner tone="warning">No hay couriers. Invita a alguien con el rol Courier desde Equipo.</Banner>}
        <div className="title-s">Paradas en orden</div>
        <div className="list card flush">
          {selected.map((id, i) => {
            const l = label(id);
            if (!l) return null;
            return (
              <div key={id} className="list-item">
                <span className="lead">{i + 1}</span>
                <div className="grow">
                  <div className="headline">{l.title}</div>
                  <div className="supporting">{l.detail}</div>
                </div>
                <IconButton icon="arrow_upward" label="Subir" onClick={() => move(id, -1)} disabled={i === 0} />
                <IconButton icon="arrow_downward" label="Bajar" onClick={() => move(id, 1)} disabled={i === selected.length - 1} />
                <IconButton icon="remove_circle" label="Quitar" onClick={() => setSelected((ids) => ids.filter((x) => x !== id))} />
              </div>
            );
          })}
          {selected.length === 0 && <Empty icon="route" title="Agrega paradas" />}
        </div>
        {[...candidates.map((c) => c.id), ...virtual.keys()].filter((id) => !selected.includes(id)).length > 0 && (
          <>
            <div className="title-s">Disponibles</div>
            <div className="col gap-4">
              {[...candidates.map((c) => c.id), ...virtual.keys()]
                .filter((id) => !selected.includes(id))
                .map((id) => {
                  const l = label(id)!;
                  return <Checkbox key={id} checked={false} onChange={() => setSelected((ids) => [...ids, id])} label={`${l.title} · ${l.detail}`} />;
                })}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
