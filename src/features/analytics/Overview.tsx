import { useState } from "react";
import { ORDER_STATUS_LABEL, type OrderStatus } from "../../domain/orders";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "../../domain/payments";
import { money, qty } from "../../lib/format";
import { Card, Loading, Segmented } from "../../ui/components";
import { useReport } from "./Analytics";
import { BarList, Heatmap, Kpi, TrendChart } from "./charts";
import { CsvButton, ReportError } from "./common";
import { bucketLabel, csvMoney, type Bucket, type DateRange } from "./range";

export interface SalesKpis {
  orders: number;
  sales_cents: number;
  avg_ticket_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  credit_cents: number;
  delivery_fee_cents: number;
  tax_cents: number;
  outstanding_cents: number;
  delivery_orders: number;
  cancelled_orders: number;
  cancelled_cents: number;
  customers: number;
  new_customers: number;
  payments_count: number;
  payments_cents: number;
  refunds_cents: number;
  collected_cents: number;
  item_lines: number;
  kg: number;
  units: number;
}

interface SeriesPoint {
  bucket: string;
  orders: number;
  sales_cents: number;
  collected_cents: number;
}

export interface SalesReport {
  bucket: Bucket;
  current: SalesKpis;
  previous: SalesKpis;
  series: SeriesPoint[];
  previous_series: SeriesPoint[];
  by_fulfillment: { key: "delivery" | "walk_in"; orders: number; sales_cents: number }[];
  by_method: { key: PaymentMethod; count: number; payments_cents: number; refunds_cents: number }[];
  by_status: { key: OrderStatus; orders: number; sales_cents: number }[];
  heatmap: { dow: number; hour: number; orders: number }[];
}

type Metric = "sales_cents" | "orders" | "collected_cents";

const METRICS: { value: Metric; label: string }[] = [
  { value: "sales_cents", label: "Ventas" },
  { value: "orders", label: "Órdenes" },
  { value: "collected_cents", label: "Cobrado" },
];

const count = (n: number) => Math.round(n).toLocaleString("es-MX");

export function Overview({ range }: { range: DateRange }) {
  const q = useReport<SalesReport>("analytics_sales", range);
  const [metric, setMetric] = useState<Metric>("sales_cents");
  if (q.error) return <ReportError error={q.error} />;
  if (!q.data) return <Loading />;
  const { current: c, previous: p } = q.data;
  const fmt = metric === "orders" ? count : money;
  const points = q.data.series.map((s, i) => ({
    label: bucketLabel(s.bucket, q.data.bucket),
    value: Number(s[metric]),
    previous: q.data.previous_series[i] ? Number(q.data.previous_series[i][metric]) : undefined,
  }));
  const discounts = Number(c.discount_cents) + Number(c.credit_cents);

  return (
    <div className="col gap-16" style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}>
      <div className="grid cols-4 kpis">
        <Kpi label="Ventas" icon="trending_up" value={money(c.sales_cents)} current={c.sales_cents} previous={p.sales_cents} hint={`antes ${money(p.sales_cents)}`} />
        <Kpi label="Órdenes" icon="receipt_long" value={count(c.orders)} current={c.orders} previous={p.orders} hint={`${count(c.delivery_orders)} a domicilio`} />
        <Kpi label="Ticket promedio" icon="shopping_bag" value={money(c.avg_ticket_cents)} current={c.avg_ticket_cents} previous={p.avg_ticket_cents} />
        <Kpi label="Cobrado" icon="payments" value={money(c.collected_cents)} current={c.collected_cents} previous={p.collected_cents} hint={c.refunds_cents ? `${money(c.refunds_cents)} reembolsado` : undefined} />
        <Kpi label="Clientes nuevos" icon="person_add" value={count(c.new_customers)} current={c.new_customers} previous={p.new_customers} hint={`${count(c.customers)} compraron`} />
        <Kpi label="Por cobrar" icon="account_balance_wallet" value={money(c.outstanding_cents)} hint="De las órdenes del periodo" />
        <Kpi label="Descuentos y puntos" icon="percent" value={money(discounts)} current={discounts} previous={Number(p.discount_cents) + Number(p.credit_cents)} inverse hint={c.sales_cents ? `${Math.round((discounts / (Number(c.sales_cents) + discounts)) * 100)}% de la venta` : undefined} />
        <Kpi label="Cancelaciones" icon="block" value={count(c.cancelled_orders)} current={c.cancelled_orders} previous={p.cancelled_orders} inverse hint={c.cancelled_cents ? money(c.cancelled_cents) : undefined} />
      </div>

      <Card
        title="Evolución"
        action={
          <CsvButton
            filename={`ventas_${range.from}_${range.to}`}
            header={["Periodo", "Órdenes", "Ventas", "Cobrado"]}
            rows={() => q.data.series.map((s) => [s.bucket, s.orders, csvMoney(s.sales_cents), csvMoney(s.collected_cents)])}
          />
        }
      >
        <div className="col gap-16">
          <Segmented value={metric} onChange={setMetric} options={METRICS} />
          <TrendChart points={points} format={fmt} />
        </div>
      </Card>

      <div className="grid cols-2">
        <Card title="Mostrador vs. domicilio">
          <BarList
            format={money}
            rows={q.data.by_fulfillment.map((f) => ({
              key: f.key,
              label: f.key === "delivery" ? "Recolección y entrega" : "Mostrador",
              value: Number(f.sales_cents),
              sub: `${count(f.orders)} órdenes · ticket ${money(Number(f.sales_cents) / Math.max(1, f.orders))}`,
            }))}
          />
        </Card>
        <Card title="Cobrado por método">
          <BarList
            format={money}
            empty="Sin pagos en este periodo"
            rows={q.data.by_method.map((m) => ({
              key: m.key,
              label: PAYMENT_METHOD_LABEL[m.key] ?? m.key,
              value: Number(m.payments_cents) - Number(m.refunds_cents),
              sub: `${count(m.count)} pagos${m.refunds_cents ? ` · ${money(m.refunds_cents)} reembolsado` : ""}`,
            }))}
          />
        </Card>
        <Card title="¿Cuándo llegan las órdenes?">
          <Heatmap cells={q.data.heatmap} />
        </Card>
        <Card title="Estado actual de las órdenes del periodo">
          <BarList
            format={count}
            rows={q.data.by_status
              .sort((a, b) => b.orders - a.orders)
              .map((s) => ({ key: s.key, label: ORDER_STATUS_LABEL[s.key] ?? s.key, value: s.orders, display: count(s.orders), sub: money(s.sales_cents) }))}
          />
        </Card>
      </div>

      <Card title="Desglose de la venta">
        <div className="grid cols-4 kpis">
          <Kpi label="Servicios (antes de descuentos)" value={money(c.subtotal_cents)} />
          <Kpi label="Envíos cobrados" value={money(c.delivery_fee_cents)} current={c.delivery_fee_cents} previous={p.delivery_fee_cents} />
          <Kpi label="Impuestos" value={money(c.tax_cents)} />
          <Kpi label="Volumen" value={`${qty(Math.round(Number(c.kg) * 10) / 10)} kg`} hint={`${count(Number(c.units))} piezas · ${count(c.item_lines)} servicios`} current={Number(c.kg)} previous={Number(p.kg)} />
        </div>
      </Card>
    </div>
  );
}
