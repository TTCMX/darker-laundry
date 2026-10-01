import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "../../app/Shell";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "../../domain/payments";
import { dateTime, money, todayISO, zonedStart } from "../../lib/format";
import { useMemberNames } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Payment } from "../../lib/types";
import { Badge, Card, Empty, Loading, Stat } from "../../ui/components";

type Row = Payment & { orders: { id: string; number: number; customers: { name: string } } };

export function PaymentsPage() {
  const { tenantId, tenant } = useTenant();
  const name = useMemberNames();
  const [from, setFrom] = useState(todayISO(-6));
  const [to, setTo] = useState(todayISO());

  const q = useQuery({
    queryKey: ["payments", tenantId, from, to],
    queryFn: async () => {
      // Day boundaries in the tenant's time zone.
      const start = zonedStart(from, tenant?.timezone);
      const end = zonedStart(to, tenant?.timezone, 1);
      const { data, error } = await supabase
        .from("payments")
        .select("*, orders!inner(id, number, customers(name))")
        .eq("tenant_id", tenantId)
        .gte("created_at", start)
        .lt("created_at", end)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return data as Row[];
    },
  });

  const ok = (q.data ?? []).filter((p) => p.status === "succeeded");
  const net = ok.reduce((s, p) => s + (p.kind === "refund" ? -p.amount_cents : p.amount_cents), 0);
  const byMethod = new Map<string, number>();
  for (const p of ok) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + (p.kind === "refund" ? -p.amount_cents : p.amount_cents));

  return (
    <Page
      title="Pagos"
      actions={
        <div className="row">
          <input className="input sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
          <input className="input sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
        </div>
      }
    >
      <div className="col gap-16">
        <div className="grid cols-4">
          <Stat label="Cobrado neto" value={money(net)} tone="accent" icon="payments" />
          {[...byMethod.entries()].map(([m, v]) => (
            <Stat key={m} label={PAYMENT_METHOD_LABEL[m as PaymentMethod]} value={money(v)} />
          ))}
        </div>
        <Card variant="flush">
          {q.isLoading ? (
            <Loading />
          ) : !q.data?.length ? (
            <Empty icon="payments" title="Sin pagos en este periodo" />
          ) : (
            <div className="table-wrap">
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
                  {q.data.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap">{dateTime(p.created_at)}</td>
                      <td>
                        <Link to={`/orders/${p.orders.id}`}>#{p.orders.number}</Link> · {p.orders.customers.name}
                      </td>
                      <td>
                        {p.kind === "refund" && "Reembolso · "}
                        {PAYMENT_METHOD_LABEL[p.method]}
                      </td>
                      <td>{p.recorded_by ? name(p.recorded_by) : p.provider}</td>
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
          )}
        </Card>
      </div>
    </Page>
  );
}
