import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "../../app/Shell";
import { dateTime } from "../../lib/format";
import { useMemberNames } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { supabase } from "../../lib/supabase";
import type { AuditRow } from "../../lib/types";
import { Badge, Card, Chip, Empty, Loading } from "../../ui/components";

const ENTITY_LABEL: Record<string, string> = {
  orders: "Orden",
  order_production_steps: "Producción",
  deliveries: "Entrega",
  routes: "Ruta",
  payments: "Pago",
  payment_links: "Link de pago",
  customers: "Cliente",
  customer_addresses: "Dirección",
  products: "Servicio",
  product_categories: "Categoría",
  pricing_rules: "Precio por volumen",
  discounts: "Descuento",
  delivery_zones: "Zona",
  workflows: "Flujo",
  workflow_steps: "Fase",
  quality_issues: "Incidencia",
  roles: "Rol",
  role_permissions: "Permiso",
  tenant_members: "Equipo",
  tenant_invitations: "Invitación",
  tenants: "Negocio",
  notification_templates: "Plantilla",
  tenant_integrations: "Integración",
};

const ACTION_LABEL: Record<string, string> = { insert: "creó", update: "modificó", delete: "eliminó" };

const summarize = (v: Record<string, unknown> | null) =>
  v
    ? Object.entries(v)
        .filter(([k]) => !["id", "tenant_id", "created_at"].includes(k))
        .slice(0, 6)
        .map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`)
        .join(" · ")
    : "";

export function AuditPage() {
  const { tenantId } = useTenant();
  const name = useMemberNames();
  const [entity, setEntity] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["audit", tenantId, entity],
    queryFn: async () => {
      let query = supabase.from("audit_log").select("*").eq("tenant_id", tenantId).order("occurred_at", { ascending: false }).limit(300);
      if (entity) query = query.eq("entity_type", entity);
      const { data, error } = await query;
      if (error) throw error;
      return data as AuditRow[];
    },
  });
  return (
    <Page title="Bitácora">
      <div className="col gap-16">
        <div className="chips">
          <Chip on={!entity} onClick={() => setEntity(null)}>
            Todo
          </Chip>
          {["orders", "payments", "deliveries", "order_production_steps", "customers", "products", "discounts", "tenant_members", "roles", "tenants"].map((e) => (
            <Chip key={e} on={entity === e} onClick={() => setEntity(e)}>
              {ENTITY_LABEL[e]}
            </Chip>
          ))}
        </div>
        <Card variant="flush">
          {q.isLoading ? (
            <Loading />
          ) : !q.data?.length ? (
            <Empty icon="history" title="Sin movimientos" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Cuándo</th>
                    <th>Quién</th>
                    <th>Qué</th>
                    <th>Antes</th>
                    <th>Después</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{dateTime(r.occurred_at)}</td>
                      <td className="nowrap">{r.actor_type === "user" ? name(r.actor_id) : <Badge>{r.actor_type}</Badge>}</td>
                      <td>
                        {ACTION_LABEL[r.action] ?? r.action} {ENTITY_LABEL[r.entity_type] ?? r.entity_type}
                        {r.order_id && (
                          <>
                            {" · "}
                            <Link to={`/orders/${r.order_id}`}>ver orden</Link>
                          </>
                        )}
                        {r.context?.note && <div className="body-s muted">{r.context.note}</div>}
                      </td>
                      <td className="body-s muted" style={{ maxWidth: 280 }}>{summarize(r.before)}</td>
                      <td className="body-s" style={{ maxWidth: 320 }}>{summarize(r.after)}</td>
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
