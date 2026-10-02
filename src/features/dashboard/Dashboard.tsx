import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Page } from "../../app/Shell";
import type { OrderStatus } from "../../domain/orders";
import { dateTime, money, relative } from "../../lib/format";
import { rpc } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { Badge, Card, Empty, Icon, Loading, Stat } from "../../ui/components";
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

export function Dashboard() {
  const { tenantId, tenant, ops } = useTenant();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["dashboard", tenantId],
    queryFn: () => rpc<Summary>("dashboard_summary", { p_tenant: tenantId }),
    refetchInterval: 60_000,
  });
  const s = q.data;
  const maxStep = Math.max(1, ...(s?.production ?? []).map((p) => p.count));
  const alerts = s ? s.overdue_orders.length + s.failed_deliveries.length + s.unpaid_delivered.length + s.quality_issues.length : 0;

  return (
    <Page title={`Hola, ${tenant?.display_name?.split(" ")[0] ?? ""}`}>
      {!s ? (
        <Loading />
      ) : (
        <div className="col gap-24">
          <section>
            <h2 className="title-m" style={{ margin: "0 0 12px" }}>
              Hoy
            </h2>
            <div className="grid cols-4">
              <Stat label="Órdenes nuevas" icon="receipt_long" value={s.orders_today} hint={money(s.sales_today_cents)} tone="accent" />
              <Stat label="Cobrado" icon="payments" value={money(s.collected_today_cents)} hint="Pagos registrados hoy" />
              {ops.delivery && (
                <>
                  <Stat label="Recolecciones" icon="move_to_inbox" value={`${s.pickups_done_today}/${s.pickups_today}`} hint="Completadas / programadas" />
                  <Stat label="Entregas" icon="local_shipping" value={`${s.deliveries_done_today}/${s.deliveries_today}`} hint="Completadas / programadas" />
                </>
              )}
              <Stat label="En producción" icon="local_laundry_service" value={s.in_production} />
              <Stat label="Listas" icon="check_circle" value={s.ready} hint="Esperando entrega" />
              <Stat label="Atrasadas" icon="alarm" value={s.overdue} tone={s.overdue ? "alert" : undefined} hint="Pasaron la fecha prometida" />
              <Stat label="Por cobrar" icon="account_balance_wallet" value={money(s.pending_payments_cents)} hint={`${s.pending_payments_count} órdenes`} />
            </div>
          </section>

          <div className="grid cols-2">
            <Card title="Producción" action={<Link to="/production">Ver tablero</Link>}>
              {s.production.length === 0 ? (
                <Empty icon="local_laundry_service" title="Nada en producción" />
              ) : (
                <div className="col gap-12">
                  {s.production.map((p) => (
                    <div key={p.step} className="col gap-4">
                      <div className="row between">
                        <span>{p.step}</span>
                        <span className="title-s num">{p.count}</span>
                      </div>
                      <div className="progress">
                        <span style={{ width: `${(p.count / maxStep) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title={`Alertas${alerts ? ` (${alerts})` : ""}`} variant="flush">
              {alerts === 0 ? (
                <Empty icon="verified" title="Todo en orden" />
              ) : (
                <div className="list">
                  {s.overdue_orders.map((o) => (
                    <div key={`o${o.id}`} className="list-item clickable" onClick={() => navigate(`/orders/${o.id}`)}>
                      <Icon name="alarm" className="error-text" />
                      <div className="grow">
                        <div className="headline">
                          #{o.number} · {o.customer_name}
                        </div>
                        <div className="supporting">Atrasada {relative(o.promised_at)}</div>
                      </div>
                      <OrderStatusBadge status={o.status} />
                    </div>
                  ))}
                  {s.failed_deliveries.map((d) => (
                    <div key={`d${d.id}`} className="list-item clickable" onClick={() => navigate(`/orders/${d.order_id}`)}>
                      <Icon name="wrong_location" className="error-text" />
                      <div className="grow">
                        <div className="headline">
                          #{d.number} · {d.customer_name}
                        </div>
                        <div className="supporting">
                          {d.type === "pickup" ? "Recolección" : "Entrega"} fallida: {d.failure_reason}
                        </div>
                      </div>
                    </div>
                  ))}
                  {s.quality_issues.map((q) => (
                    <div key={`q${q.id}`} className="list-item clickable" onClick={() => navigate(`/orders/${q.order_id}`)}>
                      <Icon name="report" />
                      <div className="grow">
                        <div className="headline">
                          #{q.number} · {ISSUE_TYPE_LABEL[q.type] ?? q.type}
                          {q.phase_name ? ` en ${q.phase_name}` : ""}
                        </div>
                        <div className="supporting truncate">{q.description}</div>
                      </div>
                      <Badge tone={SEVERITY_TONE[q.severity]}>{SEVERITY_LABEL[q.severity as keyof typeof SEVERITY_LABEL]}</Badge>
                    </div>
                  ))}
                  {s.unpaid_delivered.map((o) => (
                    <div key={`p${o.id}`} className="list-item clickable" onClick={() => navigate(`/orders/${o.id}`)}>
                      <Icon name="money_off" />
                      <div className="grow">
                        <div className="headline">
                          #{o.number} · {o.customer_name}
                        </div>
                        <div className="supporting">Entregada con saldo pendiente</div>
                      </div>
                      <span className="title-s num">{money(o.balance_cents)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
          <p className="body-s muted">Actualizado {dateTime(new Date().toISOString())}</p>
        </div>
      )}
    </Page>
  );
}
