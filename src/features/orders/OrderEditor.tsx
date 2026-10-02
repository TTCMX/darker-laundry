import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Page } from "../../app/Shell";
import { deliveryRule } from "../../domain/delivery";
import { pointsEarned } from "../../domain/loyalty";
import { PRIORITY_LABEL, type OrderPriority } from "../../domain/orders";
import { normalizePhone } from "../../domain/phone";
import { PricingError, quote, type PricingResult } from "../../domain/pricing";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { centsToInput, inputToCents, isoToLocalInput, localInputToISO, money, todayISO, unitLabel } from "../../lib/format";
import { rpc, useCatalog } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Address, Customer, Order, OrderItem, Product } from "../../lib/types";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  Empty,
  Icon,
  IconButton,
  Loading,
  Segmented,
  Select,
  TextArea,
  TextField,
  initials,
  useToast,
} from "../../ui/components";
import { AddressDialog, CustomerDialog, formatAddress } from "../customers/CustomerDialogs";
import { KvRow } from "../shared";

interface Line {
  key: string;
  product_id: string | null;
  name: string;
  quantity: string;
  unit_price: string; // for variable-price / ad-hoc lines, in currency units
  notes: string;
}

const newKey = () => Math.random().toString(36).slice(2);

function CustomerPicker({ value, onChange }: { value: Customer | null; onChange: (c: Customer | null) => void }) {
  const { tenantId, tenant, can } = useTenant();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const results = useQuery({
    queryKey: ["customer-search", tenantId, q],
    enabled: q.trim().length >= 2,
    queryFn: async () => {
      const term = q.trim();
      const phone = normalizePhone(term, tenant?.country);
      let query = supabase.from("customers").select("*").eq("tenant_id", tenantId).is("archived_at", null).limit(8);
      if (phone) query = query.eq("phone_normalized", phone);
      else if (/^\d{4,}$/.test(term.replace(/\D/g, "")) && /^[\d\s+()-]+$/.test(term)) query = query.ilike("phone_normalized", `%${term.replace(/\D/g, "")}%`);
      else query = query.or(`name.ilike.%${term.replace(/[%,()]/g, "")}%,email.ilike.%${term.replace(/[%,()]/g, "")}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data as Customer[];
    },
  });

  if (value) {
    return (
      <div className="list-item" style={{ padding: 0 }}>
        <span className="lead">{initials(value.name)}</span>
        <div className="grow">
          <div className="headline">{value.name}</div>
          <div className="supporting">{[value.phone, value.email].filter(Boolean).join(" · ") || "Sin contacto"}</div>
        </div>
        <Button variant="text" onClick={() => onChange(null)}>
          Cambiar
        </Button>
      </div>
    );
  }
  return (
    <div className="col gap-8">
      <div className="search">
        <Icon name="search" />
        <input placeholder="Buscar por nombre, teléfono o correo" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {can("customers.edit") && (
          <Button variant="text" icon="person_add" onClick={() => setCreating(true)}>
            Nuevo
          </Button>
        )}
      </div>
      {q.trim().length >= 2 && (
        <div className="list card flush">
          {results.isLoading && <Loading />}
          {results.data?.map((c) => (
            <button key={c.id} className="list-item clickable" style={{ border: "none", background: "none", textAlign: "left", width: "100%" }} onClick={() => onChange(c)}>
              <span className="lead">{initials(c.name)}</span>
              <div className="grow">
                <div className="headline">{c.name}</div>
                <div className="supporting">{[c.phone, c.email].filter(Boolean).join(" · ")}</div>
              </div>
            </button>
          ))}
          {results.data?.length === 0 && (
            <div className="list-item">
              <span className="muted grow">Sin resultados</span>
              {can("customers.edit") && (
                <Button variant="tonal" icon="person_add" onClick={() => setCreating(true)}>
                  Crear “{q.trim()}”
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <CustomerDialog
        open={creating}
        initialQuery={q}
        onClose={() => setCreating(false)}
        onSaved={(c) => {
          setCreating(false);
          onChange(c);
        }}
      />
    </div>
  );
}

export function OrderEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { tenantId, settings, can, ops } = useTenant();
  const catalog = useCatalog();

  const existing = useQuery({
    queryKey: ["order-edit", id],
    enabled: !!id,
    // Always load the current order: a cached copy from an earlier visit
    // would prefill the form with stale items and overwrite them on save.
    gcTime: 0,
    staleTime: 0,
    queryFn: async () => {
      const [o, items, discounts] = await Promise.all([
        supabase.from("orders").select("*, customers(*)").eq("id", id!).single(),
        supabase.from("order_items").select("*").eq("order_id", id!).order("position"),
        supabase.from("order_discounts").select("discount_id").eq("order_id", id!),
      ]);
      if (o.error) throw o.error;
      return {
        order: o.data as Order & { customers: Customer },
        items: (items.data ?? []) as OrderItem[],
        discount_ids: (discounts.data ?? []).map((d) => d.discount_id as string),
      };
    },
  });

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [fulfillment, setFulfillment] = useState<"delivery" | "walk_in">(ops.defaultFulfillment);
  const [pickupAddress, setPickupAddress] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [discountIds, setDiscountIds] = useState<string[]>([]);
  const [discountCode, setDiscountCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pointsInput, setPointsInput] = useState("");
  const [freeDelivery, setFreeDelivery] = useState(false);
  const [priority, setPriority] = useState<OrderPriority>("normal");
  const [promised, setPromised] = useState(() => isoToLocalInput(new Date(Date.now() + settings.operations.default_turnaround_hours * 3_600_000).toISOString()));
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // New delivery orders can book the pickup in the same step.
  const [bookPickup, setBookPickup] = useState(true);
  const [pickupDate, setPickupDate] = useState(() => todayISO());
  const [pickupWindow, setPickupWindow] = useState(() => settings.delivery.windows[0]?.id ?? "");

  // Prefill from an existing order, or from ?customer= for new ones.
  useEffect(() => {
    if (loaded) return;
    if (id && existing.data && !existing.isFetching) {
      const { order, items, discount_ids } = existing.data;
      setCustomer(order.customers);
      setFulfillment(order.fulfillment);
      setPickupAddress(order.pickup_address_id ?? "");
      setDeliveryAddress(order.delivery_address_id ?? "");
      setZoneId(order.delivery_zone_id ?? "");
      setLines(
        items.map((i) => ({
          key: newKey(),
          product_id: i.product_id,
          name: i.name,
          quantity: String(Number(i.quantity)),
          unit_price: i.custom_price ? centsToInput(i.unit_price_cents) : "",
          notes: i.notes ?? "",
        })),
      );
      setDiscountIds(discount_ids);
      setPointsInput(order.points_redeemed ? String(order.points_redeemed) : "");
      setPriority(order.priority);
      setPromised(isoToLocalInput(order.promised_at));
      setNotes(order.notes ?? "");
      setInternalNotes(order.internal_notes ?? "");
      setFreeDelivery(!!order.pricing && order.delivery_fee_cents === 0 && (order as unknown as { delivery_fee_override: boolean }).delivery_fee_override);
      setLoaded(true);
    } else if (!id) {
      const cid = params.get("customer");
      if (cid) {
        supabase
          .from("customers")
          .select("*")
          .eq("id", cid)
          .single()
          .then(({ data }) => data && setCustomer(data as Customer));
      }
      setLoaded(true);
    }
  }, [id, existing.data, existing.isFetching, loaded, params]);

  // New orders start with the discounts marked "apply automatically".
  const [autoApplied, setAutoApplied] = useState(false);
  useEffect(() => {
    if (id || autoApplied || !catalog.data) return;
    setAutoApplied(true);
    const auto = catalog.data.discounts.filter((d) => d.active && d.auto_apply).map((d) => d.id);
    if (auto.length) setDiscountIds((ids) => [...new Set([...ids, ...auto])]);
  }, [id, autoApplied, catalog.data]);

  // Loyalty balance of the customer (this order's own redemption given back when editing).
  const loyalty = settings.loyalty;
  const ledger = useQuery({
    queryKey: ["loyalty", customer?.id],
    enabled: !!customer && loyalty.enabled,
    // Balances change when other orders are paid: always read the current one.
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("loyalty_transactions").select("points, order_id, kind").eq("customer_id", customer!.id);
      if (error) throw error;
      return data as { points: number; order_id: string | null; kind: string }[];
    },
  });
  const pointsAvailable = (ledger.data ?? [])
    .filter((t) => !(id && t.order_id === id && t.kind === "redeem"))
    .reduce((sum, t) => sum + t.points, 0);
  const pointsToRedeem = Math.max(0, Math.min(Math.floor(Number(pointsInput) || 0), pointsAvailable));

  const addresses = useQuery({
    queryKey: ["addresses", customer?.id],
    enabled: !!customer,
    queryFn: async () => {
      const { data, error } = await supabase.from("customer_addresses").select("*").eq("customer_id", customer!.id).order("is_default", { ascending: false });
      if (error) throw error;
      return data as Address[];
    },
  });

  // Default addresses when a customer is picked.
  useEffect(() => {
    const def = addresses.data?.[0];
    if (!def) return;
    setPickupAddress((v) => v || def.id);
    setDeliveryAddress((v) => v || def.id);
  }, [addresses.data]);

  // Zone follows the delivery address unless chosen by hand.
  const deliveryAddr = addresses.data?.find((a) => a.id === deliveryAddress) ?? null;
  const effectiveZoneId = zoneId || deliveryAddr?.zone_id || "";
  const zone = catalog.data?.zones.find((z) => z.id === effectiveZoneId) ?? null;

  const products = useMemo(() => (catalog.data?.products ?? []).filter((p) => p.active), [catalog.data]);
  const productById = useMemo(() => new Map((catalog.data?.products ?? []).map((p) => [p.id, p])), [catalog.data]);
  const visibleProducts = products.filter(
    (p) =>
      (!categoryFilter || p.category_id === categoryFilter) &&
      (!productFilter || `${p.name} ${p.sku ?? ""}`.toLowerCase().includes(productFilter.toLowerCase())),
  );

  const addProduct = (p: Product) => {
    setLines((ls) => {
      const existingLine = ls.find((l) => l.product_id === p.id && !p.variable_price);
      if (existingLine) {
        return ls.map((l) => (l === existingLine ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l));
      }
      return [...ls, { key: newKey(), product_id: p.id, name: p.name, quantity: "1", unit_price: "", notes: "" }];
    });
  };

  const updateLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const itemsInput = lines.map((l) => ({
    product_id: l.product_id,
    quantity: Number(l.quantity),
    unit_price_cents: l.product_id && !productById.get(l.product_id)?.variable_price ? null : inputToCents(l.unit_price),
    name: l.name,
    notes: l.notes || null,
  }));

  const { rule, min_order_cents } = deliveryRule(fulfillment, zone, settings);

  let preview: PricingResult | null = null;
  let previewError: string | null = null;
  if (catalog.pricingContext && lines.length) {
    try {
      preview = quote(
        {
          items: itemsInput,
          discount_ids: discountIds,
          delivery: rule,
          delivery_fee_override_cents: freeDelivery ? 0 : null,
          points_to_redeem: loyalty.enabled ? pointsToRedeem : 0,
          now: new Date(),
        },
        catalog.pricingContext,
      );
    } catch (err) {
      previewError = err instanceof PricingError ? `Revisa la línea ${(err.index ?? 0) + 1}: ${err.code === "missing_price" ? "falta el precio" : err.code === "invalid_quantity" ? "cantidad inválida" : "producto no disponible"}` : String(err);
    }
  }
  const belowMinimum = preview && min_order_cents !== null && preview.subtotal_cents - preview.discount_cents < min_order_cents;

  const activeDiscounts = (catalog.data?.discounts ?? []).filter((d) => d.active);
  // Discounts with a code are only applied by typing it; the rest are chips.
  const chipDiscounts = activeDiscounts.filter((d) => !d.code || discountIds.includes(d.id));
  const applyCode = () => {
    const code = discountCode.trim().toUpperCase();
    const d = activeDiscounts.find((x) => x.code && x.code.toUpperCase() === code);
    if (!d) return setCodeError("Código no válido o inactivo.");
    setDiscountIds((ids) => (ids.includes(d.id) ? ids : [...ids, d.id]));
    setDiscountCode("");
    setCodeError(null);
  };
  const hasCodes = activeDiscounts.some((d) => d.code);

  const save = async () => {
    if (!customer) return setServerError("Selecciona un cliente.");
    if (!lines.length && fulfillment === "walk_in") return setServerError("Agrega al menos un servicio.");
    if (previewError) return setServerError(previewError);
    const schedulePickup = !id && fulfillment === "delivery" && bookPickup;
    if (schedulePickup && !pickupAddress) return setServerError("Agrega la dirección de recolección.");
    setSaving(true);
    setServerError(null);
    try {
      const r = await api<{ order: { id: string; number: number }; pricing: PricingResult }>("/api/orders/save", {
        tenant_id: tenantId,
        order: {
          id: id ?? null,
          customer_id: customer.id,
          fulfillment,
          priority,
          promised_at: localInputToISO(promised),
          notes: notes || null,
          internal_notes: internalNotes || null,
          pickup_address_id: fulfillment === "delivery" ? pickupAddress || null : null,
          delivery_address_id: fulfillment === "delivery" ? deliveryAddress || null : null,
          delivery_zone_id: fulfillment === "delivery" ? effectiveZoneId || null : null,
        },
        items: itemsInput,
        discount_ids: discountIds,
        delivery_fee_override_cents: freeDelivery ? 0 : null,
        points_to_redeem: loyalty.enabled ? pointsToRedeem : 0,
      });
      let pickupError: string | null = null;
      if (schedulePickup) {
        const w = settings.delivery.windows.find((x) => x.id === pickupWindow);
        try {
          await rpc("schedule_delivery", {
            p_order: r.order.id,
            p_type: "pickup",
            p_date: pickupDate,
            p_window_label: w ? `${w.label} ${w.start}–${w.end}` : null,
            p_window_start: w?.start ?? null,
            p_window_end: w?.end ?? null,
            p_address_id: pickupAddress,
          });
        } catch (err) {
          // The order exists; the pickup can be scheduled from its page.
          pickupError = errorMessage(err);
        }
      }
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["deliveries"] });
      qc.invalidateQueries({ queryKey: ["order", r.order.id] });
      qc.removeQueries({ queryKey: ["order-edit", r.order.id] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      const rejected = r.pricing.rejected_discounts.length;
      if (pickupError) toast.show(`Orden #${r.order.number} creada, pero no se pudo agendar la recolección: ${pickupError}`, { error: true });
      else
        toast.show(
          id
            ? "Orden actualizada"
            : `Orden #${r.order.number} creada${schedulePickup ? " y recolección agendada" : ""}${rejected ? ` (${rejected} descuento no aplicó)` : ""}`,
        );
      api("/api/notifications/dispatch", { tenant_id: tenantId }).catch(() => {});
      navigate(`/orders/${r.order.id}`, { replace: true });
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if ((id && !loaded) || catalog.isLoading) return <Page title="Orden" back="/orders"><Loading /></Page>;

  return (
    <Page title={id ? `Editar orden #${existing.data?.order.number ?? ""}` : "Nueva orden"} back={id ? `/orders/${id}` : "/orders"}>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr)", alignItems: "start" }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", alignItems: "start" }}>
          <div className="col gap-16">
            <Card title="Cliente">
              <CustomerPicker
                value={customer}
                onChange={(c) => {
                  setCustomer(c);
                  setPickupAddress("");
                  setDeliveryAddress("");
                  setZoneId("");
                }}
              />
            </Card>

            <Card title="Servicio">
              <div className="col gap-16">
                {ops.hybrid && (
                  <Segmented
                    value={fulfillment}
                    onChange={setFulfillment}
                    options={[
                      { value: "walk_in", label: "En mostrador" },
                      { value: "delivery", label: "Recolección y entrega" },
                    ]}
                  />
                )}
                {fulfillment === "delivery" && customer && (
                  <div className="col gap-12">
                    {addresses.data?.length === 0 && <Banner tone="warning">El cliente no tiene direcciones.</Banner>}
                    {!!addresses.data?.length && (
                      <div className="grid cols-2">
                        <Select
                          label="Recoger en"
                          value={pickupAddress}
                          onChange={(e) => setPickupAddress(e.target.value)}
                          options={addresses.data.map((a) => ({ value: a.id, label: a.label ? `${a.label} · ${a.line1}` : formatAddress(a) }))}
                        />
                        <Select
                          label="Entregar en"
                          value={deliveryAddress}
                          onChange={(e) => setDeliveryAddress(e.target.value)}
                          options={addresses.data.map((a) => ({ value: a.id, label: a.label ? `${a.label} · ${a.line1}` : formatAddress(a) }))}
                        />
                      </div>
                    )}
                    <div className="row wrap">
                      {can("customers.edit") && (
                        <Button variant="text" icon="add_location_alt" onClick={() => setAddingAddress(true)}>
                          Agregar dirección
                        </Button>
                      )}
                    </div>
                    <Select
                      label="Zona de entrega"
                      value={effectiveZoneId}
                      onChange={(e) => setZoneId(e.target.value)}
                      placeholder="Tarifa general"
                      options={(catalog.data?.zones ?? []).filter((z) => z.active).map((z) => ({ value: z.id, label: `${z.name} · ${money(z.fee_cents)}` }))}
                    />
                    {!id && (
                      <div className="card filled col gap-12">
                        <Checkbox label="Agendar la recolección ahora" checked={bookPickup} onChange={setBookPickup} />
                        {bookPickup && (
                          <div className="grid cols-2">
                            <TextField label="Día de recolección" type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
                            <Select
                              label="Horario"
                              value={pickupWindow}
                              onChange={(e) => setPickupWindow(e.target.value)}
                              placeholder="Sin horario"
                              options={settings.delivery.windows.map((w) => ({ value: w.id, label: `${w.label} ${w.start}–${w.end}` }))}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="grid cols-2">
                  <TextField label="Fecha prometida" type="datetime-local" value={promised} onChange={(e) => setPromised(e.target.value)} />
                  <Select
                    label="Prioridad"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as OrderPriority)}
                    options={(Object.keys(PRIORITY_LABEL) as OrderPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
                  />
                </div>
              </div>
            </Card>

            <Card title="Agregar servicios">
              <div className="col gap-12">
                <div className="search">
                  <Icon name="search" />
                  <input placeholder="Buscar servicio o SKU" value={productFilter} onChange={(e) => setProductFilter(e.target.value)} />
                </div>
                {!!catalog.data?.categories.length && (
                  <div className="chips">
                    <Chip on={!categoryFilter} onClick={() => setCategoryFilter(null)}>
                      Todos
                    </Chip>
                    {catalog.data.categories
                      .filter((c) => c.active)
                      .map((c) => (
                        <Chip key={c.id} on={categoryFilter === c.id} onClick={() => setCategoryFilter(c.id === categoryFilter ? null : c.id)}>
                          {c.name}
                        </Chip>
                      ))}
                  </div>
                )}
                {products.length === 0 ? (
                  <Empty icon="sell" title="Aún no hay servicios en el catálogo" />
                ) : (
                  <div className="grid auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
                    {visibleProducts.map((p) => (
                      <button key={p.id} className="card clickable" style={{ textAlign: "left", padding: 12 }} onClick={() => addProduct(p)}>
                        <div className="title-s">{p.name}</div>
                        <div className="body-s muted">
                          {p.variable_price ? "Precio variable" : `${money(p.base_price_cents)} / ${unitLabel(p.unit)}`}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {can("orders.price_override") && (
                  <Button
                    variant="text"
                    icon="add"
                    onClick={() => setLines((ls) => [...ls, { key: newKey(), product_id: null, name: "", quantity: "1", unit_price: "", notes: "" }])}
                  >
                    Línea con precio manual
                  </Button>
                )}
              </div>
            </Card>
          </div>

          <div className="col gap-16">
            <Card title={`Orden${lines.length ? ` · ${lines.length} ${lines.length === 1 ? "línea" : "líneas"}` : ""}`} variant="flush">
              {lines.length === 0 ? (
                <Empty icon="shopping_basket" title="Sin servicios">
                  {fulfillment === "delivery"
                    ? "Puedes crear la orden sin servicios: se capturan al recibir la ropa."
                    : "Toca un servicio del catálogo para agregarlo."}
                </Empty>
              ) : (
                <div className="list">
                  {lines.map((l, idx) => {
                    const p = l.product_id ? productById.get(l.product_id) : null;
                    const priced = preview?.lines[idx];
                    const manual = !p || p.variable_price;
                    return (
                      <div key={l.key} className="list-item" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div className="grow col gap-4" style={{ minWidth: 180 }}>
                          {p ? (
                            <div className="headline">{p.name}</div>
                          ) : (
                            <input className="input sm" placeholder="Descripción" value={l.name} onChange={(e) => updateLine(l.key, { name: e.target.value })} />
                          )}
                          <input className="input sm" placeholder="Nota (opcional)" value={l.notes} onChange={(e) => updateLine(l.key, { notes: e.target.value })} />
                          {priced?.volume_savings_cents ? (
                            <span className="body-s" style={{ color: "var(--tertiary)" }}>
                              Precio por volumen: −{money(priced.volume_savings_cents)}
                            </span>
                          ) : null}
                        </div>
                        <div className="row gap-4">
                          <input
                            className="input sm num"
                            style={{ width: 84, textAlign: "right" }}
                            type="number"
                            min="0"
                            step={p?.unit === "kg" ? "0.1" : "1"}
                            value={l.quantity}
                            onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                            aria-label="Cantidad"
                          />
                          <span className="body-s muted" style={{ width: 32 }}>
                            {unitLabel(p?.unit ?? "item")}
                          </span>
                          {manual && (
                            <input
                              className="input sm num"
                              style={{ width: 96, textAlign: "right" }}
                              inputMode="decimal"
                              placeholder="Precio"
                              value={l.unit_price}
                              onChange={(e) => updateLine(l.key, { unit_price: e.target.value })}
                              aria-label="Precio unitario"
                            />
                          )}
                        </div>
                        <div className="col" style={{ alignItems: "flex-end", minWidth: 88 }}>
                          <span className="title-s num">{priced ? money(priced.gross_cents) : "—"}</span>
                          <IconButton icon="delete" label="Quitar" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {activeDiscounts.length > 0 && (
              <Card title="Descuentos">
                {hasCodes && (
                  <div className="row" style={{ marginBottom: 12 }}>
                    <input
                      className="input sm"
                      placeholder="Código de descuento"
                      value={discountCode}
                      onChange={(e) => {
                        setDiscountCode(e.target.value);
                        setCodeError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), applyCode())}
                      aria-label="Código de descuento"
                    />
                    <Button variant="tonal" size="sm" onClick={applyCode} disabled={!discountCode.trim()}>
                      Aplicar
                    </Button>
                  </div>
                )}
                {codeError && <p className="body-s error-text" style={{ marginTop: 0 }}>{codeError}</p>}
                <div className="row wrap">
                  {chipDiscounts.map((d) => (
                    <Chip
                      key={d.id}
                      on={discountIds.includes(d.id)}
                      onClick={() => setDiscountIds((ids) => (ids.includes(d.id) ? ids.filter((x) => x !== d.id) : [...ids, d.id]))}
                    >
                      {d.code ? `${d.code} · ` : ""}
                      {d.name} · {d.kind === "percentage" ? `${d.value}%` : money(d.value)}
                    </Chip>
                  ))}
                </div>
                {preview?.rejected_discounts.length ? (
                  <p className="body-s muted" style={{ marginBottom: 0 }}>
                    No aplican: {preview.rejected_discounts.map((r) => activeDiscounts.find((d) => d.id === r.id)?.name).join(", ")}
                  </p>
                ) : null}
              </Card>
            )}

            {loyalty.enabled && customer && (
              <Card title="Puntos de lealtad">
                <div className="col gap-8">
                  <div className="body-m">
                    {customer.name.split(" ")[0]} tiene <strong>{pointsAvailable}</strong> puntos
                    {pointsAvailable > 0 && ` (${money(pointsAvailable * loyalty.point_value_cents)})`}.
                  </div>
                  {pointsAvailable > 0 && pointsAvailable >= loyalty.min_redeem_points && (
                    <div className="row">
                      <input
                        className="input sm num"
                        style={{ maxWidth: 140 }}
                        type="number"
                        min="0"
                        max={pointsAvailable}
                        placeholder="Puntos a usar"
                        value={pointsInput}
                        onChange={(e) => setPointsInput(e.target.value)}
                        aria-label="Puntos a usar"
                      />
                      <Button variant="text" size="sm" onClick={() => setPointsInput(String(pointsAvailable))}>
                        Usar todos
                      </Button>
                    </div>
                  )}
                  {pointsAvailable > 0 && pointsAvailable < loyalty.min_redeem_points && (
                    <span className="body-s muted">Se pueden usar a partir de {loyalty.min_redeem_points} puntos.</span>
                  )}
                  {preview?.credit_rejected === "min_points" && (
                    <span className="body-s error-text">El mínimo para canjear es {loyalty.min_redeem_points} puntos.</span>
                  )}
                  {preview && preview.points_redeemed < pointsToRedeem && preview.credit_rejected === null && (
                    <span className="body-s muted">Se usarán {preview.points_redeemed} puntos (no pueden superar el total de servicios).</span>
                  )}
                  {preview && pointsEarned(preview.total_cents, loyalty) > 0 && (
                    <span className="body-s" style={{ color: "var(--tertiary)" }}>
                      Ganará {pointsEarned(preview.total_cents, loyalty)} puntos al entregar y pagar.
                    </span>
                  )}
                </div>
              </Card>
            )}

            <Card title="Total">
              {previewError && <Banner tone="error">{previewError}</Banner>}
              {preview ? (
                <dl className="kv" style={{ margin: 0 }}>
                  {preview.steps.map((s) => (
                    <KvRow key={s.key} label={s.label} value={money(s.amount_cents)} strong={s.key === "total"} />
                  ))}
                  {preview.tax_included_cents > 0 && <KvRow label="IVA incluido" value={money(preview.tax_included_cents)} />}
                </dl>
              ) : (
                !previewError && <p className="muted" style={{ margin: 0 }}>Agrega servicios para ver el total.</p>
              )}
              {fulfillment === "delivery" && can("orders.price_override") && (
                <Checkbox label="Envío sin costo" checked={freeDelivery} onChange={setFreeDelivery} />
              )}
              {belowMinimum && (
                <Banner tone="warning">
                  El mínimo para entrega es {money(min_order_cents!)}.
                  {can("orders.price_override") ? " Puedes guardarla de todos modos." : ""}
                </Banner>
              )}
            </Card>

            <Card title="Notas">
              <div className="col gap-12">
                <TextArea label="Para el cliente" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                <TextArea label="Internas" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={2} hint="Solo las ve el equipo" />
              </div>
            </Card>

            {existing.data && ["delivered", "out_for_delivery", "ready"].includes(existing.data.order.status) && (
              <Banner tone="warning">
                Esta orden ya {existing.data.order.status === "delivered" ? "fue entregada" : "está lista"}: al guardar se recalculan el total y el saldo.
              </Banner>
            )}
            {serverError && <Banner tone="error">{serverError}</Banner>}
            <div className="row end sticky-bottom">
              <Button variant="text" onClick={() => navigate(-1)}>
                Cancelar
              </Button>
              <Button icon="check" size="lg" onClick={save} loading={saving} disabled={!customer || (!lines.length && fulfillment === "walk_in")}>
                {id
                  ? "Guardar cambios"
                  : !lines.length
                    ? fulfillment === "walk_in"
                      ? "Crear orden"
                      : bookPickup
                        ? "Crear y agendar recolección"
                        : "Crear orden sin servicios"
                    : `Crear orden${preview ? ` · ${money(preview.total_cents)}` : ""}`}
              </Button>
            </div>
          </div>
        </div>
      </div>
      {customer && (
        <AddressDialog
          open={addingAddress}
          customerId={customer.id}
          onClose={() => setAddingAddress(false)}
          onSaved={(a) => {
            setAddingAddress(false);
            setPickupAddress(a.id);
            setDeliveryAddress(a.id);
          }}
        />
      )}
    </Page>
  );
}

