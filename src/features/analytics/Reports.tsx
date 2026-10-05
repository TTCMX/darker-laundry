import { Link } from "react-router-dom";
import { CUSTOMER_STATUS_LABEL, type CustomerStatus } from "../../domain/customers";
import { dateOnly, dateTime, money, qty, unitLabel } from "../../lib/format";
import { useTenant } from "../../lib/session";
import { Badge, Card, Empty, Loading } from "../../ui/components";
import { DELIVERY_TYPE_LABEL, ISSUE_STATUS_LABEL, ISSUE_TYPE_LABEL, SEVERITY_LABEL, SEVERITY_TONE } from "../shared";
import { useReport } from "./Analytics";
import { BarList, Kpi, TrendChart } from "./charts";
import { count, CsvButton, pct, ReportError } from "./common";
import { bucketLabel, csvMoney, type Bucket, type DateRange } from "./range";

const hours = (h: number | null | undefined) => (h === null || h === undefined ? "—" : Number(h) >= 48 ? `${qty(Math.round(Number(h) / 2.4) / 10)} días` : `${qty(Number(h))} h`);
const minutes = (m: number | null | undefined) => (m === null || m === undefined ? "—" : Number(m) >= 90 ? `${qty(Math.round(Number(m) / 6) / 10)} h` : `${m} min`);

// ── Services ────────────────────────────────────────────────────────────────

interface ServicesData {
  revenue_cents: number;
  products: {
    key: string;
    name: string;
    category: string;
    unit: string;
    orders: number;
    quantity: number;
    list_cents: number;
    revenue_cents: number;
    previous_revenue_cents: number;
    custom_price: boolean;
  }[];
  categories: { name: string; orders: number; revenue_cents: number }[];
  discounts: { id: string; name: string; orders: number; amount_cents: number }[];
  loyalty: { points_earned: number; points_redeemed: number; credit_cents: number; orders_redeeming: number };
}

