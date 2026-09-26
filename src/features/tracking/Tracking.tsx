import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { TRACKING_STAGES, trackingStageIndex, type OrderStatus } from "../../domain/orders";
import { PAYMENT_STATUS_LABEL, type OrderPaymentStatus } from "../../domain/payments";
import type { BreakdownStep } from "../../domain/pricing";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { dateOnly, dateTime, money, qty, setFormatContext, unitLabel } from "../../lib/format";
import { supabase } from "../../lib/supabase";
import { Badge, Banner, Button, Card, Empty, Icon, Loading } from "../../ui/components";
import { DELIVERY_STATUS_LABEL, DELIVERY_TYPE_LABEL } from "../shared";
import type { DeliveryStatus } from "../../lib/types";

interface PublicOrder {
  number: number;
  status: OrderStatus;
  fulfillment: "delivery" | "walk_in";
  created_at: string;
  promised_at: string | null;
  delivered_at: string | null;
  notes: string | null;
  currency: string;
  locale: string;
  business: { name: string; phone: string | null; email: string | null; logo_url: string | null; address: string | null };
  customer_first_name: string;
  items: { name: string; quantity: number; unit: string; net_cents: number; gross_cents: number }[];
  breakdown: BreakdownStep[];
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  payment_status: OrderPaymentStatus;
  production: { name: string; status: string; completed_at: string | null }[];
  deliveries: { type: "pickup" | "delivery"; status: DeliveryStatus; date: string; window: string | null; completed_at: string | null }[];
  online_payment: boolean;
}

