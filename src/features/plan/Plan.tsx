import { useState } from "react";
import { OPERATION_LABEL, OPERATION_MODELS, type OperationModel } from "../../domain/operation";
import { planInfo, TRIAL_WARNING_DAYS } from "../../domain/plan";
import { errorMessage } from "../../lib/errors";
import { rpc } from "../../lib/queries";
import { dateOnly } from "../../lib/format";
import { useTenant } from "../../lib/session";
import type { Permission } from "../../domain/permissions";
import { Badge, Banner, Button, Card, Empty, Icon, useToast } from "../../ui/components";

const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined) || null;

const contact = SUPPORT_EMAIL ? (
  <>
    {" "}
    Escríbenos a <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
  </>
) : (
  " Contáctanos para continuar."
);

const days = (n: number) => (n === 0 ? "hoy" : n === 1 ? "mañana" : `en ${n} días`);

/** Trial ending / read-only notice at the top of every page. */
export function PlanNotice() {
  const { tenant, can } = useTenant();
  if (!tenant) return null;
  const info = planInfo(tenant);
  const admin = can("settings.manage");
  if (info.readOnly) {
    return (
      <Banner tone="warning" icon="lock">
        <strong>{info.kind === "suspended" ? "Suscripción suspendida" : "Tu prueba gratis terminó"}: modo solo lectura.</strong> Puedes consultar y exportar
        tu información, pero no crear ni modificar órdenes, clientes o pagos.{admin && contact}
      </Banner>
    );
  }
  if (info.kind === "trial" && admin && info.daysLeft !== null && info.daysLeft <= TRIAL_WARNING_DAYS) {
    return (
      <Banner icon="hourglass_bottom">
        Tu prueba gratis termina {days(info.daysLeft)} ({dateOnly(tenant.trial_ends_at)}). Después la app quedará en modo solo lectura.{contact}
      </Banner>
    );
  }
  return null;
}

/** Settings → Plan. */
export function PlanCard() {
  const { tenant } = useTenant();
  if (!tenant) return null;
  const info = planInfo(tenant);
  return (
    <Card>
      <div className="col gap-16">
        <div className="row between wrap gap-8">
          <div className="col" style={{ gap: 2 }}>
            <span className="body-s muted">Tu plan</span>
            <span className="title-l">{info.kind === "active" ? "Plan activo" : "Prueba gratis"}</span>
          </div>
          {info.kind === "trial" && <Badge tone="success">Todas las funciones</Badge>}
          {info.kind === "trial_over" && <Badge tone="warning">Terminó · solo lectura</Badge>}
          {info.kind === "suspended" && <Badge tone="error">Suspendida · solo lectura</Badge>}
        </div>
        {(info.kind === "trial" || info.kind === "trial_over") && (
          <>
            <div className="col gap-8">
              <div className="progress" style={{ height: 8, borderRadius: 4 }}>
                <span style={{ width: `${Math.round((info.progress ?? 0) * 100)}%`, background: info.kind === "trial_over" ? "var(--coral)" : undefined }} />
              </div>
              <div className="row between wrap body-s muted">
                <span>Inició {dateOnly(tenant.created_at)}</span>
                <span>Termina {dateOnly(tenant.trial_ends_at)}</span>
              </div>
            </div>
            <div className="title-m">
              {info.kind === "trial" ? (info.daysLeft === 0 ? "Último día de prueba" : `Te quedan ${info.daysLeft} días`) : "Tu prueba terminó"}
            </div>
          </>
        )}
        <p className="body-m muted" style={{ margin: 0 }}>
          {info.kind === "active"
            ? "Tienes acceso a todas las funciones."
            : "Durante la prueba tienes todas las funciones: órdenes, producción, entregas, pagos en línea, lealtad, tickets, análisis e importación de clientes. Al terminar, la app queda en modo solo lectura: tu información se conserva y puedes consultarla y exportarla."}
          {info.readOnly && contact}
        </p>
      </div>
    </Card>
  );
}

/** The role allows it, but the business is read-only (trial over). */
export function useBlockedByPlan(...perms: Permission[]): boolean {
  const { tenant } = useTenant();
  return tenant?.access === "read_only" && perms.some((p) => tenant.permissions.includes(p));
}

export function ReadOnlyPage({ onHome }: { onHome: () => void }) {
  const { can } = useTenant();
  return (
    <div className="center-page">
      <Empty icon="lock" title="Modo solo lectura">
        <span style={{ maxWidth: 360 }}>
          La prueba gratis de este negocio terminó. Puedes consultar la información, pero no crear ni modificar.{can("settings.manage") && contact}
        </span>
        <Button onClick={onHome}>Ir al inicio</Button>
      </Empty>
    </div>
  );
}

/** Counter only / home delivery / hybrid, as selectable cards. */
export function OperationPicker({ value, onChange, disabled }: { value: OperationModel; onChange: (v: OperationModel) => void; disabled?: boolean }) {
  return (
    <div className="op-picker" role="radiogroup" aria-label="Tipo de operación">
      {OPERATION_MODELS.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          className={`op-option${value === m.value ? " on" : ""}`}
          disabled={disabled}
          onClick={() => onChange(m.value)}
        >
          <span className="op-icon">
            <Icon name={m.icon} />
          </span>
          <span className="col" style={{ gap: 2, textAlign: "left" }}>
            <span className="title-s">{m.label}</span>
            <span className="body-s muted">{m.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Settings → Plan: the operation model (free during the trial, from the plan afterwards). */
export function OperationCard() {
  const { tenant, tenantId, can, refresh } = useTenant();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  if (!tenant) return null;
  const editable = can("settings.manage") && (tenant.plan === "trial" || tenant.plan === "internal") && tenant.access === "full";
  const change = async (m: OperationModel) => {
    if (m === tenant.operation_model) return;
    setSaving(true);
    try {
      await rpc("set_operation_model", { p_tenant: tenantId, p_model: m });
      await refresh();
      toast.show(`Ahora tu lavandería es: ${OPERATION_LABEL[m]}`);
    } catch (err) {
      toast.show(errorMessage(err), { error: true });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Tipo de operación">
      <div className="col gap-16">
        <p className="body-m muted" style={{ margin: 0 }}>
          Define qué funciones usa tu lavandería: con <b>solo mostrador</b> no aparecen recolecciones, entregas, rutas ni couriers; con <b>todo a
          domicilio</b> cada orden lleva recolección y entrega. Cada tipo tiene su propio plan y precio.
        </p>
        <OperationPicker value={tenant.operation_model} onChange={change} disabled={!editable || saving} />
        <span className="body-s muted">
          {editable
            ? "Durante la prueba gratis puedes cambiarlo cuando quieras."
            : tenant.plan === "trial" || tenant.plan === "internal"
              ? "Solo el dueño o un administrador puede cambiarlo."
              : "Depende de tu plan: para cambiarlo hay que cambiar de plan."}
        </span>
      </div>
    </Card>
  );
}
