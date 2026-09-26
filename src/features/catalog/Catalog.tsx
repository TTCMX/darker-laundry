import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Page } from "../../app/Shell";
import type { VolumeRuleConfig } from "../../domain/pricing";
import { errorMessage } from "../../lib/errors";
import { centsToInput, inputToCents, money, UNIT_LABEL, unitLabel } from "../../lib/format";
import { useCatalog } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { Category, DiscountRow, PricingRuleRow, Product, Zone } from "../../lib/types";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  Dialog,
  Empty,
  Icon,
  IconButton,
  Loading,
  Select,
  Tabs,
  TextArea,
  TextField,
  useToast,
} from "../../ui/components";

type TabKey = "products" | "categories" | "volume" | "discounts" | "zones";

function useSaver(table: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { tenantId } = useTenant();
  return {
    save: async (id: string | null, values: Record<string, unknown>) => {
      const r = id
        ? await supabase.from(table).update(values).eq("id", id)
        : await supabase.from(table).insert({ ...values, tenant_id: tenantId });
      if (r.error) {
        toast.show(errorMessage(r.error), { error: true });
        return false;
      }
      qc.invalidateQueries({ queryKey: ["catalog"] });
      toast.show("Guardado");
      return true;
    },
    remove: async (id: string) => {
      const r = await supabase.from(table).delete().eq("id", id);
      if (r.error) {
        toast.show(r.error.code === "23503" ? "Está en uso: mejor desactívalo." : errorMessage(r.error), { error: true });
        return false;
      }
      qc.invalidateQueries({ queryKey: ["catalog"] });
      return true;
    },
  };
}

export function CatalogPage() {
  const { can } = useTenant();
  const catalog = useCatalog();
  const tabs = [
    ...(can("catalog.manage")
      ? [
          { value: "products" as const, label: "Servicios" },
          { value: "categories" as const, label: "Categorías" },
        ]
      : []),
    ...(can("pricing.manage")
      ? [
          { value: "volume" as const, label: "Precio por volumen" },
          { value: "discounts" as const, label: "Descuentos" },
          { value: "zones" as const, label: "Zonas de entrega" },
        ]
      : []),
  ];
  const [tab, setTab] = useState<TabKey>(tabs[0]?.value ?? "products");
  const data = catalog.data;
  return (
    <Page title="Catálogo y precios">
      <div className="col gap-16">
        <Tabs value={tab} onChange={setTab} tabs={tabs} />
        {!data ? (
          <Loading />
        ) : tab === "products" ? (
          <Products products={data.products} categories={data.categories} />
        ) : tab === "categories" ? (
          <Categories categories={data.categories} />
        ) : tab === "volume" ? (
          <VolumeRules rules={data.rules} products={data.products} categories={data.categories} />
        ) : tab === "discounts" ? (
          <Discounts discounts={data.discounts} products={data.products} categories={data.categories} />
        ) : (
          <Zones zones={data.zones} />
        )}
      </div>
    </Page>
  );
}

// ── Products ────────────────────────────────────────────────────────────────

