import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Page } from "../../app/Shell";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "../../domain/payments";
import { DEFAULT_STAGES } from "../../domain/pricing";
import { resolveSettings, type DeliveryWindow, type TenantSettings, type Weekday } from "../../domain/settings";
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABEL, TEMPLATE_VARIABLES, type NotificationEvent } from "../../domain/templates";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { centsToInput, inputToCents, money } from "../../lib/format";
import { describeLoyalty } from "../../domain/loyalty";
import { printerPrefs } from "../../lib/printing/bluetooth";
import type { PaperWidth } from "../../lib/printing/escpos";
import { sampleReceipt } from "../../lib/printing/sample";
import { ReceiptPreview } from "../orders/PrintReceipt";
import { PrinterCard } from "./PrinterCard";
import { OperationCard, PlanCard } from "../plan/Plan";
import { useRoles, useWorkflows } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { TemplateRow, TenantRow, WorkflowStep } from "../../lib/types";
import { Badge, Banner, Button, Card, Checkbox, Chip, Dialog, Icon, IconButton, Loading, Segmented, Select, Tabs, TextArea, TextField, useToast } from "../../ui/components";

type TabKey = "plan" | "business" | "operations" | "delivery" | "pricing" | "loyalty" | "receipts" | "payments" | "notifications";

export function SettingsPage() {
  const { tenantId, ops } = useTenant();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<TabKey>("business");
  const q = useQuery({
    queryKey: ["tenant-row", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
      if (error) throw error;
      return data as TenantRow;
    },
  });
  return (
    <Page title="Ajustes">
      <div className="col gap-16">
        {params.get("welcome") && (
          <Banner tone="success" icon="celebration">
            <div className="title-s">¡Tu lavandería está lista!</div>
            Tienes <b>3 meses de prueba gratis con todas las funciones</b>. Siguientes pasos: revisa tu flujo de producción en <b>Operación</b>, crea tus
            servicios en <b>Catálogo</b> e invita a tu equipo en <b>Equipo</b>.
          </Banner>
        )}
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "business", label: "Negocio" },
            { value: "operations", label: "Operación" },
            ...(ops.delivery ? [{ value: "delivery" as const, label: "Entregas" }] : []),
            { value: "pricing", label: "Precios e impuestos" },
            { value: "loyalty", label: "Lealtad" },
            { value: "receipts", label: "Tickets" },
            { value: "payments", label: "Pagos" },
            { value: "notifications", label: "Notificaciones" },
            { value: "plan", label: "Plan" },
          ]}
        />
        {!q.data ? (
          <Loading />
        ) : tab === "plan" ? (
          <div className="col gap-16">
            <PlanCard />
            <OperationCard />
          </div>
        ) : tab === "business" ? (
          <Business row={q.data} />
        ) : tab === "operations" ? (
          <Operations row={q.data} />
        ) : tab === "delivery" ? (
          <DeliverySettings row={q.data} />
        ) : tab === "pricing" ? (
          <PricingSettings row={q.data} />
        ) : tab === "loyalty" ? (
          <LoyaltySettingsPanel row={q.data} />
        ) : tab === "receipts" ? (
          <ReceiptSettingsPanel row={q.data} />
        ) : tab === "payments" ? (
          <PaymentsSettings row={q.data} />
        ) : (
          <NotificationSettings row={q.data} />
        )}
      </div>
    </Page>
  );
}

function useSaveTenant() {
  const { tenantId, refresh } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (values: Partial<TenantRow>) => {
    setSaving(true);
    const { error } = await supabase.from("tenants").update(values).eq("id", tenantId);
    setSaving(false);
    if (error) return toast.show(errorMessage(error), { error: true });
    qc.invalidateQueries({ queryKey: ["tenant-row"] });
    await refresh();
    toast.show("Ajustes guardados");
  };
  return { save, saving };
}

/** Edits a copy of the settings and saves the whole object. */
function useSettingsDraft(row: TenantRow) {
  const [draft, setDraft] = useState<TenantSettings>(() => resolveSettings(row.settings));
  const { save, saving } = useSaveTenant();
  const update = (fn: (s: TenantSettings) => void) =>
    setDraft((d) => {
      const copy = structuredClone(d);
      fn(copy);
      return copy;
    });
  return { draft, update, saving, save: () => save({ settings: draft as unknown as Record<string, unknown> }) };
}

