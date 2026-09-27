// Permission catalog. The database seeds the same codes (migration
// 0002_rbac.sql); a unit test fails if the two lists drift apart.
// Roles are data (per tenant); only permissions are code, because each one
// guards a piece of code.

export const PERMISSIONS = {
  "dashboard.view": "Ver dashboard",
  "orders.view": "Ver órdenes",
  "orders.create": "Crear órdenes",
  "orders.edit": "Editar órdenes y cambiar estado",
  "orders.cancel": "Cancelar órdenes",
  "orders.price_override": "Precios manuales y envío sin costo",
  "customers.view": "Ver clientes",
  "customers.edit": "Crear y editar clientes",
  "production.view": "Ver producción",
  "production.work": "Trabajar fases de producción",
  "production.manage": "Asignar y reasignar producción",
  "quality.report": "Reportar incidencias",
  "quality.manage": "Resolver incidencias",
  "delivery.view": "Ver entregas y rutas",
  "delivery.manage": "Planear rutas y asignar couriers",
  "delivery.execute": "Ejecutar rutas (courier)",
  "payments.view": "Ver pagos",
  "payments.record": "Registrar pagos",
  "payments.refund": "Reembolsar pagos",
  "catalog.manage": "Administrar catálogo",
  "pricing.manage": "Administrar precios, descuentos y zonas",
  "loyalty.manage": "Ajustar puntos de lealtad",
  "team.manage": "Administrar equipo y roles",
  "settings.manage": "Administrar configuración",
  "notifications.send": "Enviar notificaciones manuales",
  "audit.view": "Ver bitácora",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_CODES = Object.keys(PERMISSIONS) as Permission[];

export const PERMISSION_GROUPS: { label: string; prefix: string }[] = [
  { label: "Dashboard", prefix: "dashboard." },
  { label: "Órdenes", prefix: "orders." },
  { label: "Clientes", prefix: "customers." },
  { label: "Producción", prefix: "production." },
  { label: "Calidad", prefix: "quality." },
  { label: "Entregas", prefix: "delivery." },
  { label: "Pagos", prefix: "payments." },
  { label: "Catálogo y precios", prefix: "catalog." },
  { label: "Catálogo y precios", prefix: "pricing." },
  { label: "Catálogo y precios", prefix: "loyalty." },
  { label: "Administración", prefix: "team." },
  { label: "Administración", prefix: "settings." },
  { label: "Administración", prefix: "notifications." },
  { label: "Administración", prefix: "audit." },
];
