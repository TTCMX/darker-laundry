import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "../../app/Shell";
import { remainingMinutes, riskLevel, stepActions, type RiskLevel } from "../../domain/production";
import { dateTime, qty, unitLabel } from "../../lib/format";
import { rpc, useAction, useMemberNames, useTeam, useWorkflows } from "../../lib/queries";
import { useAuth, useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Order, ProductionStep } from "../../lib/types";
import { Banner, Button, Chip, Icon, Loading } from "../../ui/components";
import { errorMessage } from "../../lib/errors";
import { PriorityBadge, RiskBadge } from "../shared";
import { IssueDialog } from "../orders/OrderDialogs";
import { AddPhotoButton } from "../orders/OrderPhotos";

type BoardOrder = Order & {
  customers: { name: string };
  order_items: { name: string; quantity: number; unit: string }[];
  order_production_steps: ProductionStep[];
};

interface Column {
  key: string;
  title: string;
  icon: string;
  orders: BoardOrder[];
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2 } as const;
const RISK_RANK: Record<RiskLevel, number> = { overdue: 0, at_risk: 1, approaching: 2, normal: 3 };

export function ProductionBoard() {
  const { tenantId, can, settings } = useTenant();
  const { user } = useAuth();
  const qc = useQueryClient();
  const name = useMemberNames();
  const team = useTeam();
  const workflows = useWorkflows();
  const [mine, setMine] = useState(false);
  const [reporting, setReporting] = useState<BoardOrder | null>(null);

  const q = useQuery({
    queryKey: ["board", tenantId],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*, customers(name), order_items(name, quantity, unit), order_production_steps!order_production_steps_tenant_id_order_id_fkey(*)")
        .eq("tenant_id", tenantId)
        .in("status", ["picked_up", "in_production", "ready"])
        .order("promised_at", { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return data as BoardOrder[];
    },
  });

  // Live updates: any change to orders or steps refreshes the board.
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel(`board-${tenantId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `tenant_id=eq.${tenantId}` }, () =>
        qc.invalidateQueries({ queryKey: ["board", tenantId] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "order_production_steps", filter: `tenant_id=eq.${tenantId}` }, () =>
        qc.invalidateQueries({ queryKey: ["board", tenantId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [tenantId, qc]);

  const act = useAction(
    (a: { kind: "start" | "claim" | "complete" | "assign" | "ready"; id: string; user?: string | null }) => {
      switch (a.kind) {
        case "start":
          return rpc("start_production", { p_order: a.id });
        case "claim":
          return rpc("assign_production_step", { p_step: a.id, p_user: user!.id });
        case "assign":
          return rpc("assign_production_step", { p_step: a.id, p_user: a.user ?? null });
        case "complete":
          return rpc("complete_production_step", { p_step: a.id });
        case "ready":
          return rpc("set_order_status", { p_order: a.id, p_status: "delivered" });
      }
    },
    { invalidate: [["board"], ["dashboard"], ["order"], ["orders"]] },
  );

  const columns = useMemo<Column[]>(() => {
    const orders = [...(q.data ?? [])];
    const now = new Date();
    const riskOf = (o: BoardOrder) => riskLevel(o.promised_at, now, remainingMinutes(o.order_production_steps), settings.operations);
    orders.sort(
      (a, b) =>
        RISK_RANK[riskOf(a)] - RISK_RANK[riskOf(b)] ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        String(a.promised_at).localeCompare(String(b.promised_at)),
    );
    const currentStep = (o: BoardOrder) => o.order_production_steps.find((s) => s.id === o.current_step_id) ?? null;
    const visible = mine
      ? orders.filter((o) => {
          const s = currentStep(o);
          return o.status === "in_production" && s && (s.assigned_to === user?.id || (!s.assigned_to && can("production.work")));
        })
      : orders;

    const defaultWf = workflows.data?.workflows.find((w) => w.is_default) ?? workflows.data?.workflows[0];
    const wfSteps = (workflows.data?.steps ?? []).filter((s) => s.workflow_id === defaultWf?.id && s.active).sort((a, b) => a.position - b.position);

    const cols: Column[] = [{ key: "received", title: "Recibidas", icon: "inventory_2", orders: visible.filter((o) => o.status === "picked_up") }];
    const byStep = new Map<string, Column>();
    for (const s of wfSteps) {
      const c = { key: s.id, title: s.name, icon: "local_laundry_service", orders: [] as BoardOrder[] };
      byStep.set(s.id, c);
      byStep.set(`name:${s.name}`, c);
      cols.push(c);
    }
    for (const o of visible.filter((x) => x.status === "in_production")) {
      const s = currentStep(o);
      const col = (s?.workflow_step_id && byStep.get(s.workflow_step_id)) || (s && byStep.get(`name:${s.name}`));
      if (col) col.orders.push(o);
      else {
        const key = `name:${s?.name ?? "?"}`;
        let extra = byStep.get(key);
        if (!extra) {
          extra = { key, title: s?.name ?? "Sin fase", icon: "local_laundry_service", orders: [] };
          byStep.set(key, extra);
          cols.push(extra);
        }
        extra.orders.push(o);
      }
    }
    cols.push({ key: "ready", title: "Listas", icon: "check_circle", orders: visible.filter((o) => o.status === "ready") });
    return cols;
  }, [q.data, workflows.data, mine, user?.id, can, settings.operations]);

  const actor = { user_id: user?.id ?? "", can_work: can("production.work"), can_manage: can("production.manage") };
  const producers = (team.data ?? []).filter((m) => m.active && m.role_home !== "courier");

  return (
    <Page
      title="Producción"
      actions={
        <Chip on={mine} icon="person" onClick={() => setMine((v) => !v)}>
          Mi trabajo
        </Chip>
      }
    >
      {q.error ? (
        <Banner tone="error">No se pudo cargar el tablero: {errorMessage(q.error)}</Banner>
      ) : q.isLoading || workflows.isLoading ? (
        <Loading />
      ) : (
        <div className="board">
          {columns.map((col) => (
            <section key={col.key} className="column" aria-label={col.title}>
              <div className="column-head">
                <span className="title-s">
                  <Icon name={col.icon} size="sm" /> {col.title}
                </span>
                <span className="badge">{col.orders.length}</span>
              </div>
              {col.orders.length === 0 && <div className="body-s muted" style={{ padding: 8 }}>Sin órdenes</div>}
              {col.orders.map((o) => {
                const step = o.order_production_steps.find((s) => s.id === o.current_step_id) ?? null;
                const risk = riskLevel(o.promised_at, new Date(), remainingMinutes(o.order_production_steps), settings.operations);
                const actions = step && o.status === "in_production" ? stepActions(step, actor) : [];
                const done = o.order_production_steps.filter((s) => s.status === "done").length;
                const total = o.order_production_steps.length;
                return (
                  <article key={o.id} className={`order-card ${risk}`}>
                    <div className="row between">
                      <Link to={`/orders/${o.id}`} className="title-m" style={{ color: "var(--on-surface)" }}>
                        #{o.number}
                      </Link>
                      <div className="row gap-4">
                        <PriorityBadge priority={o.priority} />
                        <RiskBadge risk={risk} />
                      </div>
                    </div>
                    <div className="body-m">{o.customers.name}</div>
                    <div className="body-s muted">
                      {o.order_items
                        .slice(0, 3)
                        .map((i) => `${qty(i.quantity)} ${unitLabel(i.unit)} ${i.name}`)
                        .join(" · ")}
                      {o.order_items.length > 3 ? ` +${o.order_items.length - 3}` : ""}
                    </div>
                    <div className="body-s muted">
                      <Icon name="schedule" size="sm" /> {dateTime(o.promised_at)}
                    </div>
                    {total > 0 && (
                      <div className="progress" title={`${done}/${total}`}>
                        <span style={{ width: `${(done / total) * 100}%` }} />
                      </div>
                    )}
                    {step && (
                      <div className="body-s">
                        <Icon name="person" size="sm" /> {step.assigned_to ? name(step.assigned_to) : <span className="muted">Libre</span>}
                        {step.requires_assignment && !step.assigned_to && <span className="muted"> · requiere asignación</span>}
                      </div>
                    )}
                    <div className="actions">
                      {o.status === "picked_up" && o.order_items.length === 0 && (
                        <Link className="btn tonal sm" to={`/orders/${o.id}/edit`}>
                          Capturar servicios
                        </Link>
                      )}
                      {o.status === "picked_up" && o.order_items.length > 0 && can("orders.edit", "production.manage") && (
                        <Button size="sm" icon="play_arrow" onClick={() => act.mutate({ kind: "start", id: o.id })}>
                          Iniciar
                        </Button>
                      )}
                      {step && actions.includes("claim") && (
                        <Button size="sm" variant="tonal" onClick={() => act.mutate({ kind: "claim", id: step.id })}>
                          Tomar
                        </Button>
                      )}
                      {step && actions.includes("complete") && (
                        <Button size="sm" icon="check" onClick={() => act.mutate({ kind: "complete", id: step.id })}>
                          {step.name} lista
                        </Button>
                      )}
                      {step && actions.includes("reassign") && (
                        <select
                          className="input sm"
                          style={{ width: "auto", minWidth: 120 }}
                          value={step.assigned_to ?? ""}
                          onChange={(e) => act.mutate({ kind: "assign", id: step.id, user: e.target.value || null })}
                          aria-label="Asignar"
                        >
                          <option value="">Sin asignar</option>
                          {producers.map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.display_name}
                            </option>
                          ))}
                        </select>
                      )}
                      {o.status === "ready" && o.fulfillment === "walk_in" && can("orders.edit") && (
                        <Button size="sm" variant="tonal" icon="done_all" onClick={() => act.mutate({ kind: "ready", id: o.id })}>
                          Entregada
                        </Button>
                      )}
                      <AddPhotoButton compact orderId={o.id} stepId={step?.id ?? null} />
                      {can("quality.report") && o.status === "in_production" && (
                        <button className="icon-btn" style={{ width: 32, height: 32 }} title="Reportar incidencia" onClick={() => setReporting(o)}>
                          <Icon name="report" size="sm" />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {reporting && (
        <IssueDialog open order={reporting} steps={reporting.order_production_steps} onClose={() => setReporting(null)} />
      )}
    </Page>
  );
}