function SaveBar({ onSave, saving }: { onSave: () => void; saving: boolean }) {
  return (
    <div className="row end sticky-bottom">
      <Button icon="save" onClick={onSave} loading={saving}>
        Guardar
      </Button>
    </div>
  );
}

function Business({ row }: { row: TenantRow }) {
  const { save, saving } = useSaveTenant();
  const [f, setF] = useState(row);
  const set = (k: keyof TenantRow) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Card>
      <div className="col gap-16">
        <div className="grid cols-2">
          <TextField label="Nombre comercial" value={f.name} onChange={set("name")} />
          <TextField label="Razón social" value={f.legal_name ?? ""} onChange={set("legal_name")} />
          <TextField label="RFC / ID fiscal" value={f.tax_id ?? ""} onChange={set("tax_id")} />
          <TextField label="Teléfono" value={f.phone ?? ""} onChange={set("phone")} />
          <TextField label="Correo" type="email" value={f.email ?? ""} onChange={set("email")} />
          <TextField label="Logo (URL)" value={f.logo_url ?? ""} onChange={set("logo_url")} />
          <TextField label="Moneda" value={f.currency} maxLength={3} onChange={set("currency")} />
          <TextField label="Zona horaria" value={f.timezone} onChange={set("timezone")} hint="Ej. America/Mexico_City" />
        </div>
        <TextArea label="Dirección" value={f.address ?? ""} onChange={set("address")} rows={2} />
        <SaveBar
          saving={saving}
          onSave={() =>
            save({
              name: f.name,
              legal_name: f.legal_name || null,
              tax_id: f.tax_id || null,
              phone: f.phone || null,
              email: f.email || null,
              logo_url: f.logo_url || null,
              currency: f.currency.toUpperCase(),
              timezone: f.timezone,
              address: f.address || null,
            })
          }
        />
      </div>
    </Card>
  );
}

const DAYS: { value: Weekday; label: string }[] = [
  { value: "mon", label: "Lun" },
  { value: "tue", label: "Mar" },
  { value: "wed", label: "Mié" },
  { value: "thu", label: "Jue" },
  { value: "fri", label: "Vie" },
  { value: "sat", label: "Sáb" },
  { value: "sun", label: "Dom" },
];