function Products({ products, categories }: { products: Product[]; categories: Category[] }) {
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const shown = products.filter((p) => !filter || p.category_id === filter);
  return (
    <>
      <div className="row between wrap">
        <div className="chips">
          <Chip on={!filter} onClick={() => setFilter(null)}>
            Todas
          </Chip>
          {categories.map((c) => (
            <Chip key={c.id} on={filter === c.id} onClick={() => setFilter(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
        <Button icon="add" onClick={() => setEditing("new")}>
          Servicio
        </Button>
      </div>
      <Card variant="flush">
        {shown.length === 0 ? (
          <Empty icon="sell" title="Sin servicios">
            Crea los servicios que ofreces: lavado por kilo, camisas, edredones, tenis…
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Servicio</th>
                  <th>Categoría</th>
                  <th className="right">Precio</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => setEditing(p)}>
                    <td>
                      <div>{p.name}</div>
                      <div className="body-s muted">{p.sku}</div>
                    </td>
                    <td>{p.category_id ? catName.get(p.category_id) : "—"}</td>
                    <td className="right num nowrap">{p.variable_price ? "Variable" : `${money(p.base_price_cents)} / ${unitLabel(p.unit)}`}</td>
                    <td>{p.active ? <Badge tone="success">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
                    <td className="right">
                      <Icon name="chevron_right" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ProductDialog product={editing === "new" ? null : editing} categories={categories} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProductDialog({ product, categories, onClose }: { product: Product | null; categories: Category[]; onClose: () => void }) {
  const saver = useSaver("products");
  const [f, setF] = useState({
    name: product?.name ?? "",
    sku: product?.sku ?? "",
    category_id: product?.category_id ?? "",
    unit: product?.unit ?? "piece",
    price: centsToInput(product?.base_price_cents ?? null),
    variable_price: product?.variable_price ?? false,
    taxable: product?.taxable ?? true,
    active: product?.active ?? true,
    estimated_minutes: product?.estimated_minutes?.toString() ?? "",
    description: product?.description ?? "",
    production_notes: product?.production_notes ?? "",
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const ok = await saver.save(product?.id ?? null, {
      name: f.name.trim(),
      sku: f.sku.trim() || null,
      category_id: f.category_id || null,
      unit: f.unit,
      base_price_cents: f.variable_price ? 0 : (inputToCents(f.price) ?? 0),
      variable_price: f.variable_price,
      taxable: f.taxable,
      active: f.active,
      estimated_minutes: f.estimated_minutes ? Number(f.estimated_minutes) : null,
      description: f.description.trim() || null,
      production_notes: f.production_notes.trim() || null,
    });
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      title={product ? "Editar servicio" : "Nuevo servicio"}
      onClose={onClose}
      actions={
        <>
          {product && (
            <Button variant="danger-text" onClick={() => setConfirmDelete(true)} style={{ marginRight: "auto" }}>
              Eliminar
            </Button>
          )}
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!f.name.trim()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <TextField label="Nombre" value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus />
        <div className="grid cols-2">
          <TextField label="SKU" value={f.sku} onChange={(e) => set("sku", e.target.value)} />
          <Select label="Categoría" value={f.category_id} onChange={(e) => set("category_id", e.target.value)} placeholder="Sin categoría" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          <Select label="Unidad" value={f.unit} onChange={(e) => set("unit", e.target.value)} options={Object.entries(UNIT_LABEL).map(([value, label]) => ({ value, label: `${label} (${value})` }))} />
          <TextField label="Precio" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} disabled={f.variable_price} />
        </div>
        <Checkbox label="Precio variable (se captura en cada orden)" checked={f.variable_price} onChange={(v) => set("variable_price", v)} />
        <Checkbox label="Grava impuestos" checked={f.taxable} onChange={(v) => set("taxable", v)} />
        <Checkbox label="Activo" checked={f.active} onChange={(v) => set("active", v)} />
        <TextField label="Tiempo estimado de producción (min)" type="number" min="0" value={f.estimated_minutes} onChange={(e) => set("estimated_minutes", e.target.value)} />
        <TextArea label="Descripción" value={f.description} onChange={(e) => set("description", e.target.value)} rows={2} />
        <TextArea label="Indicaciones de producción" value={f.production_notes} onChange={(e) => set("production_notes", e.target.value)} rows={2} />
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="¿Eliminar servicio?"
        message="Si ya se usó en órdenes, mejor desactívalo."
        danger
        confirmLabel="Eliminar"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (await saver.remove(product!.id)) onClose();
          setConfirmDelete(false);
        }}
      />
    </Dialog>
  );
}

// ── Categories ──────────────────────────────────────────────────────────────

function Categories({ categories }: { categories: Category[] }) {
  const saver = useSaver("product_categories");
  const [name, setName] = useState("");
  return (
    <Card variant="flush">
      <div className="row" style={{ padding: 16 }}>
        <input className="input" placeholder="Nueva categoría" value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          icon="add"
          disabled={!name.trim()}
          onClick={async () => {
            if (await saver.save(null, { name: name.trim(), sort_order: categories.length })) setName("");
          }}
        >
          Agregar
        </Button>
      </div>
      <div className="list">
        {categories.map((c, i) => (
          <div key={c.id} className="list-item">
            <div className="grow">
              <input className="input sm" defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && saver.save(c.id, { name: e.target.value.trim() })} />
            </div>
            <IconButton icon="arrow_upward" label="Subir" disabled={i === 0} onClick={() => saver.save(c.id, { sort_order: i - 1 }).then(() => saver.save(categories[i - 1]!.id, { sort_order: i }))} />
            <Checkbox label="Activa" checked={c.active} onChange={(v) => saver.save(c.id, { active: v })} />
            <IconButton icon="delete" label="Eliminar" onClick={() => saver.remove(c.id)} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Volume rules ────────────────────────────────────────────────────────────

function VolumeRules({ rules, products, categories }: { rules: PricingRuleRow[]; products: Product[]; categories: Category[] }) {
  const [editing, setEditing] = useState<PricingRuleRow | "new" | null>(null);
  const pName = new Map(products.map((p) => [p.id, p.name]));
  const cName = new Map(categories.map((c) => [c.id, c.name]));
  return (
    <>
      <Banner>
        Define paquetes (“2 pares → $280”) y precios desde cierta cantidad (“6 o más → $100 c/u”). El sistema nunca cobra más que el precio de lista.
      </Banner>
      <div className="row end">
        <Button icon="add" onClick={() => setEditing("new")}>
          Regla
        </Button>
      </div>
      <Card variant="flush">
        {rules.length === 0 ? (
          <Empty icon="stacked_line_chart" title="Sin reglas de volumen" />
        ) : (
          <div className="list">
            {rules.map((r) => (
              <div key={r.id} className="list-item clickable" onClick={() => setEditing(r)}>
                <div className="grow">
                  <div className="headline">{r.name}</div>
                  <div className="supporting">
                    {r.product_id ? pName.get(r.product_id) : `Categoría ${cName.get(r.category_id ?? "") ?? ""}`} ·{" "}
                    {(r.config.packages ?? []).map((p) => `${p.qty}→${money(p.total_cents)}`).join(", ")}
                    {(r.config.tiers ?? []).map((t) => ` · ${t.min_qty}+ → ${money(t.unit_price_cents)} c/u`).join("")}
                  </div>
                </div>
                {r.active ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>}
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && <VolumeDialog rule={editing === "new" ? null : editing} products={products} categories={categories} onClose={() => setEditing(null)} />}
    </>
  );
}

function VolumeDialog({ rule, products, categories, onClose }: { rule: PricingRuleRow | null; products: Product[]; categories: Category[]; onClose: () => void }) {
  const saver = useSaver("pricing_rules");
  const [name, setName] = useState(rule?.name ?? "");
  const [target, setTarget] = useState(rule?.product_id ? `p:${rule.product_id}` : rule?.category_id ? `c:${rule.category_id}` : "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [packages, setPackages] = useState((rule?.config.packages ?? []).map((p) => ({ qty: String(p.qty), total: centsToInput(p.total_cents) })));
  const [tiers, setTiers] = useState((rule?.config.tiers ?? []).map((t) => ({ min: String(t.min_qty), unit: centsToInput(t.unit_price_cents) })));
  const save = async () => {
    const config: VolumeRuleConfig = {
      packages: packages.filter((p) => Number(p.qty) > 0 && inputToCents(p.total) !== null).map((p) => ({ qty: Math.round(Number(p.qty)), total_cents: inputToCents(p.total)! })),
      tiers: tiers.filter((t) => Number(t.min) > 0 && inputToCents(t.unit) !== null).map((t) => ({ min_qty: Number(t.min), unit_price_cents: inputToCents(t.unit)! })),
    };
    const ok = await saver.save(rule?.id ?? null, {
      name: name.trim(),
      product_id: target.startsWith("p:") ? target.slice(2) : null,
      category_id: target.startsWith("c:") ? target.slice(2) : null,
      active,
      config,
    });
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      wide
      title={rule ? "Editar regla de volumen" : "Nueva regla de volumen"}
      onClose={onClose}
      actions={
        <>
          {rule && (
            <Button variant="danger-text" style={{ marginRight: "auto" }} onClick={async () => (await saver.remove(rule.id)) && onClose()}>
              Eliminar
            </Button>
          )}
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!name.trim() || !target}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <div className="grid cols-2">
          <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tenis por pares" />
          <Select
            label="Aplica a"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Elige servicio o categoría"
            options={[
              ...products.map((p) => ({ value: `p:${p.id}`, label: `Servicio: ${p.name}` })),
              ...categories.map((c) => ({ value: `c:${c.id}`, label: `Categoría: ${c.name}` })),
            ]}
          />
        </div>
        <div className="title-s">Paquetes (cantidad exacta → precio total)</div>
        {packages.map((p, i) => (
          <div key={i} className="row">
            <input className="input sm" type="number" min="1" placeholder="Cantidad" value={p.qty} onChange={(e) => setPackages((ps) => ps.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <input className="input sm" inputMode="decimal" placeholder="Total" value={p.total} onChange={(e) => setPackages((ps) => ps.map((x, j) => (j === i ? { ...x, total: e.target.value } : x)))} />
            <IconButton icon="close" label="Quitar" onClick={() => setPackages((ps) => ps.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button variant="text" icon="add" onClick={() => setPackages((ps) => [...ps, { qty: String(ps.length + 1), total: "" }])}>
          Paquete
        </Button>
        <div className="title-s">Desde cierta cantidad (precio unitario)</div>
        {tiers.map((t, i) => (
          <div key={i} className="row">
            <input className="input sm" type="number" min="0" step="0.1" placeholder="Desde" value={t.min} onChange={(e) => setTiers((ts) => ts.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} />
            <input className="input sm" inputMode="decimal" placeholder="Precio c/u" value={t.unit} onChange={(e) => setTiers((ts) => ts.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
            <IconButton icon="close" label="Quitar" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button variant="text" icon="add" onClick={() => setTiers((ts) => [...ts, { min: "", unit: "" }])}>
          Escalón
        </Button>
        <Checkbox label="Activa" checked={active} onChange={setActive} />
      </div>
    </Dialog>
  );
}

// ── Discounts ───────────────────────────────────────────────────────────────

function Discounts({ discounts, products, categories }: { discounts: DiscountRow[]; products: Product[]; categories: Category[] }) {
  const [editing, setEditing] = useState<DiscountRow | "new" | null>(null);
  return (
    <>
      <div className="row end">
        <Button icon="add" onClick={() => setEditing("new")}>
          Descuento
        </Button>
      </div>
      <Card variant="flush">
        {discounts.length === 0 ? (
          <Empty icon="percent" title="Sin descuentos" />
        ) : (
          <div className="list">
            {discounts.map((d) => (
              <div key={d.id} className="list-item clickable" onClick={() => setEditing(d)}>
                <div className="grow">
                  <div className="headline">
                    {d.name} {d.code && <Badge tone="outline">{d.code}</Badge>}
                  </div>
                  <div className="supporting">
                    {d.kind === "percentage" ? `${d.value}%` : money(d.value)}
                    {d.product_ids.length + d.category_ids.length > 0 ? " · en servicios seleccionados" : " · toda la orden"}
                    {d.min_order_cents ? ` · mínimo ${money(d.min_order_cents)}` : ""}
                    {d.usage_limit ? ` · hasta ${d.usage_limit} usos` : ""}
                  </div>
                </div>
                {d.active ? <Badge tone="success">Activo</Badge> : <Badge>Inactivo</Badge>}
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && <DiscountDialog discount={editing === "new" ? null : editing} products={products} categories={categories} onClose={() => setEditing(null)} />}
    </>
  );
}

const toLocalDate = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function DiscountDialog({ discount, products, categories, onClose }: { discount: DiscountRow | null; products: Product[]; categories: Category[]; onClose: () => void }) {
  const saver = useSaver("discounts");
  const [f, setF] = useState({
    name: discount?.name ?? "",
    code: discount?.code ?? "",
    kind: discount?.kind ?? ("percentage" as "percentage" | "fixed"),
    value: discount ? (discount.kind === "fixed" ? centsToInput(discount.value) : String(discount.value)) : "",
    product_ids: discount?.product_ids ?? [],
    category_ids: discount?.category_ids ?? [],
    min_order: centsToInput(discount?.min_order_cents ?? null),
    max_discount: centsToInput(discount?.max_discount_cents ?? null),
    starts_at: toLocalDate(discount?.starts_at ?? null),
    ends_at: toLocalDate(discount?.ends_at ?? null),
    usage_limit: discount?.usage_limit?.toString() ?? "",
    active: discount?.active ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k: "product_ids" | "category_ids", id: string) => set(k, f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id]);
  const save = async () => {
    const value = f.kind === "fixed" ? (inputToCents(f.value) ?? 0) : Number(f.value);
    const ok = await saver.save(discount?.id ?? null, {
      name: f.name.trim(),
      code: f.code.trim() || null,
      kind: f.kind,
      value,
      product_ids: f.product_ids,
      category_ids: f.category_ids,
      min_order_cents: inputToCents(f.min_order),
      max_discount_cents: inputToCents(f.max_discount),
      starts_at: f.starts_at ? new Date(`${f.starts_at}T00:00:00`).toISOString() : null,
      ends_at: f.ends_at ? new Date(`${f.ends_at}T23:59:59`).toISOString() : null,
      usage_limit: f.usage_limit ? Number(f.usage_limit) : null,
      active: f.active,
    });
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      wide
      title={discount ? "Editar descuento" : "Nuevo descuento"}
      onClose={onClose}
      actions={
        <>
          {discount && (
            <Button variant="danger-text" style={{ marginRight: "auto" }} onClick={async () => (await saver.remove(discount.id)) && onClose()}>
              Eliminar
            </Button>
          )}
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!f.name.trim() || !f.value}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <div className="grid cols-2">
          <TextField label="Nombre" value={f.name} onChange={(e) => set("name", e.target.value)} />
          <TextField label="Código (opcional)" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} />
          <Select
            label="Tipo"
            value={f.kind}
            onChange={(e) => set("kind", e.target.value as "percentage" | "fixed")}
            options={[
              { value: "percentage", label: "Porcentaje" },
              { value: "fixed", label: "Monto fijo" },
            ]}
          />
          <TextField label={f.kind === "percentage" ? "Porcentaje" : "Monto"} inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value)} />
          <TextField label="Orden mínima" inputMode="decimal" value={f.min_order} onChange={(e) => set("min_order", e.target.value)} />
          <TextField label="Descuento máximo" inputMode="decimal" value={f.max_discount} onChange={(e) => set("max_discount", e.target.value)} />
          <TextField label="Desde" type="date" value={f.starts_at} onChange={(e) => set("starts_at", e.target.value)} />
          <TextField label="Hasta" type="date" value={f.ends_at} onChange={(e) => set("ends_at", e.target.value)} />
          <TextField label="Límite de usos" type="number" min="1" value={f.usage_limit} onChange={(e) => set("usage_limit", e.target.value)} />
        </div>
        <div className="title-s">Aplica a (vacío = toda la orden)</div>
        <div className="row wrap">
          {categories.map((c) => (
            <Chip key={c.id} on={f.category_ids.includes(c.id)} onClick={() => toggle("category_ids", c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
        <div className="row wrap">
          {products.map((p) => (
            <Chip key={p.id} on={f.product_ids.includes(p.id)} onClick={() => toggle("product_ids", p.id)}>
              {p.name}
            </Chip>
          ))}
        </div>
        <Checkbox label="Activo" checked={f.active} onChange={(v) => set("active", v)} />
      </div>
    </Dialog>
  );
}

// ── Zones ───────────────────────────────────────────────────────────────────

function Zones({ zones }: { zones: Zone[] }) {
  const [editing, setEditing] = useState<Zone | "new" | null>(null);
  return (
    <>
      <div className="row end">
        <Button icon="add" onClick={() => setEditing("new")}>
          Zona
        </Button>
      </div>
      <Card variant="flush">
        {zones.length === 0 ? (
          <Empty icon="map" title="Sin zonas">
            Sin zonas se usa la tarifa general de Ajustes → Entregas.
          </Empty>
        ) : (
          <div className="list">
            {zones.map((z) => (
              <div key={z.id} className="list-item clickable" onClick={() => setEditing(z)}>
                <div className="grow">
                  <div className="headline">{z.name}</div>
                  <div className="supporting">
                    Envío {money(z.fee_cents)}
                    {z.free_over_cents !== null && ` · gratis desde ${money(z.free_over_cents)}`}
                    {z.min_order_cents !== null && ` · mínimo ${money(z.min_order_cents)}`}
                    {z.postal_codes.length > 0 && ` · CP ${z.postal_codes.slice(0, 5).join(", ")}${z.postal_codes.length > 5 ? "…" : ""}`}
                  </div>
                </div>
                {z.active ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>}
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && <ZoneDialog zone={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ZoneDialog({ zone, onClose }: { zone: Zone | null; onClose: () => void }) {
  const saver = useSaver("delivery_zones");
  const [f, setF] = useState({ name: "", fee: "", free_over: "", min_order: "", postal_codes: "", active: true });
  useEffect(() => {
    setF({
      name: zone?.name ?? "",
      fee: centsToInput(zone?.fee_cents ?? 0),
      free_over: centsToInput(zone?.free_over_cents ?? null),
      min_order: centsToInput(zone?.min_order_cents ?? null),
      postal_codes: (zone?.postal_codes ?? []).join(", "),
      active: zone?.active ?? true,
    });
  }, [zone]);
  const save = async () => {
    const ok = await saver.save(zone?.id ?? null, {
      name: f.name.trim(),
      fee_cents: inputToCents(f.fee) ?? 0,
      free_over_cents: inputToCents(f.free_over),
      min_order_cents: inputToCents(f.min_order),
      postal_codes: f.postal_codes
        .split(/[\s,;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      active: f.active,
    });
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      title={zone ? "Editar zona" : "Nueva zona"}
      onClose={onClose}
      actions={
        <>
          {zone && (
            <Button variant="danger-text" style={{ marginRight: "auto" }} onClick={async () => (await saver.remove(zone.id)) && onClose()}>
              Eliminar
            </Button>
          )}
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!f.name.trim()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <TextField label="Nombre" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid cols-2">
          <TextField label="Costo de envío" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
          <TextField label="Gratis desde" inputMode="decimal" value={f.free_over} onChange={(e) => setF({ ...f, free_over: e.target.value })} />
          <TextField label="Orden mínima" inputMode="decimal" value={f.min_order} onChange={(e) => setF({ ...f, min_order: e.target.value })} />
        </div>
        <TextArea label="Códigos postales" value={f.postal_codes} onChange={(e) => setF({ ...f, postal_codes: e.target.value })} hint="Separados por coma; se usan para sugerir la zona de una dirección" />
        <Checkbox label="Activa" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      </div>
    </Dialog>
  );
}
