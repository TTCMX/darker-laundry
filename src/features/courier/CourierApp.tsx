import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AccountMenu } from "../../app/Shell";
import type { OrderStatus } from "../../domain/orders";
import { whatsappLink } from "../../domain/notifications";
import { dateOnly, money, todayISO } from "../../lib/format";
import { rpc, uploadEvidence, useAction } from "../../lib/queries";
import { useAuth, useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Delivery, Route } from "../../lib/types";
import { Badge, Banner, Button, Dialog, Empty, Icon, Loading, TextArea, useToast } from "../../ui/components";
import { formatAddress, mapsUrl } from "../customers/CustomerDialogs";
import { IssueDialog, PaymentDialog } from "../orders/OrderDialogs";
import { AddPhotoButton, PhotoPicker } from "../orders/OrderPhotos";
import { DELIVERY_TYPE_LABEL, DeliveryStatusBadge } from "../shared";

type CourierStop = Delivery & {
  orders: {
    id: string;
    tenant_id: string;
    number: number;
    status: OrderStatus;
    balance_cents: number;
    total_cents: number;
    notes: string | null;
    customers: { name: string; phone: string | null; phone_normalized: string | null };
  };
};

const CLOSED = ["completed", "failed", "cancelled"];

export function CourierApp() {
  const { user } = useAuth();
  const { tenantId, tenant, can } = useTenant();
  const navigate = useNavigate();
  const toast = useToast();
  const [paying, setPaying] = useState<CourierStop | null>(null);
  const [finishing, setFinishing] = useState<{ stop: CourierStop; outcome: "completed" | "failed" } | null>(null);
  const [reporting, setReporting] = useState<CourierStop | null>(null);
  const today = todayISO();

  const q = useQuery({
    queryKey: ["courier", tenantId, user?.id, today],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [stops, routes] = await Promise.all([
        supabase
          .from("deliveries")
          .select("*, orders!inner(id, tenant_id, number, status, balance_cents, total_cents, notes, customers(name, phone, phone_normalized))")
          .eq("tenant_id", tenantId)
          .eq("courier_id", user!.id)
          // Today's stops plus anything left open from previous days.
          .or(`scheduled_date.eq.${today},and(scheduled_date.lt.${today},status.not.in.(completed,failed,cancelled))`)
          .neq("status", "cancelled")
          .order("scheduled_date")
          .order("stop_position", { nullsFirst: false })
          .order("window_start"),
        supabase.from("routes").select("*").eq("tenant_id", tenantId).eq("courier_id", user!.id).eq("route_date", today),
      ]);
      if (stops.error) throw stops.error;
      return { stops: (stops.data ?? []) as CourierStop[], routes: (routes.data ?? []) as Route[] };
    },
  });

  const status = useAction(
    (a: { id: string; status: string; note?: string | null; reason?: string | null; proofs?: string[] }) =>
      rpc("update_delivery_status", {
        p_delivery: a.id,
        p_status: a.status,
        p_note: a.note ?? null,
        p_failure_reason: a.reason ?? null,
        p_proof_paths: a.proofs ?? [],
      }),
    { invalidate: [["courier"], ["deliveries"], ["order"], ["orders"], ["dashboard"]] },
  );
  const startRoute = useAction((id: string) => rpc("start_route", { p_route: id }), { invalidate: [["courier"], ["deliveries"]], dispatch: false });

  if (!can("delivery.execute")) {
    return (
      <div className="center-page">
        <Empty icon="block" title="Tu rol no tiene rutas">
          <Button onClick={() => navigate("/")}>Ir al inicio</Button>
        </Empty>
      </div>
    );
  }

  const stops = q.data?.stops ?? [];
  const pending = stops.filter((s) => !CLOSED.includes(s.status));
  const done = stops.filter((s) => CLOSED.includes(s.status));
  const plannedRoute = q.data?.routes.find((r) => r.status === "planned");
  const toCollect = pending.filter((s) => s.type === "delivery").reduce((sum, s) => sum + s.orders.balance_cents, 0);

  return (
    <div style={{ minHeight: "100dvh", background: "var(--surface)" }}>
      <header className="topbar">
        <div className="grow">
          <div className="title-m">Ruta de hoy</div>
          <div className="body-s muted">
            {tenant?.tenant_name} · {dateOnly(today)}
          </div>
        </div>
        <AccountMenu />
      </header>
      <main className="courier col gap-12">
        <div className="grid cols-2" style={{ gap: 8 }}>
          <div className="stat accent">
            <span className="label">Pendientes</span>
            <span className="value">{pending.length}</span>
          </div>
          <div className="stat">
            <span className="label">Por cobrar</span>
            <span className="value" style={{ fontSize: 24 }}>
              {money(toCollect)}
            </span>
          </div>
        </div>
        {plannedRoute && (
          <Button size="lg" icon="play_arrow" block onClick={() => startRoute.mutate(plannedRoute.id)} loading={startRoute.isPending}>
            Iniciar ruta
          </Button>
        )}
        {q.isLoading && <Loading />}
        {!q.isLoading && stops.length === 0 && <Empty icon="two_wheeler" title="No tienes paradas hoy" />}

        {pending.map((s, i) => {
          const c = s.orders.customers;
          const isDelivery = s.type === "delivery";
          const notReady = isDelivery && !["ready", "out_for_delivery"].includes(s.orders.status);
          return (
            <article key={s.id} className={`stop ${s.type}`}>
              <div className="row top gap-12">
                <span className="num-badge">{s.stop_position ?? i + 1}</span>
                <div className="grow">
                  <div className="row between">
                    <span className="label-m" style={{ textTransform: "uppercase", color: isDelivery ? "var(--primary)" : "var(--secondary)" }}>
                      {DELIVERY_TYPE_LABEL[s.type]} · #{s.orders.number}
                    </span>
                    <DeliveryStatusBadge status={s.status} />
                  </div>
                  <div className="title-l">{c.name}</div>
                  <div className="body-m muted">
                    {s.scheduled_date !== today && <Badge tone="warning">{dateOnly(s.scheduled_date)}</Badge>} {s.window_label ?? "Sin horario"}
                  </div>
                </div>
              </div>
              <a className="body-l" href={mapsUrl(s.address)} target="_blank" rel="noreferrer" style={{ color: "var(--on-surface)" }}>
                <Icon name="location_on" size="sm" /> {formatAddress(s.address)}
              </a>
              {s.address.instructions && <div className="body-m muted">{s.address.instructions}</div>}
              {s.notes && <Banner icon="sticky_note_2">{s.notes}</Banner>}
              {notReady && <Banner tone="warning">La orden aún no está lista para entregarse.</Banner>}
              {isDelivery && s.orders.balance_cents > 0 && (
                <Banner tone="warning" icon="payments">
                  Cobrar <strong>{money(s.orders.balance_cents)}</strong>
                </Banner>
              )}
              <div className="row wrap">
                <a className="btn tonal" href={mapsUrl(s.address)} target="_blank" rel="noreferrer">
                  <Icon name="navigation" /> Navegar
                </a>
                {c.phone && (
                  <a className="btn outlined" href={`tel:${c.phone_normalized ?? c.phone}`}>
                    <Icon name="call" /> Llamar
                  </a>
                )}
                {c.phone_normalized && (
                  <a className="btn outlined" href={whatsappLink(c.phone_normalized, `Hola ${c.name.split(" ")[0]}, soy tu courier de ${tenant?.tenant_name}.`)} target="_blank" rel="noreferrer">
                    <Icon name="chat" /> WhatsApp
                  </a>
                )}
              </div>
              <div className="row wrap">
                {["scheduled", "assigned"].includes(s.status) && (
                  <Button variant="tonal" icon="directions_car" disabled={notReady} onClick={() => status.mutate({ id: s.id, status: "en_route" })}>
                    En camino
                  </Button>
                )}
                {s.status === "en_route" && (
                  <Button variant="tonal" icon="pin_drop" onClick={() => status.mutate({ id: s.id, status: "arrived" })}>
                    Llegué
                  </Button>
                )}
                {isDelivery && s.orders.balance_cents > 0 && !notReady && (
                  <Button variant="outlined" icon="payments" onClick={() => setPaying(s)}>
                    Cobrar
                  </Button>
                )}
              </div>
              <div className="row">
                <Button size="lg" variant="success" className="grow" icon="check" disabled={notReady} onClick={() => setFinishing({ stop: s, outcome: "completed" })}>
                  {isDelivery ? "Entregado" : "Recolectado"}
                </Button>
                <Button size="lg" variant="outlined" icon="close" onClick={() => setFinishing({ stop: s, outcome: "failed" })}>
                  No se pudo
                </Button>
              </div>
              <div className="row wrap">
                <AddPhotoButton orderId={s.orders.id} deliveryId={s.id} />
                <Button variant="text" icon="report" onClick={() => setReporting(s)}>
                  Reportar problema
                </Button>
              </div>
            </article>
          );
        })}

        {done.length > 0 && (
          <>
            <div className="title-s muted mt-16">Completadas</div>
            {done.map((s) => (
              <article key={s.id} className={`stop done ${s.type}`}>
                <div className="row between">
                  <span>
                    {DELIVERY_TYPE_LABEL[s.type]} · #{s.orders.number} · {s.orders.customers.name}
                  </span>
                  <DeliveryStatusBadge status={s.status} />
                </div>
              </article>
            ))}
          </>
        )}
      </main>

      {paying && <PaymentDialog open order={{ id: paying.orders.id, number: paying.orders.number, balance_cents: paying.orders.balance_cents }} deliveryId={paying.id} onClose={() => setPaying(null)} />}
      {finishing && (
        <FinishDialog
          stop={finishing.stop}
          outcome={finishing.outcome}
          tenantId={tenantId}
          loading={status.isPending}
          onClose={() => setFinishing(null)}
          onConfirm={async (note, files) => {
            try {
              const proofs = await Promise.all(files.map((f) => uploadEvidence(tenantId, f, `deliveries/${finishing.stop.id}`)));
              status.mutate(
                {
                  id: finishing.stop.id,
                  status: finishing.outcome,
                  note: finishing.outcome === "completed" ? note : null,
                  reason: finishing.outcome === "failed" ? note : null,
                  proofs,
                },
                { onSuccess: () => setFinishing(null) },
              );
            } catch {
              toast.show("No se pudo subir la foto. Intenta de nuevo.", { error: true });
            }
          }}
        />
      )}
      {reporting && (
        <IssueDialog open order={{ id: reporting.orders.id, tenant_id: reporting.orders.tenant_id, number: reporting.orders.number }} steps={[]} onClose={() => setReporting(null)} />
      )}
    </div>
  );
}