function Operations({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const o = draft.operations;
  return (
    <div className="col gap-16">
      <Card title="Tiempos y horario">
        <div className="col gap-16">
          <div className="grid cols-3">
            <TextField label="Tiempo de entrega estándar (horas)" type="number" min="1" value={o.default_turnaround_hours} onChange={(e) => update((s) => void (s.operations.default_turnaround_hours = Number(e.target.value)))} />
            <TextField label="Avisar “por vencer” con (horas)" type="number" min="1" value={o.approaching_hours} onChange={(e) => update((s) => void (s.operations.approaching_hours = Number(e.target.value)))} />
            <TextField label="Hora de corte" type="time" value={o.order_cutoff ?? ""} onChange={(e) => update((s) => void (s.operations.order_cutoff = e.target.value || null))} />
            <TextField label="Abre" type="time" value={o.opening_time} onChange={(e) => update((s) => void (s.operations.opening_time = e.target.value))} />
            <TextField label="Cierra" type="time" value={o.closing_time} onChange={(e) => update((s) => void (s.operations.closing_time = e.target.value))} />
          </div>
          <div className="row wrap">
            {DAYS.map((d) => (
              <Chip
                key={d.value}
                on={o.working_days.includes(d.value)}
                onClick={() =>
                  update((s) => {
                    const w = s.operations.working_days;
                    s.operations.working_days = w.includes(d.value) ? w.filter((x) => x !== d.value) : [...w, d.value];
                  })
                }
              >
                {d.label}
              </Chip>
            ))}
          </div>
          <Card title="Estados de cliente" variant="filled">
            <div className="grid cols-3">
              <TextField label="Activo hasta (días sin ordenar)" type="number" value={draft.customers.status_rules.active_days} onChange={(e) => update((s) => void (s.customers.status_rules.active_days = Number(e.target.value)))} />
              <TextField label="En riesgo hasta" type="number" value={draft.customers.status_rules.at_risk_days} onChange={(e) => update((s) => void (s.customers.status_rules.at_risk_days = Number(e.target.value)))} />
              <TextField label="Inactivo hasta (luego: perdido)" type="number" value={draft.customers.status_rules.churned_days} onChange={(e) => update((s) => void (s.customers.status_rules.churned_days = Number(e.target.value)))} />
            </div>
          </Card>
          <SaveBar onSave={save} saving={saving} />
        </div>
      </Card>
      <WorkflowEditor />
    </div>
  );
}

function WorkflowEditor() {
  const { tenantId } = useTenant();
  const wf = useWorkflows();
  const roles = useRoles();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<WorkflowStep | "new" | null>(null);
  if (wf.isLoading) return <Loading />;
  const workflow = wf.data?.workflows.find((w) => w.is_default) ?? wf.data?.workflows[0];
  const steps = (wf.data?.steps ?? []).filter((s) => s.workflow_id === workflow?.id).sort((a, b) => a.position - b.position);
  const refresh = () => qc.invalidateQueries({ queryKey: ["workflows"] });
  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await p;
    if (error) toast.show(errorMessage(error), { error: true });
    refresh();
  };
  const swap = async (a: WorkflowStep, b: WorkflowStep) => {
    await run(supabase.from("workflow_steps").update({ position: b.position }).eq("id", a.id));
    await run(supabase.from("workflow_steps").update({ position: a.position }).eq("id", b.id));
  };

  const createWorkflow = () =>
    run(supabase.from("workflows").insert({ tenant_id: tenantId, name: "Estándar", is_default: true }));

  return (
    <Card
      title={
        <div className="col gap-4">
          <h3>Flujo de producción</h3>
          <span className="body-s muted">Las fases que recorre cada orden en planta. Los cambios aplican a órdenes que inicien producción después.</span>
        </div>
      }
      action={
        workflow && (
          <Button variant="tonal" icon="add" onClick={() => setEditing("new")}>
            Fase
          </Button>
        )
      }
      variant="flush"
    >
      {!workflow ? (
        <div style={{ padding: 16 }}>
          <Button onClick={createWorkflow}>Crear flujo</Button>
        </div>
      ) : (
        <div className="list">
          {steps.map((s, i) => (
            <div key={s.id} className="list-item" style={s.active ? undefined : { opacity: 0.5 }}>
              <span className="lead">{i + 1}</span>
              <div className="grow">
                <div className="headline">{s.name}</div>
                <div className="supporting">
                  {s.estimated_minutes ? `${s.estimated_minutes} min` : "Sin tiempo estimado"}
                  {s.requires_assignment && " · requiere asignación"}
                  {s.allowed_role_ids.length > 0 && ` · roles: ${s.allowed_role_ids.map((r) => roles.data?.find((x) => x.id === r)?.name).filter(Boolean).join(", ")}`}
                  {!s.active && " · desactivada"}
                </div>
              </div>
              <IconButton icon="arrow_upward" label="Subir" disabled={i === 0} onClick={() => swap(s, steps[i - 1]!)} />
              <IconButton icon="arrow_downward" label="Bajar" disabled={i === steps.length - 1} onClick={() => swap(s, steps[i + 1]!)} />
              <IconButton icon="edit" label="Editar" onClick={() => setEditing(s)} />
            </div>
          ))}
        </div>
      )}
      {editing && workflow && (
        <StepDialog
          step={editing === "new" ? null : editing}
          workflowId={workflow.id}
          nextPosition={(steps.at(-1)?.position ?? 0) + 1}
          roles={roles.data ?? []}
          onClose={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function StepDialog({
  step,
  workflowId,
  nextPosition,
  roles,
  onClose,
}: {
  step: WorkflowStep | null;
  workflowId: string;
  nextPosition: number;
  roles: { id: string; name: string; is_owner: boolean }[];
  onClose: () => void;
}) {
  const { tenantId } = useTenant();
  const toast = useToast();
  const [name, setName] = useState(step?.name ?? "");
  const [minutes, setMinutes] = useState(step?.estimated_minutes?.toString() ?? "");
  const [requires, setRequires] = useState(step?.requires_assignment ?? false);
  const [active, setActive] = useState(step?.active ?? true);
  const [allowed, setAllowed] = useState<string[]>(step?.allowed_role_ids ?? []);
  const save = async () => {
    const values = {
      name: name.trim(),
      estimated_minutes: minutes ? Number(minutes) : null,
      requires_assignment: requires,
      active,
      allowed_role_ids: allowed,
    };
    const { error } = step
      ? await supabase.from("workflow_steps").update(values).eq("id", step.id)
      : await supabase.from("workflow_steps").insert({ ...values, tenant_id: tenantId, workflow_id: workflowId, position: nextPosition });
    if (error) return toast.show(errorMessage(error), { error: true });
    toast.show("Fase guardada");
    onClose();
  };
  return (
    <Dialog
      open
      title={step ? `Editar fase: ${step.name}` : "Nueva fase"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!name.trim()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} placeholder="Lavado, Planchado, Empaque…" autoFocus />
        <TextField label="Duración estimada (min)" type="number" min="0" value={minutes} onChange={(e) => setMinutes(e.target.value)} hint="Se usa para detectar órdenes en riesgo" />
        <Checkbox label="Requiere que alguien la tome antes de completarla" checked={requires} onChange={setRequires} />
        <Checkbox label="Activa" checked={active} onChange={setActive} />
        <div className="title-s">Roles que pueden trabajarla (vacío = cualquiera de producción)</div>
        <div className="row wrap">
          {roles
            .filter((r) => !r.is_owner)
            .map((r) => (
              <Chip key={r.id} on={allowed.includes(r.id)} onClick={() => setAllowed((a) => (a.includes(r.id) ? a.filter((x) => x !== r.id) : [...a, r.id]))}>
                {r.name}
              </Chip>
            ))}
        </div>
      </div>
    </Dialog>
  );
}

function DeliverySettings({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const d = draft.delivery;
  const setWindow = (i: number, patch: Partial<DeliveryWindow>) => update((s) => void (s.delivery.windows[i] = { ...s.delivery.windows[i]!, ...patch }));
  return (
    <Card>
      <div className="col gap-16">
        <div className="title-s">Horarios de recolección y entrega</div>
        {d.windows.map((w, i) => (
          <div key={w.id} className="row wrap">
            <input className="input sm" style={{ maxWidth: 200 }} value={w.label} onChange={(e) => setWindow(i, { label: e.target.value })} aria-label="Nombre" />
            <input className="input sm" style={{ maxWidth: 130 }} type="time" value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })} aria-label="Inicio" />
            <input className="input sm" style={{ maxWidth: 130 }} type="time" value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })} aria-label="Fin" />
            <IconButton icon="delete" label="Quitar" onClick={() => update((s) => void s.delivery.windows.splice(i, 1))} />
          </div>
        ))}
        <div>
          <Button variant="text" icon="add" onClick={() => update((s) => void s.delivery.windows.push({ id: Math.random().toString(36).slice(2, 8), label: "Nuevo horario", start: "09:00", end: "12:00" }))}>
            Horario
          </Button>
        </div>
        <div className="title-s">Tarifa general (sin zona)</div>
        <div className="grid cols-3">
          <TextField label="Costo de envío" inputMode="decimal" value={centsToInput(d.default_fee_cents)} onChange={(e) => update((s) => void (s.delivery.default_fee_cents = inputToCents(e.target.value) ?? 0))} />
          <TextField label="Gratis desde" inputMode="decimal" value={centsToInput(d.default_free_over_cents)} onChange={(e) => update((s) => void (s.delivery.default_free_over_cents = inputToCents(e.target.value)))} />
          <TextField label="Orden mínima" inputMode="decimal" value={centsToInput(d.min_order_cents)} onChange={(e) => update((s) => void (s.delivery.min_order_cents = inputToCents(e.target.value)))} />
        </div>
        <Checkbox label="Si hay un solo courier, asignarle las paradas automáticamente" checked={d.auto_assign_single_courier} onChange={(v) => update((s) => void (s.delivery.auto_assign_single_courier = v))} />
        <p className="body-s muted" style={{ margin: 0 }}>
          Las zonas con tarifa propia se configuran en Catálogo → Zonas de entrega.
        </p>
        <SaveBar onSave={save} saving={saving} />
      </div>
    </Card>
  );
}

