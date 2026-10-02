import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page } from "../../app/Shell";
import { ORDER_STATUS_LABEL, type OrderStatus } from "../../domain/orders";
import { riskLevel } from "../../domain/production";
import { dateTime, money } from "../../lib/format";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Order } from "../../lib/types";
import { Chip, Empty, Icon, Loading } from "../../ui/components";
import { OrderStatusBadge, PaymentBadge, PriorityBadge, RiskBadge, FulfillmentBadge } from "../shared";

type Filter = "open" | "unpaid" | "all" | OrderStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Abiertas" },
  { value: "created", label: ORDER_STATUS_LABEL.created },
  { value: "scheduled", label: "Por recolectar" },
  { value: "in_production", label: ORDER_STATUS_LABEL.in_production },
  { value: "ready", label: ORDER_STATUS_LABEL.ready },
  { value: "out_for_delivery", label: ORDER_STATUS_LABEL.out_for_delivery },
  { value: "unpaid", label: "Con saldo" },
  { value: "delivered", label: ORDER_STATUS_LABEL.delivered },
  { value: "all", label: "Todas" },
];

type Row = Order & { customers: { name: string; phone: string | null } };

export function OrdersList() {
  const { tenantId, can, settings } = useTenant();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");

  const q = useQuery({
    queryKey: ["orders", tenantId, filter, search],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const term = search.trim();
      let query = supabase
        .from("orders")
        .select("*, customers!inner(name, phone)")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (filter === "open") query = query.not("status", "in", "(delivered,cancelled)");
      else if (filter === "unpaid") query = query.gt("balance_cents", 0).neq("status", "cancelled");
      else if (filter !== "all") query = query.eq("status", filter);
      if (term) {
        const n = Number(term.replace(/^#/, ""));
        if (Number.isInteger(n) && n > 0) query = query.eq("number", n);
        else query = query.ilike("customers.name", `%${term.replace(/[%,()]/g, "")}%`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as Row[];
    },
  });

  const rows = q.data ?? [];
  return (
    <Page title="Órdenes">
      <div className="col gap-16">
        <div className="search">
          <Icon name="search" />
          <input placeholder="Buscar por número o cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="chips">
          {FILTERS.map((f) => (
            <Chip key={f.value} on={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
            </Chip>
          ))}
        </div>
        <div className="card flush">
          {q.isLoading ? (
            <Loading />
          ) : rows.length === 0 ? (
            <Empty icon="receipt_long" title="No hay órdenes aquí" />
          ) : (
            <>
            <div className="list mobile-only">
              {rows.map((o) => (
                <Link key={o.id} to={`/orders/${o.id}`} className="list-item clickable">
                  <div className="grow">
                    <div className="headline">
                      #{o.number} · {o.customers.name}
                    </div>
                    <div className="row wrap gap-4 mt-8">
                      <FulfillmentBadge fulfillment={o.fulfillment} />
                      <OrderStatusBadge status={o.status} />
                      <PaymentBadge status={o.payment_status} />
                      <PriorityBadge priority={o.priority} />
                    </div>
                    <div className="supporting mt-8">Prometida {dateTime(o.promised_at)}</div>
                  </div>
                  <div className="trailing">
                    <div className="title-s num">{money(o.total_cents)}</div>
                    {o.balance_cents > 0 && o.status !== "cancelled" && <div className="body-s error-text num">{money(o.balance_cents)}</div>}
                  </div>
                </Link>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Cliente</th>
                    <th>Estado</th>
                    <th>Pago</th>
                    <th>Prometida</th>
                    <th className="right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const risk = ["delivered", "cancelled"].includes(o.status) ? "normal" : riskLevel(o.promised_at, new Date(), 0, settings.operations);
                    return (
                      <tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`)}>
                        <td className="title-s num">
                          <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()}>
                            {o.number}
                          </Link>
                        </td>
                        <td>
                          <div>{o.customers.name}</div>
                          <div className="mt-8">
                            <FulfillmentBadge fulfillment={o.fulfillment} />
                          </div>
                        </td>
                        <td>
                          <div className="row wrap gap-4">
                            <OrderStatusBadge status={o.status} />
                            <PriorityBadge priority={o.priority} />
                          </div>
                        </td>
                        <td>
                          <PaymentBadge status={o.payment_status} />
                        </td>
                        <td className="nowrap">
                          <div className="col gap-4">
                            <span>{dateTime(o.promised_at)}</span>
                            <RiskBadge risk={risk} />
                          </div>
                        </td>
                        <td className="right num nowrap">
                          <div>{money(o.total_cents)}</div>
                          {o.balance_cents > 0 && o.status !== "cancelled" && <div className="body-s error-text">Saldo {money(o.balance_cents)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </div>
      {can("orders.create") && (
        <Link className="fab" to="/orders/new">
          <Icon name="add" /> Nueva orden
        </Link>
      )}
    </Page>
  );
}
