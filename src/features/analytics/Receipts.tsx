import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ORDER_STATUSES, ORDER_STATUS_LABEL, type OrderStatus } from "../../domain/orders";
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, type OrderPaymentStatus, type PaymentMethod } from "../../domain/payments";
import { dateTime, money, zonedStart } from "../../lib/format";
import { useMemberNames } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import { Badge, Card, Empty, Loading } from "../../ui/components";
import { OrderStatusBadge, PaymentBadge } from "../shared";
import { Kpi } from "./charts";
import { count, CsvButton, Pager, ReportError } from "./common";
import { csvMoney, type DateRange } from "./range";

const PAGE = 50;
const MAX_EXPORT = 20_000;

/** Reads every page of a PostgREST query (for totals and CSV). */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < MAX_EXPORT; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ── Receipts (orders) ───────────────────────────────────────────────────────

interface ReceiptFilters {
  status: "" | OrderStatus;
  payment: "" | OrderPaymentStatus;
  fulfillment: "" | "delivery" | "walk_in";
  search: string;
}

interface ReceiptRow {
  id: string;
  number: number;
  created_at: string;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  fulfillment: "delivery" | "walk_in";
  subtotal_cents: number;
  discount_cents: number;
  loyalty_credit_cents: number;
  delivery_fee_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  created_by: string | null;
  customers: { name: string; phone: string | null };
}

const RECEIPT_COLUMNS =
  "id, number, created_at, status, payment_status, fulfillment, subtotal_cents, discount_cents, loyalty_credit_cents, delivery_fee_cents, tax_cents, total_cents, amount_paid_cents, balance_cents, created_by, customers!inner(name, phone)";

