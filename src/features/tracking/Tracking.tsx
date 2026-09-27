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
  loyalty: { points_earned: number; points_redeemed: number; balance: number; point_value_cents: number } | null;
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
    <div className="tracking-page">
      <main className="tracking">
        <header className="row between">
          <div className="col" style={{ gap: 1 }}>
            <span className="body-s muted">Orden #{o.number}</span>
            <span className="title-s">{o.business.name}</span>
          </div>
          {o.business.logo_url ? (
            <img src={o.business.logo_url} alt="" width={44} height={44} className="avatar" style={{ objectFit: "cover", width: 44, height: 44 }} />
          ) : (
            <span className="avatar" style={{ width: 44, height: 44 }} aria-hidden>
              {o.business.name[0]}
            </span>
          )}
        </header>

        <section className={`hero ${o.status === "delivered" ? "mint" : o.status === "cancelled" ? "peach" : o.status === "ready" ? "butter" : ""}`}>
          <span className="hero-dot" aria-hidden />
          <div className="hero-body">
            {o.promised_at && !["delivered", "cancelled"].includes(o.status) ? (
              <span className="availability">
                <span className="dot" /> Entrega estimada · {dateTime(o.promised_at)}
              </span>
            ) : o.delivered_at ? (
              <span className="availability">
                <span className="dot" /> Entregada · {dateTime(o.delivered_at)}
              </span>
            ) : null}
            <h1>
              {o.status === "cancelled"
                ? "Tu orden fue cancelada."
                : o.status === "delivered"
                  ? "¡Listo! Tu ropa ya está en casa."
                  : o.status === "ready"
                    ? o.fulfillment === "walk_in"
                      ? "Tu ropa está lista para recoger."
                      : "Tu ropa está lista."
                    : o.status === "out_for_delivery"
                      ? "Tu ropa va en camino."
                      : o.status === "in_production"
                        ? "Estamos lavando tu ropa."
                        : "Recibimos tu orden."}
            </h1>
            <p>Hola {o.customer_first_name}, aquí puedes ver cómo va tu orden.</p>
          </div>
          {o.balance_cents > 0 && o.status !== "cancelled" && o.online_payment && (
            <button type="button" className="cta" onClick={pay} disabled={paying}>
              {paying ? "Abriendo pago…" : `Pagar ${money(o.balance_cents)}`}
              <span className="cta-arrow">
                <Icon name="arrow_forward" />
              </span>
            </button>
          )}
        </section>

        {o.status !== "cancelled" && (
          <section className="ticket">
            <div className="ticket-top">
              <div className="col" style={{ gap: 2 }}>
                <span className="body-s muted">Orden #{o.number}</span>
                <span className="title-m">{TRACKING_STAGES[Math.max(0, stage)]?.label ?? ""}</span>
              </div>
              {o.promised_at && (
                <div className="col" style={{ gap: 2, alignItems: "flex-end" }}>
                  <span className="body-s muted">{o.status === "delivered" ? "Entregada" : "Entrega"}</span>
                  <span className="title-s">{dateTime(o.delivered_at ?? o.promised_at)}</span>
                </div>
              )}
            </div>
            <div className="ticket-cut" aria-hidden />
            <div className="ticket-bottom">
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
            </div>
          </section>
        )}

        {payError && <Banner tone="error">{payError}</Banner>}
        {o.balance_cents > 0 && o.status !== "cancelled" && !o.online_payment && (
          <Card>
            <div className="row between wrap gap-12">
              <div>
                <div className="body-m muted">Saldo por pagar</div>
                <div className="headline-s num">{money(o.balance_cents)}</div>
              </div>
              {o.online_payment && (
                <Button icon="credit_card" onClick={pay} loading={paying}>
                  Pagar ahora
                </Button>
              )}
            </div>
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

        {o.items.length === 0 ? (
          <Banner icon="inventory_2">Registraremos tus prendas y el total cuando recibamos tu ropa.</Banner>
        ) : (
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
        )}

        {o.loyalty && (o.loyalty.balance > 0 || o.loyalty.points_earned > 0 || o.loyalty.points_redeemed > 0) && (
          <Card>
            <div className="row gap-12">
              <Icon name="loyalty" size="lg" />
              <div className="col gap-4">
                {o.loyalty.points_earned > 0 && (
                  <div className="title-s">Ganaste {o.loyalty.points_earned} puntos con esta orden</div>
                )}
                {o.loyalty.points_redeemed > 0 && <div className="body-m">Usaste {o.loyalty.points_redeemed} puntos.</div>}
                {o.loyalty.points_earned === 0 && !["delivered", "cancelled"].includes(o.status) && (
                  <div className="body-m">Ganarás puntos cuando recibas y pagues tu orden.</div>
                )}
                <div className="body-m muted">
                  Tienes {o.loyalty.balance} puntos
                  {o.loyalty.point_value_cents > 0 && o.loyalty.balance > 0 && ` (${money(o.loyalty.balance * o.loyalty.point_value_cents)} para tu próxima orden)`}.
                </div>
              </div>
            </div>
          </Card>
        )}

        {o.notes && <Banner icon="sticky_note_2">{o.notes}</Banner>}

        <div className="body-s muted" style={{ textAlign: "center" }}>
          {[o.business.phone, o.business.email, o.business.address].filter(Boolean).join(" · ")}
        </div>
      </main>
    </div>
  );
}