function FinishDialog({
  stop,
  outcome,
  loading,
  onClose,
  onConfirm,
}: {
  stop: CourierStop;
  outcome: "completed" | "failed";
  tenantId: string;
  loading: boolean;
  onClose: () => void;
  onConfirm: (note: string, files: File[]) => void;
}) {
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const failed = outcome === "failed";
  return (
    <Dialog
      open
      title={failed ? "¿Qué pasó?" : stop.type === "delivery" ? "Confirmar entrega" : "Confirmar recolección"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={failed ? "danger" : "success"} loading={loading} disabled={failed && !note.trim()} onClick={() => onConfirm(note.trim(), files)}>
            {failed ? "Marcar como fallida" : "Confirmar"}
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        {!failed && stop.type === "delivery" && stop.orders.balance_cents > 0 && (
          <Banner tone="warning">Queda un saldo de {money(stop.orders.balance_cents)} sin cobrar.</Banner>
        )}
        <TextArea
          label={failed ? "Motivo" : "Nota (opcional)"}
          placeholder={failed ? "No había nadie, dirección incorrecta…" : stop.type === "pickup" ? "Número de bolsas, observaciones…" : "Recibió…"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
        />
        <PhotoPicker files={files} onChange={setFiles} label="Foto de evidencia" />
      </div>
    </Dialog>
  );
}