export function ReceiptsReport({ range }: { range: DateRange }) {
  const { tenantId, tenant } = useTenant();
  const name = useMemberNames();
  const navigate = useNavigate();
  const [f, setF] = useState<ReceiptFilters>({ status: "", payment: "", fulfillment: "", search: "" });
  const search = useDebounced(f.search.trim());
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [range.from, range.to, f.status, f.payment, f.fulfillment, search]);

  const query = (columns: string, opts?: { count?: "exact" }) => {
    let q = supabase
      .from("orders")
      .select(columns, opts)
      .eq("tenant_id", tenantId)
      .gte("created_at", zonedStart(range.from, tenant?.timezone))
      .lt("created_at", zonedStart(range.to, tenant?.timezone, 1));
    if (f.status) q = q.eq("status", f.status);
    if (f.payment) q = q.eq("payment_status", f.payment).neq("status", "cancelled");
    if (f.fulfillment) q = q.eq("fulfillment", f.fulfillment);
    if (search) q = /^#?\d+$/.test(search) ? q.eq("number", Number(search.replace("#", ""))) : q.ilike("customers.name", `%${search}%`);
    return q;
  };
  const key = [tenantId, range.from, range.to, f.status, f.payment, f.fulfillment, search];

  const list = useQuery({
    queryKey: ["analytics-receipts", ...key, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error, count: total } = await query(RECEIPT_COLUMNS, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      return { rows: data as unknown as ReceiptRow[], total: total ?? 0 };
    },
  });
  const totals = useQuery({
    queryKey: ["analytics-receipts-totals", ...key],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const rows = await fetchAll<Pick<ReceiptRow, "status" | "total_cents" | "amount_paid_cents" | "balance_cents" | "discount_cents">>((a, b) =>
        query("status, total_cents, amount_paid_cents, balance_cents, discount_cents, customers!inner(name)").order("created_at").range(a, b) as never,
      );
      const live = rows.filter((r) => r.status !== "cancelled");
      const sum = (k: "total_cents" | "amount_paid_cents" | "balance_cents" | "discount_cents") => live.reduce((s, r) => s + Number(r[k]), 0);
      return { count: live.length, cancelled: rows.length - live.length, total: sum("total_cents"), paid: sum("amount_paid_cents"), balance: sum("balance_cents"), discount: sum("discount_cents") };
    },
  });

  const exportRows = async () => {
    const rows = await fetchAll<ReceiptRow>((a, b) => query(RECEIPT_COLUMNS).order("created_at", { ascending: false }).range(a, b) as never);
    return rows.map((r) => [
      r.number,
      r.created_at,
      r.customers.name,
      r.customers.phone,
      ORDER_STATUS_LABEL[r.status],
      r.fulfillment === "delivery" ? "Domicilio" : "Mostrador",
      csvMoney(r.subtotal_cents),
      csvMoney(r.discount_cents),
      csvMoney(r.loyalty_credit_cents),
      csvMoney(r.delivery_fee_cents),
      csvMoney(r.tax_cents),
      csvMoney(r.total_cents),
      csvMoney(r.amount_paid_cents),
      csvMoney(r.balance_cents),
      PAYMENT_STATUS_LABEL[r.payment_status],
      name(r.created_by),
    ]);
  };

  const t = totals.data;
  return (
    <div className="col gap-16">
      <div className="grid cols-4 kpis">
        <Kpi label="Recibos" icon="receipt_long" value={t ? count(t.count) : "…"} hint={t?.cancelled ? `${count(t.cancelled)} cancelados aparte` : undefined} />
        <Kpi label="Total vendido" icon="trending_up" value={t ? money(t.total) : "…"} hint={t?.discount ? `${money(t.discount)} en descuentos` : undefined} />
        <Kpi label="Pagado" icon="payments" value={t ? money(t.paid) : "…"} />
        <Kpi label="Por cobrar" icon="account_balance_wallet" value={t ? money(t.balance) : "…"} />
      </div>
      <Card
        variant="flush"
        title="Recibos del periodo"
        action={
          <CsvButton
            filename={`recibos_${range.from}_${range.to}`}
            header={["Orden", "Fecha", "Cliente", "Teléfono", "Estado", "Tipo", "Servicios", "Descuento", "Puntos", "Envío", "Impuestos", "Total", "Pagado", "Saldo", "Pago", "Registró"]}
            rows={exportRows}
          />
        }
      >
        <div className="filters" style={{ padding: "0 16px 12px" }}>
          <input className="input sm" type="search" placeholder="# orden o cliente" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} aria-label="Buscar" />
          <select className="input sm" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as ReceiptFilters["status"] })} aria-label="Estado">
            <option value="">Todos los estados</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select className="input sm" value={f.payment} onChange={(e) => setF({ ...f, payment: e.target.value as ReceiptFilters["payment"] })} aria-label="Pago">
            <option value="">Cualquier pago</option>
            {(Object.keys(PAYMENT_STATUS_LABEL) as OrderPaymentStatus[]).map((s) => (
              <option key={s} value={s}>
                {PAYMENT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select className="input sm" value={f.fulfillment} onChange={(e) => setF({ ...f, fulfillment: e.target.value as ReceiptFilters["fulfillment"] })} aria-label="Tipo">
            <option value="">Mostrador y domicilio</option>
            <option value="walk_in">Mostrador</option>
            <option value="delivery">Domicilio</option>
          </select>
        </div>
        {list.error ? (
          <ReportError error={list.error} />
        ) : !list.data ? (
          <Loading />
        ) : !list.data.rows.length ? (
          <Empty icon="receipt_long" title="Sin recibos con estos filtros" />
        ) : (
          <>
            <div className="table-wrap" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Orden</th>
                    <th>Fecha</th>
                    <th>Cliente</th>
                    <th>Estado</th>
                    <th>Pago</th>
                    <th className="right">Total</th>
                    <th className="right">Saldo</th>
                    <th>Registró</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/orders/${r.id}`)}>
                      <td className="nowrap">
                        <Link to={`/orders/${r.id}`} onClick={(e) => e.stopPropagation()}>
                          #{r.number}
                        </Link>
                      </td>
                      <td className="nowrap">{dateTime(r.created_at)}</td>
                      <td>{r.customers.name}</td>
                      <td>
                        <OrderStatusBadge status={r.status} />
                      </td>
                      <td>{r.status !== "cancelled" && <PaymentBadge status={r.payment_status} />}</td>
                      <td className="right num nowrap">{money(r.total_cents)}</td>
                      <td className="right num nowrap">{r.balance_cents > 0 && r.status !== "cancelled" ? money(r.balance_cents) : "—"}</td>
                      <td className="nowrap">{name(r.created_by)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={PAGE} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

// ── Payments ────────────────────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  created_at: string;
  kind: "payment" | "refund";
  method: PaymentMethod;
  provider: string;
  status: "pending" | "succeeded" | "failed";
  amount_cents: number;
  notes: string | null;
  recorded_by: string | null;
  orders: { id: string; number: number; customers: { name: string } };
}

const PAYMENT_COLUMNS = "id, created_at, kind, method, provider, status, amount_cents, notes, recorded_by, orders!inner(id, number, customers(name))";

export function PaymentsReport({ range }: { range: DateRange }) {
  const { tenantId, tenant } = useTenant();
  const name = useMemberNames();
  const [method, setMethod] = useState<"" | PaymentMethod>("");
  const [kind, setKind] = useState<"" | "payment" | "refund">("");
  const [status, setStatus] = useState<"" | "succeeded" | "pending" | "failed">("succeeded");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [range.from, range.to, method, kind, status]);

  const query = (columns: string, opts?: { count?: "exact" }) => {
    let q = supabase
      .from("payments")
      .select(columns, opts)
      .eq("tenant_id", tenantId)
      .gte("created_at", zonedStart(range.from, tenant?.timezone))
      .lt("created_at", zonedStart(range.to, tenant?.timezone, 1));
    if (method) q = q.eq("method", method);
    if (kind) q = q.eq("kind", kind);
    if (status) q = q.eq("status", status);
    return q;
  };
  const key = [tenantId, range.from, range.to, method, kind, status];
  const list = useQuery({
    queryKey: ["analytics-payments", ...key, page],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error, count: total } = await query(PAYMENT_COLUMNS, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      return { rows: data as unknown as PaymentRow[], total: total ?? 0 };
    },
  });
  const totals = useQuery({
    queryKey: ["analytics-payments-totals", ...key],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const rows = await fetchAll<Pick<PaymentRow, "kind" | "amount_cents" | "status">>((a, b) => query("kind, amount_cents, status").order("created_at").range(a, b) as never);
      const ok = rows.filter((r) => r.status === "succeeded");
      const pay = ok.filter((r) => r.kind === "payment").reduce((s, r) => s + Number(r.amount_cents), 0);
      const ref = ok.filter((r) => r.kind === "refund").reduce((s, r) => s + Number(r.amount_cents), 0);
      return { count: rows.length, pay, ref, net: pay - ref, avg: ok.length ? pay / Math.max(1, ok.filter((r) => r.kind === "payment").length) : 0 };
    },
  });
  const exportRows = async () => {
    const rows = await fetchAll<PaymentRow>((a, b) => query(PAYMENT_COLUMNS).order("created_at", { ascending: false }).range(a, b) as never);
    return rows.map((p) => [
      p.created_at,
      p.orders.number,
      p.orders.customers.name,
      p.kind === "refund" ? "Reembolso" : "Pago",
      PAYMENT_METHOD_LABEL[p.method],
      p.status,
      csvMoney(p.kind === "refund" ? -p.amount_cents : p.amount_cents),
      p.recorded_by ? name(p.recorded_by) : p.provider,
      p.notes,
    ]);
  };
  const t = totals.data;
  return (
    <div className="col gap-16">
      <div className="grid cols-4 kpis">
        <Kpi label="Cobrado neto" icon="payments" value={t ? money(t.net) : "…"} />
        <Kpi label="Pagos" icon="add_card" value={t ? money(t.pay) : "…"} hint={t ? `${count(t.count)} movimientos` : undefined} />
        <Kpi label="Reembolsos" icon="undo" value={t ? money(t.ref) : "…"} />
        <Kpi label="Pago promedio" icon="shopping_bag" value={t ? money(t.avg) : "…"} />
      </div>
      <Card
        variant="flush"
        title="Movimientos"
        action={
          <CsvButton filename={`pagos_${range.from}_${range.to}`} header={["Fecha", "Orden", "Cliente", "Tipo", "Método", "Estado", "Monto", "Registró", "Notas"]} rows={exportRows} />
        }
      >
        <div className="filters" style={{ padding: "0 16px 12px" }}>
          <select className="input sm" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} aria-label="Método">
            <option value="">Todos los métodos</option>
            {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
          <select className="input sm" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Tipo">
            <option value="">Pagos y reembolsos</option>
            <option value="payment">Solo pagos</option>
            <option value="refund">Solo reembolsos</option>
          </select>
          <select className="input sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Estado">
            <option value="succeeded">Aplicados</option>
            <option value="pending">Pendientes</option>
            <option value="failed">Fallidos</option>
            <option value="">Todos</option>
          </select>
        </div>
        {list.error ? (
          <ReportError error={list.error} />
        ) : !list.data ? (
          <Loading />
        ) : !list.data.rows.length ? (
          <Empty icon="payments" title="Sin pagos con estos filtros" />
        ) : (
          <>
            <div className="table-wrap" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Orden</th>
                    <th>Método</th>
                    <th>Registró</th>
                    <th>Estado</th>
                    <th className="right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap">{dateTime(p.created_at)}</td>
                      <td>
                        <Link to={`/orders/${p.orders.id}`}>#{p.orders.number}</Link> · {p.orders.customers.name}
                      </td>
                      <td className="nowrap">
                        {p.kind === "refund" && "Reembolso · "}
                        {PAYMENT_METHOD_LABEL[p.method]}
                      </td>
                      <td className="nowrap">{p.recorded_by ? name(p.recorded_by) : p.provider === "manual" ? "—" : "Pago en línea"}</td>
                      <td>
                        <Badge tone={p.status === "succeeded" ? "success" : p.status === "failed" ? "error" : "warning"}>
                          {p.status === "succeeded" ? "Aplicado" : p.status === "failed" ? "Fallido" : "Pendiente"}
                        </Badge>
                      </td>
                      <td className="right num nowrap">{p.kind === "refund" ? `−${money(p.amount_cents)}` : money(p.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={PAGE} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