export function ServicesReport({ range }: { range: DateRange }) {
  const q = useReport<ServicesData>("analytics_services", range);
  const { settings } = useTenant();
  if (q.error) return <ReportError error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const total = Number(d.revenue_cents);
  const l = d.loyalty;
  return (
    <div className="col gap-16" style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
      <Card
        variant="flush"
        title="Servicios más vendidos"
        action={
          <CsvButton
            filename={`servicios_${range.from}_${range.to}`}
            header={["Servicio", "Categoría", "Unidad", "Cantidad", "Órdenes", "Ingreso", "Ingreso periodo anterior", "Participación %"]}
            rows={() => d.products.map((p) => [p.name, p.category, unitLabel(p.unit), p.quantity, p.orders, csvMoney(p.revenue_cents), csvMoney(p.previous_revenue_cents), total ? ((Number(p.revenue_cents) / total) * 100).toFixed(1) : ""])}
          />
        }
      >
        {!d.products.length ? (
          <Empty icon="sell" title="Sin servicios vendidos en este periodo" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Servicio</th>
                  <th className="right">Cantidad</th>
                  <th className="right">Órdenes</th>
                  <th className="right">Ingreso</th>
                  <th className="right">%</th>
                  <th className="right">vs. anterior</th>
                </tr>
              </thead>
              <tbody>
                {d.products.map((p) => {
                  const prev = Number(p.previous_revenue_cents);
                  const c = prev ? (Number(p.revenue_cents) - prev) / prev : null;
                  return (
                    <tr key={p.key}>
                      <td>
                        <div>{p.name}</div>
                        <div className="body-s muted">{p.category}</div>
                      </td>
                      <td className="right num nowrap">
                        {qty(Number(p.quantity))} {unitLabel(p.unit)}
                      </td>
                      <td className="right num">{count(p.orders)}</td>
                      <td className="right num nowrap">{money(p.revenue_cents)}</td>
                      <td className="right num">{pct(Number(p.revenue_cents), total)}</td>
                      <td className="right num nowrap">
                        {c === null ? <span className="muted">nuevo</span> : <span className={`delta ${c >= 0 ? "up" : "down"}`}>{`${c >= 0 ? "+" : "−"}${Math.round(Math.abs(c) * 100)}%`}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td />
                  <td className="right num nowrap">{money(total)}</td>
                  <td className="right">100%</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      <div className="grid cols-2">
        <Card title="Por categoría">
          <BarList format={money} rows={d.categories.map((c) => ({ key: c.name, label: c.name, value: Number(c.revenue_cents), sub: `${count(c.orders)} órdenes` }))} />
        </Card>
        <Card title="Descuentos aplicados">
          <BarList
            format={money}
            empty="No se aplicaron descuentos"
            rows={d.discounts.map((x) => ({ key: x.id ?? x.name, label: x.name, value: Number(x.amount_cents), sub: `${count(x.orders)} órdenes` }))}
          />
        </Card>
      </div>
      {(settings.loyalty.enabled || l.points_earned > 0 || l.points_redeemed > 0) && (
        <Card title="Programa de lealtad">
          <div className="grid cols-4 kpis">
            <Kpi label="Puntos otorgados" icon="loyalty" value={count(l.points_earned)} />
            <Kpi label="Puntos canjeados" icon="redeem" value={count(l.points_redeemed)} hint={`${count(l.orders_redeeming)} órdenes`} />
            <Kpi label="Descuento por puntos" icon="percent" value={money(l.credit_cents)} />
            <Kpi label="Costo del programa" icon="savings" value={pct(Number(l.credit_cents), total)} hint="Del ingreso por servicios" />
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  orders?: number;
  spend_cents?: number;
  total_orders: number;
  lifetime_cents: number;
  last_at: string | null;
  status: CustomerStatus;
}

interface CustomersData {
  bucket: Bucket;
  total_customers: number;
  buyers: number;
  new_buyers: number;
  returning_buyers: number;
  repeat_buyers: number;
  registered: number;
  avg_orders_per_buyer: number;
  avg_spend_cents: number;
  balance_due_cents: number;
  previous_buyers: number;
  retained_buyers: number;
  by_status: Partial<Record<CustomerStatus, number>>;
  top: CustomerRow[];
  at_risk: CustomerRow[];
  new_series: { bucket: string; customers: number }[];
}

const STATUS_TONE: Record<CustomerStatus, "success" | "warning" | "error" | "neutral"> = { new: "neutral", active: "success", at_risk: "warning", inactive: "warning", churned: "error" };

export function CustomersReport({ range }: { range: DateRange }) {
  const q = useReport<CustomersData>("analytics_customers", range);
  if (q.error) return <ReportError error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const wa = (phone: string | null) => (phone ? `https://wa.me/${phone.replace(/\D/g, "")}` : null);
  return (
    <div className="col gap-16" style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
      <div className="grid cols-4 kpis">
        <Kpi label="Compraron" icon="group" value={count(d.buyers)} current={d.buyers} previous={d.previous_buyers} hint={`de ${count(d.total_customers)} clientes`} />
        <Kpi label="Nuevos" icon="person_add" value={count(d.new_buyers)} hint={`${count(d.returning_buyers)} regresaron`} />
        <Kpi label="Retención" icon="autorenew" value={pct(d.retained_buyers, d.previous_buyers)} hint="Compraron también en el periodo anterior" />
        <Kpi label="Compra promedio" icon="shopping_bag" value={money(d.avg_spend_cents)} hint={`${qty(Number(d.avg_orders_per_buyer))} órdenes por cliente`} />
      </div>
      <div className="grid cols-2">
        <Card title="Clientes nuevos">
          <TrendChart points={d.new_series.map((s) => ({ label: bucketLabel(s.bucket, d.bucket), value: s.customers }))} format={count} height={160} empty="Sin clientes nuevos en este periodo" />
        </Card>
        <Card title="Toda tu base de clientes">
          <BarList
            format={count}
            rows={(Object.keys(CUSTOMER_STATUS_LABEL) as CustomerStatus[]).map((s) => ({ key: s, label: CUSTOMER_STATUS_LABEL[s], value: d.by_status[s] ?? 0, display: count(d.by_status[s] ?? 0) }))}
          />
          <div className="body-s muted mt-16">Saldo por cobrar de clientes: {money(d.balance_due_cents)}</div>
        </Card>
      </div>
      <Card
        variant="flush"
        title="Mejores clientes del periodo"
        action={
          <CsvButton
            filename={`clientes_${range.from}_${range.to}`}
            header={["Cliente", "Teléfono", "Órdenes en el periodo", "Compra en el periodo", "Órdenes totales", "Compra total", "Última orden", "Estado"]}
            rows={() => d.top.map((c) => [c.name, c.phone, c.orders, csvMoney(c.spend_cents), c.total_orders, csvMoney(c.lifetime_cents), c.last_at, CUSTOMER_STATUS_LABEL[c.status]])}
          />
        }
      >
        <CustomerTable rows={d.top} period />
      </Card>
      <Card variant="flush" title="Clientes valiosos que dejaron de venir">
        {d.at_risk.length ? (
          <CustomerTable rows={d.at_risk} wa={wa} />
        ) : (
          <Empty icon="sentiment_satisfied" title="Nadie en riesgo">
            Tus clientes frecuentes siguen viniendo.
          </Empty>
        )}
      </Card>
    </div>
  );
}

function CustomerTable({ rows, period, wa }: { rows: CustomerRow[]; period?: boolean; wa?: (phone: string | null) => string | null }) {
  if (!rows.length) return <Empty icon="group" title="Sin compras en este periodo" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Cliente</th>
            {period && <th className="right">Órdenes</th>}
            {period && <th className="right">En el periodo</th>}
            <th className="right">Histórico</th>
            <th>Última orden</th>
            <th>Estado</th>
            {wa && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const link = wa?.(c.phone);
            return (
              <tr key={c.id}>
                <td>
                  <Link to={`/customers/${c.id}`}>{c.name}</Link>
                  {c.phone && <div className="body-s muted">{c.phone}</div>}
                </td>
                {period && <td className="right num">{count(c.orders)}</td>}
                {period && <td className="right num nowrap">{money(c.spend_cents)}</td>}
                <td className="right num nowrap">
                  {money(c.lifetime_cents)}
                  <div className="body-s muted">{count(c.total_orders)} órdenes</div>
                </td>
                <td className="nowrap">{dateOnly(c.last_at)}</td>
                <td>
                  <Badge tone={STATUS_TONE[c.status]}>{CUSTOMER_STATUS_LABEL[c.status]}</Badge>
                </td>
                {wa && (
                  <td>
                    {link && (
                      <a href={link} target="_blank" rel="noreferrer">
                        WhatsApp
                      </a>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Employees ───────────────────────────────────────────────────────────────

interface MemberStats {
  user_id: string;
  name: string;
  role: string;
  active: boolean;
  orders: number;
  sales_cents: number;
  payments: number;
  collected_cents: number;
  refunded_cents: number;
  steps: number;
  avg_minutes: number | null;
  on_time_steps: number;
  timed_steps: number;
  issues_reported: number;
  issues_responsible: number;
  stops_completed: number;
  stops_failed: number;
}

interface EmployeesData {
  members: MemberStats[];
  phases: { name: string; steps: number; avg_minutes: number | null; estimated_minutes: number | null }[];
}

export function EmployeesReport({ range }: { range: DateRange }) {
  const q = useReport<EmployeesData>("analytics_employees", range);
  const { ops } = useTenant();
  if (q.error) return <ReportError error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="col gap-16" style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
      <Card
        variant="flush"
        title="Desempeño por persona"
        action={
          <CsvButton
            filename={`empleados_${range.from}_${range.to}`}
            header={["Nombre", "Rol", "Órdenes creadas", "Venta registrada", "Pagos", "Cobrado", "Reembolsado", "Fases completadas", "Minutos promedio por fase", "Fases a tiempo %", "Incidencias reportadas", "Incidencias a su cargo", "Paradas completadas", "Paradas fallidas"]}
            rows={() =>
              d.members.map((m) => [
                m.name,
                m.role,
                m.orders,
                csvMoney(m.sales_cents),
                m.payments,
                csvMoney(m.collected_cents),
                csvMoney(m.refunded_cents),
                m.steps,
                m.avg_minutes,
                m.timed_steps ? Math.round((m.on_time_steps / m.timed_steps) * 100) : "",
                m.issues_reported,
                m.issues_responsible,
                m.stops_completed,
                m.stops_failed,
              ])
            }
          />
        }
      >
        {!d.members.length ? (
          <Empty icon="badge" title="Sin actividad del equipo" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th className="right">Órdenes</th>
                  <th className="right">Venta</th>
                  <th className="right">Cobrado</th>
                  <th className="right">Fases</th>
                  <th className="right">Tiempo prom.</th>
                  <th className="right">A tiempo</th>
                  {ops.delivery && <th className="right">Paradas</th>}
                  <th className="right">Incidencias</th>
                </tr>
              </thead>
              <tbody>
                {d.members.map((m) => (
                  <tr key={m.user_id}>
                    <td>
                      <div>
                        {m.name} {!m.active && <Badge>Inactivo</Badge>}
                      </div>
                      <div className="body-s muted">{m.role}</div>
                    </td>
                    <td className="right num">{m.orders ? count(m.orders) : "—"}</td>
                    <td className="right num nowrap">{m.sales_cents ? money(m.sales_cents) : "—"}</td>
                    <td className="right num nowrap">
                      {m.collected_cents ? money(m.collected_cents) : "—"}
                      {m.payments > 0 && <div className="body-s muted">{count(m.payments)} pagos</div>}
                    </td>
                    <td className="right num">{m.steps ? count(m.steps) : "—"}</td>
                    <td className="right num nowrap">{minutes(m.avg_minutes)}</td>
                    <td className="right num">{m.timed_steps ? pct(m.on_time_steps, m.timed_steps) : "—"}</td>
                    {ops.delivery && (
                    <td className="right num nowrap">
                      {m.stops_completed || m.stops_failed ? (
                        <>
                          {count(m.stops_completed)}
                          {m.stops_failed > 0 && <div className="body-s" style={{ color: "var(--error)" }}>{count(m.stops_failed)} fallidas</div>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    )}
                    <td className="right num nowrap">
                      {m.issues_responsible ? <span style={{ color: "var(--error)" }}>{count(m.issues_responsible)} a su cargo</span> : "—"}
                      {m.issues_reported > 0 && <div className="body-s muted">{count(m.issues_reported)} reportadas</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card variant="flush" title="Tiempos por fase de producción">
        {!d.phases.length ? (
          <Empty icon="local_laundry_service" title="Sin fases completadas en este periodo" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fase</th>
                  <th className="right">Completadas</th>
                  <th className="right">Tiempo real prom.</th>
                  <th className="right">Estimado</th>
                </tr>
              </thead>
              <tbody>
                {d.phases.map((p) => {
                  const slow = p.avg_minutes !== null && p.estimated_minutes !== null && p.avg_minutes > p.estimated_minutes;
                  return (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td className="right num">{count(p.steps)}</td>
                      <td className="right num nowrap" style={slow ? { color: "var(--error)", fontWeight: 600 } : undefined}>
                        {minutes(p.avg_minutes)}
                      </td>
                      <td className="right num nowrap">{minutes(p.estimated_minutes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="body-s muted" style={{ margin: 0 }}>
        El tiempo por fase va de “Iniciar” a “Completar”. Las fases completadas sin iniciarse cuentan, pero no tienen tiempo.
      </p>
    </div>
  );
}

// ── Operations ──────────────────────────────────────────────────────────────

interface OperationsData {
  delivered_orders: number;
  avg_hours_to_ready: number | null;
  avg_hours_to_deliver: number | null;
  with_promise: number;
  on_time: number;
  late_open: number;
  cancelled: number;
  cancel_reasons: { reason: string; count: number }[];
  stops: { type: "pickup" | "delivery"; scheduled: number; completed: number; failed: number; pending: number }[];
  failure_reasons: { reason: string; count: number }[];
  by_window: { window: string; stops: number }[];
}

export function OperationsReport({ range }: { range: DateRange }) {
  const q = useReport<OperationsData>("analytics_operations", range);
  const { ops } = useTenant();
  if (q.error) return <ReportError error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="col gap-16" style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
      <div className="grid cols-4 kpis">
        <Kpi label="Órdenes entregadas" icon="done_all" value={count(d.delivered_orders)} />
        <Kpi label={ops.delivery ? "Entregas a tiempo" : "Listas a tiempo"} icon="schedule" value={pct(d.on_time, d.with_promise)} hint={`${count(d.on_time)} de ${count(d.with_promise)} con fecha prometida`} />
        <Kpi label="De recibida a lista" icon="local_laundry_service" value={hours(d.avg_hours_to_ready)} hint="Promedio" />
        <Kpi label="De recibida a entregada" icon="local_shipping" value={hours(d.avg_hours_to_deliver)} hint="Promedio" />
      </div>
      <div className="grid cols-2">
        {ops.delivery && (
          <>
        <Card title="Recolecciones y entregas programadas">
          {!d.stops.length ? (
            <Empty icon="local_shipping" title="Sin paradas en este periodo" />
          ) : (
            <div className="col gap-16">
              {d.stops.map((s) => (
                <div key={s.type} className="col gap-4">
                  <div className="row between">
                    <span className="title-s">{DELIVERY_TYPE_LABEL[s.type]}</span>
                    <span className="num">{count(s.scheduled)}</span>
                  </div>
                  <div className="barlist-track stacked">
                    <span style={{ width: pct(s.completed, s.scheduled), background: "var(--tertiary)" }} />
                    <span style={{ width: pct(s.failed, s.scheduled), background: "var(--error)" }} />
                  </div>
                  <div className="body-s muted">
                    {count(s.completed)} completadas ({pct(s.completed, s.scheduled)}) · {count(s.failed)} fallidas · {count(s.pending)} pendientes
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Paradas por horario">
          <BarList format={count} rows={d.by_window.map((w) => ({ key: w.window, label: w.window, value: w.stops, display: count(w.stops) }))} empty="Sin paradas" />
        </Card>
        <Card title="Motivos de visitas fallidas">
          <BarList format={count} rows={d.failure_reasons.map((r) => ({ key: r.reason, label: r.reason, value: r.count, display: count(r.count) }))} empty="Ninguna visita fallida" />
        </Card>
          </>
        )}
        <Card title={`Cancelaciones (${count(d.cancelled)})`}>
          <BarList format={count} rows={d.cancel_reasons.map((r) => ({ key: r.reason, label: r.reason, value: r.count, display: count(r.count) }))} empty="Ninguna orden cancelada" />
        </Card>
      </div>
      {d.late_open > 0 && (
        <p className="body-m" style={{ margin: 0 }}>
          Ahora mismo hay <strong>{count(d.late_open)}</strong> órdenes abiertas que ya pasaron su fecha prometida. <Link to="/dashboard">Ver en Inicio</Link>
        </p>
      )}
    </div>
  );
}

// ── Quality ─────────────────────────────────────────────────────────────────

interface QualityData {
  bucket: Bucket;
  total: number;
  previous_total: number;
  orders: number;
  orders_with_issues: number;
  open: number;
  open_now: number;
  resolved: number;
  avg_hours_to_resolve: number | null;
  by_type: { key: string; count: number }[];
  by_severity: { key: string; count: number }[];
  by_status: { key: string; count: number }[];
  by_phase: { key: string; count: number }[];
  by_responsible: { user_id: string; name: string | null; count: number }[];
  series: { bucket: string; issues: number }[];
  items: {
    id: string;
    created_at: string;
    type: string;
    severity: string;
    status: string;
    description: string;
    phase_name: string | null;
    resolution: string | null;
    resolved_at: string | null;
    order_id: string;
    number: number;
    customer_name: string;
    reported_by_name: string | null;
    responsible_name: string | null;
  }[];
}

export function QualityReport({ range }: { range: DateRange }) {
  const q = useReport<QualityData>("analytics_quality", range);
  if (q.error) return <ReportError error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const list = (rows: { key: string; count: number }[], labels: Record<string, string>) =>
    rows.map((r) => ({ key: r.key, label: labels[r.key] ?? r.key, value: r.count, display: count(r.count) }));
  return (
    <div className="col gap-16" style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
      <div className="grid cols-4 kpis">
        <Kpi label="Incidencias" icon="report" value={count(d.total)} current={d.total} previous={d.previous_total} inverse />
        <Kpi label="Órdenes afectadas" icon="receipt_long" value={pct(d.orders_with_issues, d.orders)} hint={`${count(d.orders_with_issues)} de ${count(d.orders)} órdenes`} />
        <Kpi label="Abiertas hoy" icon="pending_actions" value={count(d.open_now)} hint={`${count(d.open)} de este periodo`} />
        <Kpi label="Tiempo para resolver" icon="timer" value={hours(d.avg_hours_to_resolve)} hint={`${count(d.resolved)} resueltas`} />
      </div>
      <div className="grid cols-2">
        <Card title="Incidencias en el tiempo">
          <TrendChart points={d.series.map((s) => ({ label: bucketLabel(s.bucket, d.bucket), value: s.issues }))} format={count} height={160} empty="Sin incidencias en este periodo" />
        </Card>
        <Card title="Por tipo">
          <BarList format={count} rows={list(d.by_type, ISSUE_TYPE_LABEL)} empty="Sin incidencias" />
        </Card>
        <Card title="Por fase">
          <BarList format={count} rows={list(d.by_phase, {})} empty="Sin incidencias" />
        </Card>
        <Card title="Por severidad y responsable">
          <div className="col gap-16">
            <BarList format={count} rows={list(d.by_severity, SEVERITY_LABEL)} empty="Sin incidencias" />
            {d.by_responsible.length > 0 && (
              <BarList format={count} rows={d.by_responsible.map((r) => ({ key: r.user_id, label: r.name ?? "—", value: r.count, display: count(r.count) }))} />
            )}
          </div>
        </Card>
      </div>
      <Card
        variant="flush"
        title="Detalle"
        action={
          <CsvButton
            filename={`incidencias_${range.from}_${range.to}`}
            header={["Fecha", "Orden", "Cliente", "Tipo", "Severidad", "Estado", "Fase", "Descripción", "Reportó", "Responsable", "Resolución", "Resuelta"]}
            rows={() =>
              d.items.map((i) => [
                i.created_at,
                i.number,
                i.customer_name,
                ISSUE_TYPE_LABEL[i.type] ?? i.type,
                SEVERITY_LABEL[i.severity as keyof typeof SEVERITY_LABEL] ?? i.severity,
                ISSUE_STATUS_LABEL[i.status] ?? i.status,
                i.phase_name,
                i.description,
                i.reported_by_name,
                i.responsible_name,
                i.resolution,
                i.resolved_at,
              ])
            }
          />
        }
      >
        {!d.items.length ? (
          <Empty icon="verified" title="Sin incidencias en este periodo" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Orden</th>
                  <th>Incidencia</th>
                  <th>Severidad</th>
                  <th>Estado</th>
                  <th>Responsable</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={i.id}>
                    <td className="nowrap">{dateTime(i.created_at)}</td>
                    <td className="nowrap">
                      <Link to={`/orders/${i.order_id}`}>#{i.number}</Link>
                      <div className="body-s muted">{i.customer_name}</div>
                    </td>
                    <td>
                      <div>
                        {ISSUE_TYPE_LABEL[i.type] ?? i.type}
                        {i.phase_name && <span className="muted"> · {i.phase_name}</span>}
                      </div>
                      <div className="body-s muted">{i.description}</div>
                    </td>
                    <td>
                      <Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity as keyof typeof SEVERITY_LABEL] ?? i.severity}</Badge>
                    </td>
                    <td>{ISSUE_STATUS_LABEL[i.status] ?? i.status}</td>
                    <td className="nowrap">{i.responsible_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