function PricingSettings({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const feeBeforeDiscounts = draft.pricing.stages.indexOf("delivery_fee") < draft.pricing.stages.indexOf("discounts");
  return (
    <Card>
      <div className="col gap-16">
        <div className="title-s">Impuestos</div>
        <div className="grid cols-3">
          <Select
            label="Modo"
            value={draft.tax.mode}
            onChange={(e) => update((s) => void (s.tax.mode = e.target.value as TenantSettings["tax"]["mode"]))}
            options={[
              { value: "none", label: "Sin impuestos" },
              { value: "inclusive", label: "Incluidos en los precios" },
              { value: "exclusive", label: "Se suman al total" },
            ]}
          />
          <TextField label="Tasa (%)" type="number" step="0.01" value={draft.tax.rate_percent} onChange={(e) => update((s) => void (s.tax.rate_percent = Number(e.target.value)))} />
        </div>
        <Checkbox label="El envío también causa impuesto" checked={draft.tax.delivery_fee_taxable} onChange={(v) => update((s) => void (s.tax.delivery_fee_taxable = v))} />
        <div className="title-s">Descuentos</div>
        <Select
          label="Cuando se combinan varios descuentos"
          value={draft.pricing.discount_stacking}
          onChange={(e) => update((s) => void (s.pricing.discount_stacking = e.target.value as "parallel" | "sequential"))}
          options={[
            { value: "parallel", label: "Cada uno sobre el precio original (20% + 10% = 30%)" },
            { value: "sequential", label: "Uno sobre otro (20% y luego 10% = 28%)" },
          ]}
        />
        <Select
          label="El envío gratis se evalúa"
          value={feeBeforeDiscounts ? "before" : "after"}
          onChange={(e) =>
            update(
              (s) =>
                void (s.pricing.stages =
                  e.target.value === "before" ? ["volume", "delivery_fee", "discounts", "membership", "credits", "tax"] : DEFAULT_STAGES),
            )
          }
          options={[
            { value: "after", label: "Con el subtotal ya descontado" },
            { value: "before", label: "Con el subtotal antes de descuentos" },
          ]}
        />
        <SaveBar onSave={save} saving={saving} />
      </div>
    </Card>
  );
}

interface IntegrationRow {
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

function useIntegrations() {
  const { tenantId } = useTenant();
  return useQuery({
    queryKey: ["integrations", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenant_integrations").select("provider, enabled, config").eq("tenant_id", tenantId);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r) => [r.provider, r as IntegrationRow])) as Record<string, IntegrationRow | undefined>;
    },
  });
}

function PaymentsSettings({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const { tenantId } = useTenant();
  const integrations = useIntegrations();
  const qc = useQueryClient();
  const toast = useToast();
  const mp = integrations.data?.mercadopago;
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [descriptor, setDescriptor] = useState("");
  const [savingMp, setSavingMp] = useState(false);
  useEffect(() => {
    setEnabled(mp?.enabled ?? false);
    setDescriptor(String(mp?.config.statement_descriptor ?? ""));
  }, [mp]);
  const webhook = `${window.location.origin}/api/webhooks/mercadopago?tenant=${tenantId}`;
  const saveMp = async () => {
    setSavingMp(true);
    try {
      await api("/api/integrations/save", {
        tenant_id: tenantId,
        provider: "mercadopago",
        enabled,
        secrets: { access_token: token || undefined, webhook_secret: secret || undefined },
        config: { statement_descriptor: descriptor || null },
      });
      setToken("");
      setSecret("");
      qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.show("MercadoPago guardado");
    } catch (err) {
      toast.show(errorMessage(err), { error: true });
    } finally {
      setSavingMp(false);
    }
  };
  return (
    <div className="col gap-16">
      <Card title="Métodos de pago">
        <div className="col gap-8">
          {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => (
            <Checkbox
              key={m}
              label={PAYMENT_METHOD_LABEL[m]}
              checked={draft.payments.methods.includes(m)}
              onChange={(v) => update((s) => void (s.payments.methods = v ? [...s.payments.methods, m] : s.payments.methods.filter((x) => x !== m)))}
            />
          ))}
          <Checkbox label="Permitir cobrar más que el saldo (propinas, anticipos)" checked={draft.payments.allow_overpayment} onChange={(v) => update((s) => void (s.payments.allow_overpayment = v))} />
          <SaveBar onSave={save} saving={saving} />
        </div>
      </Card>
      <Card
        title={
          <div className="row">
            <h3>MercadoPago</h3>
            {mp?.enabled ? <Badge tone="success">Activo</Badge> : <Badge>Inactivo</Badge>}
            {mp?.config.test_mode ? <Badge tone="warning">Modo prueba</Badge> : null}
          </div>
        }
      >
        <div className="col gap-16">
          {mp?.config.account ? <p className="body-m" style={{ margin: 0 }}>Cuenta: {String(mp.config.account)} · Token {String(mp.config.access_token_hint ?? "")}</p> : null}
          <TextField label="Access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={mp?.config.access_token_hint ? "Deja vacío para conservar el actual" : "APP_USR-…"} hint="MercadoPago → Tus integraciones → Credenciales de producción" />
          <TextField label="Clave secreta del webhook (recomendado)" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={mp?.config.webhook_secret_set ? "Configurada" : ""} />
          <TextField label="Descriptor en estado de cuenta" value={descriptor} onChange={(e) => setDescriptor(e.target.value)} maxLength={22} />
          <div className="field">
            <label>URL de notificaciones (webhook)</label>
            <div className="row">
              <input className="input sm" readOnly value={webhook} onFocus={(e) => e.target.select()} />
              <IconButton icon="content_copy" label="Copiar" onClick={() => navigator.clipboard?.writeText(webhook).then(() => toast.show("Copiado"))} />
            </div>
            <span className="hint">Regístrala en MercadoPago → Webhooks, evento “Pagos”.</span>
          </div>
          <Checkbox label="Aceptar pagos en línea (links de pago y botón en el seguimiento)" checked={enabled} onChange={setEnabled} />
          <div className="row end">
            <Button onClick={saveMp} loading={savingMp}>
              Guardar MercadoPago
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function NotificationSettings({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const { tenantId } = useTenant();
  const integrations = useIntegrations();
  const toast = useToast();
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: ["templates", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from("notification_templates").select("*").eq("tenant_id", tenantId);
      if (error) throw error;
      return data as TemplateRow[];
    },
  });
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const resend = integrations.data?.resend;
  const [apiKey, setApiKey] = useState("");
  const [from, setFrom] = useState("");
  const saveResend = async () => {
    try {
      await api("/api/integrations/save", { tenant_id: tenantId, provider: "resend", enabled: true, secrets: { api_key: apiKey || undefined, from: from || undefined } });
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.show("Correo configurado");
    } catch (err) {
      toast.show(errorMessage(err), { error: true });
    }
  };
  const byEvent = (e: NotificationEvent) => (templates.data ?? []).filter((t) => t.event === e).sort((a, b) => a.channel.localeCompare(b.channel));
  return (
    <div className="col gap-16">
      <Card title="Canales">
        <div className="col gap-8">
          <Checkbox label="Correo electrónico" checked={draft.notifications.email_enabled} onChange={(v) => update((s) => void (s.notifications.email_enabled = v))} />
          <Checkbox label="WhatsApp (envío con un toque desde la orden)" checked={draft.notifications.whatsapp_enabled} onChange={(v) => update((s) => void (s.notifications.whatsapp_enabled = v))} />
          <TextField label="Responder a" type="email" value={draft.notifications.reply_to ?? ""} onChange={(e) => update((s) => void (s.notifications.reply_to = e.target.value || null))} />
          <SaveBar onSave={save} saving={saving} />
        </div>
      </Card>
      <Card title="Remitente de correo (opcional)">
        <div className="col gap-12">
          <p className="body-m muted" style={{ margin: 0 }}>
            Por defecto se usa el remitente de la plataforma. Para enviar desde tu dominio, agrega tu API key de Resend.
            {resend?.config.from ? ` Actual: ${String(resend.config.from)}` : ""}
          </p>
          <div className="grid cols-2">
            <TextField label="API key de Resend" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={resend?.config.api_key_hint ? String(resend.config.api_key_hint) : "re_…"} />
            <TextField label="Remitente" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Mi Lavandería <avisos@midominio.com>" />
          </div>
          <div className="row end">
            <Button variant="tonal" onClick={saveResend} disabled={!apiKey && !from}>
              Guardar remitente
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Plantillas" variant="flush">
        {templates.isLoading ? (
          <Loading />
        ) : (
          <div className="list">
            {NOTIFICATION_EVENTS.map((e) => (
              <div key={e} className="list-item" style={{ flexWrap: "wrap" }}>
                <div className="grow">
                  <div className="headline">{NOTIFICATION_EVENT_LABEL[e]}</div>
                </div>
                {byEvent(e).map((t) => (
                  <button key={t.id} className="chip" onClick={() => setEditing(t)} style={t.enabled ? undefined : { opacity: 0.5 }}>
                    <Icon name={t.channel === "email" ? "mail" : "chat"} />
                    {t.channel === "email" ? "Correo" : "WhatsApp"} · {t.enabled ? (t.mode === "auto" ? "automático" : "manual") : "apagado"}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && (
        <TemplateDialog
          template={editing}
          onClose={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["templates"] });
          }}
        />
      )}
    </div>
  );
}

function TemplateDialog({ template, onClose }: { template: TemplateRow; onClose: () => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body);
  const [enabled, setEnabled] = useState(template.enabled);
  const [mode, setMode] = useState(template.mode);
  const save = async () => {
    const { error } = await supabase.from("notification_templates").update({ subject: subject || null, body, enabled, mode }).eq("id", template.id);
    if (error) return toast.show(errorMessage(error), { error: true });
    toast.show("Plantilla guardada");
    onClose();
  };
  return (
    <Dialog
      open
      wide
      title={`${NOTIFICATION_EVENT_LABEL[template.event as NotificationEvent]} · ${template.channel === "email" ? "Correo" : "WhatsApp"}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save}>Guardar</Button>
        </>
      }
    >
      <div className="col gap-16">
        {template.channel === "email" && <TextField label="Asunto" value={subject} onChange={(e) => setSubject(e.target.value)} />}
        <TextArea label="Mensaje" value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
        <p className="body-s muted" style={{ margin: 0 }}>
          Variables: {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(" ")}
        </p>
        <Checkbox label="Activa" checked={enabled} onChange={setEnabled} />
        <Select
          label="Envío"
          value={mode}
          onChange={(e) => setMode(e.target.value as "auto" | "manual")}
          options={[
            { value: "auto", label: "Automático" },
            { value: "manual", label: "Manual (queda en la orden para enviarse con un toque)" },
          ]}
        />
        {template.channel !== "email" && mode === "auto" && (
          <Banner tone="warning">El envío automático por WhatsApp requiere conectar un proveedor; mientras tanto se quedará pendiente para envío manual.</Banner>
        )}
      </div>
    </Dialog>
  );
}

function ReceiptSettingsPanel({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const { can } = useTenant();
  const [width, setWidth] = useState<PaperWidth>(printerPrefs().width);
  const r = draft.receipts;
  const set = <K extends keyof typeof r>(k: K, v: (typeof r)[K]) => update((s) => void (s.receipts[k] = v));
  const sample = sampleReceipt(row, draft);
  return (
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <div className="col gap-16">
        <PrinterCard sample={sample} onWidth={setWidth} />
        {can("settings.manage") && (
          <Card title="Contenido del ticket">
            <div className="col gap-16">
              <TextArea label="Encabezado (opcional)" value={r.header} onChange={(e) => set("header", e.target.value)} rows={2} hint="Debajo del nombre y los datos del negocio (Negocio). Ej. horario o sitio web." />
              <TextArea label="Pie" value={r.footer} onChange={(e) => set("footer", e.target.value)} rows={2} />
              <Checkbox label="Link de seguimiento" checked={r.tracking_link} onChange={(v) => set("tracking_link", v)} />
              <Checkbox label="Código QR de seguimiento (si tu impresora lo soporta)" checked={r.tracking_qr} onChange={(v) => set("tracking_qr", v)} />
              <Checkbox label="Puntos de lealtad del cliente" checked={r.show_loyalty} onChange={(v) => set("show_loyalty", v)} />
              <Checkbox label="Espacio en blanco arriba para anotar a mano" checked={r.annotation_space} onChange={(v) => set("annotation_space", v)} />
              <p className="body-s muted" style={{ margin: 0 }}>
                Los acentos se imprimen sin tilde para que funcionen en cualquier impresora térmica.
              </p>
              <SaveBar saving={saving} onSave={save} />
            </div>
          </Card>
        )}
      </div>
      <Card title="Vista previa">
        <div className="receipt-paper">
          <ReceiptPreview doc={sample} width={width} />
        </div>
      </Card>
    </div>
  );
}

function LoyaltySettingsPanel({ row }: { row: TenantRow }) {
  const { draft, update, save, saving } = useSettingsDraft(row);
  const l = draft.loyalty;
  const set = <K extends keyof typeof l>(k: K, v: (typeof l)[K]) => update((s) => void (s.loyalty[k] = v));
  return (
    <Card>
      <div className="col gap-16">
        <Checkbox label="Activar programa de lealtad" checked={l.enabled} onChange={(v) => set("enabled", v)} />
        <p className="body-m muted" style={{ margin: 0 }}>
          Los puntos se acreditan cuando la orden se entrega y está pagada por completo. Se canjean como descuento en órdenes nuevas (no
          cubren el envío). Si se cancela una orden, se devuelven los puntos usados y se retiran los ganados.
        </p>
        {l.enabled && (
          <>
            <div className="title-s">Cómo se ganan</div>
            <Segmented
              value={l.earn_mode}
              onChange={(v) => set("earn_mode", v)}
              options={[
                { value: "amount", label: "Por monto gastado" },
                { value: "orders", label: "Por orden" },
              ]}
            />
            {l.earn_mode === "amount" ? (
              <div className="grid cols-2">
                <TextField label="Puntos" type="number" min="1" value={l.points_per_step} onChange={(e) => set("points_per_step", Math.max(0, Number(e.target.value)))} />
                <TextField
                  label="Por cada (monto)"
                  inputMode="decimal"
                  value={centsToInput(l.step_cents)}
                  onChange={(e) => set("step_cents", inputToCents(e.target.value) ?? 0)}
                />
              </div>
            ) : (
              <TextField label="Puntos por orden" type="number" min="1" value={l.points_per_order} onChange={(e) => set("points_per_order", Math.max(0, Number(e.target.value)))} />
            )}
            <TextField
              label="Orden mínima para ganar puntos (opcional)"
              inputMode="decimal"
              value={centsToInput(l.min_order_cents)}
              onChange={(e) => set("min_order_cents", inputToCents(e.target.value))}
            />
            <div className="title-s">Cómo se usan</div>
            <div className="grid cols-2">
              <TextField
                label="Valor de cada punto"
                inputMode="decimal"
                value={centsToInput(l.point_value_cents)}
                onChange={(e) => set("point_value_cents", inputToCents(e.target.value) ?? 0)}
              />
              <TextField
                label="Mínimo de puntos para canjear"
                type="number"
                min="0"
                value={l.min_redeem_points}
                onChange={(e) => set("min_redeem_points", Math.max(0, Number(e.target.value)))}
              />
            </div>
            <Banner icon="loyalty">
              {describeLoyalty(l, money)}
              {l.point_value_cents > 0 && l.earn_mode === "amount" && l.step_cents > 0 && l.points_per_step > 0 && (
                <> Equivale a devolver {((l.points_per_step * l.point_value_cents * 100) / l.step_cents).toFixed(1)}% de lo gastado.</>
              )}
            </Banner>
          </>
        )}
        <SaveBar onSave={save} saving={saving} />
      </div>
    </Card>
  );
}