export function TrackingPage() {
  const { token = "" } = useParams();
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["tracking", token],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_public_order", { p_token: token });
      if (error) throw error;
      return data as PublicOrder | null;
    },
  });
  const o = q.data;
  useEffect(() => {
    if (o) {
      setFormatContext({ currency: o.currency, locale: o.locale });
      document.title = `Orden #${o.number} · ${o.business.name}`;
    }
  }, [o]);

  if (q.isLoading) return <Loading />;
  if (!o) {
    return (
      <div className="center-page">
        <Empty icon="link_off" title="No encontramos esta orden">
          Revisa que el enlace esté completo.
        </Empty>
      </div>
    );
  }

  const stage = trackingStageIndex(o.status);
  const pay = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const r = await api<{ url: string }>("/api/public/pay", { token }, { auth: false });
      window.location.href = r.url;
    } catch (err) {
      setPayError(errorMessage(err));
      setPaying(false);
    }
  };

  return (
    <div style={{ minHeight: "100dvh", background: "var(--surface)" }}>
      <main className="tracking">
        <div className="row gap-12">
          {o.business.logo_url ? (
            <img src={o.business.logo_url} alt="" width={48} height={48} style={{ borderRadius: 12, objectFit: "cover" }} />
          ) : (
            <span className="avatar" style={{ width: 48, height: 48, fontSize: 20 }}>
              {o.business.name[0]}
            </span>
          )}
          <div>
            <div className="title-m">{o.business.name}</div>
            <div className="body-s muted">Orden #{o.number}</div>
          </div>
        </div>

        <Card variant="elevated">
          <div className="col gap-16">
            <div>
              <div className="body-m muted">Hola {o.customer_first_name},</div>
              <h1 className="headline-s" style={{ marginTop: 4 }}>
                {o.status === "cancelled"
                  ? "Tu orden fue cancelada"
                  : o.status === "delivered"
                    ? "Tu orden fue entregada"
                    : o.status === "ready"
                      ? o.fulfillment === "walk_in"
                        ? "Tu orden está lista para recoger"
                        : "Tu orden está lista"
                      : o.status === "out_for_delivery"
                        ? "Tu orden va en camino"
                        : o.status === "in_production"
                          ? "Estamos trabajando en tu orden"
                          : "Recibimos tu orden"}
              </h1>
            </div>
            {o.status !== "cancelled" && (
              <div className="stepper" aria-label="Progreso">
                {TRACKING_STAGES.filter((s) => o.fulfillment === "delivery" || s.key !== "delivery").map((s) => {
                  const i = TRACKING_STAGES.indexOf(s);
                  return (
                    <div key={s.key} className={`s ${i < stage || o.status === "delivered" ? "done" : i === stage ? "current" : ""}`}>
                      <span className="b" />
                      {s.label}
                    </div>
                  );
                })}
              </div>
            )}
            {o.promised_at && !["delivered", "cancelled"].includes(o.status) && (
              <div className="row">
                <Icon name="event" />
                <span>
                  Entrega estimada: <strong>{dateTime(o.promised_at)}</strong>
                </span>
              </div>
            )}
            {o.delivered_at && (
              <div className="row">
                <Icon name="done_all" />
                <span>Entregada {dateTime(o.delivered_at)}</span>
              </div>
            )}
          </div>
        </Card>

        {o.balance_cents > 0 && o.status !== "cancelled" && (
          <Card>
            <div className="row between wrap gap-12">
              <div>
                <div className="body-m muted">Saldo por pagar</div>
                <div className="headline-s num">{money(o.balance_cents)}</div>
              </div>
              {o.online_payment && (
                <Button size="lg" icon="credit_card" onClick={pay} loading={paying}>
                  Pagar ahora
                </Button>
              )}
            </div>
            {payError && <Banner tone="error">{payError}</Banner>}
          </Card>
        )}

        {o.production.length > 0 && o.status === "in_production" && (
          <Card title="Proceso">
            <ul className="timeline">
              {o.production.map((s, i) => {
                const current = s.status !== "done" && o.production.findIndex((x) => x.status !== "done") === i;
                return (
                  <li key={i}>
                    <span className={`node ${s.status === "done" ? "done" : current ? "current" : ""}`} />
                    <div className={current ? "title-s" : "body-m"}>{s.name}</div>
                    {s.completed_at && <div className="body-s muted">{dateTime(s.completed_at)}</div>}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {o.deliveries.length > 0 && (
          <Card title="Recolección y entrega">
            {o.deliveries.map((d, i) => (
              <div key={i} className="row between" style={{ padding: "6px 0" }}>
                <span>
                  {DELIVERY_TYPE_LABEL[d.type]} · {dateOnly(d.date)} {d.window ?? ""}
                </span>
                <Badge tone={d.status === "completed" ? "success" : d.status === "failed" ? "error" : "neutral"}>{DELIVERY_STATUS_LABEL[d.status]}</Badge>
              </div>
            ))}
          </Card>
        )}

        <Card title="Detalle">
          <div className="col gap-8">
            {o.items.map((i, idx) => (
              <div key={idx} className="row between">
                <span>
                  {qty(i.quantity)} {unitLabel(i.unit)} · {i.name}
                </span>
                <span className="num">{money(i.gross_cents)}</span>
              </div>
            ))}
            <hr className="divider" />
            {o.breakdown
              .filter((s) => s.key !== "list_subtotal" || o.breakdown.length > 2)
              .map((s) => (
                <div key={s.key} className={`row between ${s.key === "total" ? "title-m" : ""}`}>
                  <span>{s.label}</span>
                  <span className="num">{money(s.amount_cents)}</span>
                </div>
              ))}
            <div className="row between">
              <span>Pagado</span>
              <span className="num">{money(o.amount_paid_cents)}</span>
            </div>
            <div className="row between">
              <span>Estado de pago</span>
              <Badge tone={o.payment_status === "paid" ? "success" : "warning"}>{PAYMENT_STATUS_LABEL[o.payment_status]}</Badge>
            </div>
          </div>
        </Card>

        {o.notes && <Banner icon="sticky_note_2">{o.notes}</Banner>}

        <div className="body-s muted" style={{ textAlign: "center" }}>
          {[o.business.phone, o.business.email, o.business.address].filter(Boolean).join(" · ")}
        </div>
      </main>
    </div>
  );
}
