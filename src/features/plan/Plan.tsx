import { planInfo, TRIAL_WARNING_DAYS } from "../../domain/plan";
import { dateOnly } from "../../lib/format";
import { useTenant } from "../../lib/session";
import type { Permission } from "../../domain/permissions";
import { Badge, Banner, Button, Card, Empty } from "../../ui/components";

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
