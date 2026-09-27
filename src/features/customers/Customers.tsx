import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Page } from "../../app/Shell";
import { CUSTOMER_STATUS_LABEL, type CustomerStatus } from "../../domain/customers";
import { normalizePhone } from "../../domain/phone";
import { whatsappLink } from "../../domain/notifications";
import { dateOnly, dateTime, money, relative } from "../../lib/format";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Address, CustomerOverview, LoyaltyTransaction, Order } from "../../lib/types";
import { rpc, useAction, useMemberNames } from "../../lib/queries";
import { Button, Card, Chip, Dialog, Empty, Icon, IconButton, Loading, Stat, TextField, initials } from "../../ui/components";
import { CustomerStatusBadge, OrderStatusBadge, PaymentBadge } from "../shared";
import { AddressDialog, CustomerDialog, formatAddress, mapsUrl } from "./CustomerDialogs";

export function CustomersList() {
  const { tenantId, tenant, can } = useTenant();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CustomerStatus | "all" | "balance">("all");
  const [creating, setCreating] = useState(false);

  const q = useQuery({
    queryKey: ["customers", tenantId, search, status],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let query = supabase.from("customer_overview").select("*").eq("tenant_id", tenantId).is("archived_at", null).order("last_order_at", { ascending: false, nullsFirst: false }).limit(200);
      const term = search.trim();
      if (term) {
        const phone = normalizePhone(term, tenant?.country);
        if (phone) query = query.eq("phone_normalized", phone);
        else {
          const safe = term.replace(/[%,()]/g, "");
          query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%,phone_normalized.ilike.%${safe.replace(/\D/g, "") || "_"}%`);
        }
      }
      if (status === "balance") query = query.gt("balance_due_cents", 0);
      else if (status !== "all") query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      return data as CustomerOverview[];
    },
  });

  return (
    <Page title="Clientes">
      <div className="col gap-16">
        <div className="search">
          <Icon name="search" />
          <input placeholder="Buscar por nombre, teléfono o correo" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="chips">
          <Chip on={status === "all"} onClick={() => setStatus("all")}>
            Todos
          </Chip>
          {(Object.keys(CUSTOMER_STATUS_LABEL) as CustomerStatus[]).map((s) => (
            <Chip key={s} on={status === s} onClick={() => setStatus(s)}>
              {CUSTOMER_STATUS_LABEL[s]}
            </Chip>
          ))}
          <Chip on={status === "balance"} onClick={() => setStatus("balance")}>
            Con saldo
          </Chip>
        </div>
        <div className="card flush">
          {q.isLoading ? (
            <Loading />
          ) : !q.data?.length ? (
            <Empty icon="group" title="Sin clientes" />
          ) : (
            <div className="list">
              {q.data.map((c) => (
                <div key={c.id} className="list-item clickable" onClick={() => navigate(`/customers/${c.id}`)}>
                  <span className="lead">{initials(c.name)}</span>
                  <div className="grow">
                    <div className="headline">{c.name}</div>
                    <div className="supporting truncate">
                      {[c.phone, c.email].filter(Boolean).join(" · ") || "Sin contacto"}
                      {c.last_order_at && ` · última orden ${relative(c.last_order_at)}`}
                    </div>
                  </div>
                  <div className="trailing col gap-4" style={{ alignItems: "flex-end" }}>
                    <CustomerStatusBadge status={c.status} />
                    <span className="body-s muted num">
                      {c.total_orders} órdenes · {money(c.lifetime_spend_cents)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {can("customers.edit") && (
        <button className="fab" onClick={() => setCreating(true)}>
          <Icon name="person_add" /> Nuevo cliente
        </button>
      )}
      <CustomerDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(c) => {
          setCreating(false);
          navigate(`/customers/${c.id}`);
        }}
      />
    </Page>
  );
}

export function CustomerDetail() {
  const { id = "" } = useParams();
  const { can, settings } = useTenant();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState<Address | "new" | null>(null);

  const q = useQuery({
    queryKey: ["customer", id],
    queryFn: async () => {
      const [c, addresses, orders] = await Promise.all([
        supabase.from("customer_overview").select("*").eq("id", id).single(),
        supabase.from("customer_addresses").select("*").eq("customer_id", id).order("is_default", { ascending: false }),
        supabase.from("orders").select("*").eq("customer_id", id).order("created_at", { ascending: false }).limit(100),
      ]);
      if (c.error) throw c.error;
      return { customer: c.data as CustomerOverview, addresses: (addresses.data ?? []) as Address[], orders: (orders.data ?? []) as Order[] };
    },
  });

  if (q.isLoading) return <Page title="Cliente" back="/customers"><Loading /></Page>;
  if (!q.data) return <Page title="Cliente" back="/customers"><Empty icon="person_off" title="Cliente no encontrado" /></Page>;
  const { customer: c, addresses, orders } = q.data;

  return (
    <Page
      title={c.name}
      back="/customers"
      actions={can("customers.edit") && <IconButton icon="edit" label="Editar" onClick={() => setEditing(true)} />}
    >
      <div className="col gap-16">
        <Card>
          <div className="row wrap gap-16">
            <span className="lead" style={{ width: 56, height: 56, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--primary-container)", color: "var(--on-primary-container)", fontSize: 20 }}>
              {initials(c.name)}
            </span>
            <div className="grow col gap-4">
              <div className="row wrap">
                <span className="title-l">{c.name}</span>
                <CustomerStatusBadge status={c.status} />
              </div>
              <div className="body-m muted">
                {[c.phone, c.email].filter(Boolean).join(" · ") || "Sin contacto"} · Cliente desde {dateOnly(c.created_at)}
              </div>
              {c.notes && <div className="body-m">{c.notes}</div>}
            </div>
            <div className="row wrap">
              {c.phone_normalized && (
                <a className="btn outlined" href={whatsappLink(c.phone_normalized, `Hola ${c.name.split(" ")[0]}`)} target="_blank" rel="noreferrer">
                  <Icon name="chat" /> WhatsApp
                </a>
              )}
              {can("orders.create") && (
                <Button icon="add" onClick={() => navigate(`/orders/new?customer=${c.id}`)}>
                  Nueva orden
                </Button>
              )}
            </div>
          </div>
        </Card>

        <div className="grid cols-4">
          <Stat label="Órdenes" value={c.total_orders} icon="receipt_long" />
          <Stat label="Gasto total" value={money(c.lifetime_spend_cents)} icon="payments" />
          <Stat label="Ticket promedio" value={money(c.avg_order_cents)} icon="analytics" />
          <Stat
            label="Saldo pendiente"
            value={money(c.balance_due_cents)}
            icon="account_balance_wallet"
            tone={c.balance_due_cents > 0 ? "alert" : undefined}
            hint={c.last_order_at ? `Última orden ${relative(c.last_order_at)}` : undefined}
          />
        </div>

        <div className="grid cols-2" style={{ alignItems: "start" }}>
          <Card title="Órdenes" variant="flush">
            {orders.length === 0 ? (
              <Empty icon="receipt_long" title="Sin órdenes" />
            ) : (
              <div className="list">
                {orders.map((o) => (
                  <Link key={o.id} to={`/orders/${o.id}`} className="list-item clickable">
                    <div className="grow">
                      <div className="headline">
                        #{o.number} · {money(o.total_cents)}
                      </div>
                      <div className="supporting">{dateTime(o.created_at)}</div>
                    </div>
                    <div className="col gap-4" style={{ alignItems: "flex-end" }}>
                      <OrderStatusBadge status={o.status} />
                      {o.status !== "cancelled" && <PaymentBadge status={o.payment_status} />}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
          <Card
            title="Direcciones"
            action={
              can("customers.edit") && (
                <Button variant="text" icon="add_location_alt" onClick={() => setAddress("new")}>
                  Agregar
                </Button>
              )
            }
            variant="flush"
          >
            {addresses.length === 0 ? (
              <Empty icon="location_off" title="Sin direcciones" />
            ) : (
              <div className="list">
                {addresses.map((a) => (
                  <div key={a.id} className="list-item">
                    <Icon name={a.is_default ? "home" : "location_on"} />
                    <div className="grow">
                      <div className="headline">{a.label || formatAddress(a)}</div>
                      {a.label && <div className="supporting">{formatAddress(a)}</div>}
                      {a.instructions && <div className="supporting">{a.instructions}</div>}
                    </div>
                    <a className="icon-btn" href={mapsUrl(a)} target="_blank" rel="noreferrer" title="Abrir en Maps">
                      <Icon name="map" />
                    </a>
                    {can("customers.edit") && <IconButton icon="edit" label="Editar" onClick={() => setAddress(a)} />}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
        {(settings.loyalty.enabled || c.points_balance !== 0) && <LoyaltyCard customerId={c.id} balance={c.points_balance} onChanged={() => q.refetch()} />}
      </div>
      <CustomerDialog open={editing} customer={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); q.refetch(); }} />
      <AddressDialog
        open={!!address}
        customerId={c.id}
        address={address === "new" ? null : address}
        onClose={() => setAddress(null)}
        onSaved={() => {
          setAddress(null);
          q.refetch();
        }}
      />
    </Page>
  );
}

const LOYALTY_KIND: Record<string, string> = { earn: "Ganados", redeem: "Usados", adjust: "Ajuste" };

function LoyaltyCard({ customerId, balance, onChanged }: { customerId: string; balance: number; onChanged: () => void }) {
  const { can, settings } = useTenant();
  const name = useMemberNames();
  const [adjusting, setAdjusting] = useState(false);
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const ledger = useQuery({
    queryKey: ["loyalty", customerId, "ledger"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loyalty_transactions")
        .select("*, orders(number)")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as (LoyaltyTransaction & { orders: { number: number } | null })[];
    },
  });
  const adjust = useAction(() => rpc("adjust_loyalty_points", { p_customer: customerId, p_points: Math.trunc(Number(points)), p_note: note }), {
    success: "Puntos ajustados",
    invalidate: [["loyalty"], ["customer"], ["customers"]],
    dispatch: false,
  });
  return (
    <Card
      title={
        <div className="col gap-4">
          <h3>Puntos de lealtad</h3>
          <span className="body-s muted">
            Saldo {balance} puntos
            {settings.loyalty.point_value_cents > 0 && ` · vale ${money(balance * settings.loyalty.point_value_cents)}`}
          </span>
        </div>
      }
      action={
        can("loyalty.manage") && (
          <Button variant="text" icon="tune" onClick={() => setAdjusting(true)}>
            Ajustar
          </Button>
        )
      }
      variant="flush"
    >
      {!ledger.data?.length ? (
        <Empty icon="loyalty" title="Sin movimientos" />
      ) : (
        <div className="list">
          {ledger.data.map((t) => (
            <div key={t.id} className="list-item">
              <div className="grow">
                <div className="headline">
                  {LOYALTY_KIND[t.kind]}
                  {t.orders ? ` · orden #${t.orders.number}` : ""}
                </div>
                <div className="supporting">
                  {dateTime(t.created_at)}
                  {t.note ? ` · ${t.note}` : ""}
                  {t.created_by ? ` · ${name(t.created_by)}` : ""}
                </div>
              </div>
              <span className="title-s num" style={{ color: t.points > 0 ? "var(--tertiary)" : "var(--error)" }}>
                {t.points > 0 ? `+${t.points}` : t.points}
              </span>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={adjusting}
        title="Ajustar puntos"
        onClose={() => setAdjusting(false)}
        actions={
          <>
            <Button variant="text" onClick={() => setAdjusting(false)}>
              Cancelar
            </Button>
            <Button
              loading={adjust.isPending}
              disabled={!Number(points) || !note.trim()}
              onClick={() =>
                adjust.mutate(undefined, {
                  onSuccess: () => {
                    setAdjusting(false);
                    setPoints("");
                    setNote("");
                    onChanged();
                  },
                })
              }
            >
              Guardar
            </Button>
          </>
        }
      >
        <div className="col gap-16">
          <TextField label="Puntos" type="number" value={points} onChange={(e) => setPoints(e.target.value)} hint="Positivo para regalar, negativo para quitar" />
          <TextField label="Motivo" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Cortesía, corrección, saldo del sistema anterior…" />
        </div>
      </Dialog>
    </Card>
  );
}
