# Arquitectura

Dark Laundry OS es un SaaS multi-tenant. Una lavandería es un tenant. Esta página explica dónde vive cada regla y cómo extender el sistema sin romper el core.

## Capas

```
Navegador (React + Vite)
  ├─ lee con la anon key + la sesión del usuario → PostgREST (RLS filtra por tenant y permiso)
  ├─ ejecuta acciones de negocio → funciones SQL (RPC) SECURITY DEFINER
  └─ llama /api/* (Vercel) para lo que necesita secretos o el motor de precios en servidor

/api (Vercel Functions, Node)
  ├─ verifica la sesión (Supabase Auth) y la membresía/permiso del usuario
  ├─ usa la service_role key → funciones svc_* que vuelven a validar permisos
  └─ habla con proveedores externos (MercadoPago, Resend)

Postgres (Supabase)
  ├─ RLS en todas las tablas; anon no tiene acceso a ninguna
  ├─ funciones de negocio con validación, locks y auditoría en la misma transacción
  └─ audit_log escrito por triggers
```

## Dónde vive cada regla (una sola fuente de verdad)

| Dominio | Fuente de verdad | Copias verificadas |
|---|---|---|
| Precio de una orden | `src/domain/pricing/engine.ts` (TS puro). El servidor lo corre en `/api/orders/save` y guarda el desglose. | El navegador corre el mismo archivo para la cotización en vivo. |
| Estado de pago | `app.recompute_order_payment` (SQL), derivado del libro de pagos | `src/domain/payments.ts` para vistas previas (mismos casos de prueba) |
| Transiciones de orden | tabla `app.order_transitions` + `app.transition_order` | `src/domain/orders.ts` (test de paridad) |
| Permisos | tabla `permissions` + `app.has_permission` | `src/domain/permissions.ts` (test de paridad) |
| Reglas de producción (tomar, completar, reasignar) | `assign_production_step`, `complete_production_step` | `src/domain/production.ts` solo decide qué botones mostrar |
| Teléfonos | `app.normalize_phone` (trigger al guardar clientes) | `src/domain/phone.ts` para búsqueda (mismos casos) |
| Render de notificaciones | `src/domain/notifications.ts` (servidor y navegador) | — |

El desglose que ve el cliente es el mismo JSON (`orders.pricing`) que produjo el total cobrado. La base rechaza un desglose que no cuadra (`inconsistent pricing`).

## Modelo de datos

- **Tenancy:** `tenants`, `tenant_members` (usuario ↔ tenant ↔ rol), `tenant_invitations`.
- **RBAC:** `permissions` (catálogo fijo), `roles` y `role_permissions` por tenant. El rol dueño (`is_owner`) tiene todos los permisos, incluidos los futuros.
- **Catálogo y precios:** `product_categories`, `products`, `pricing_rules` (volumen: paquetes y escalones), `discounts`, `delivery_zones`.
- **Clientes:** `customers` (teléfono normalizado y único por tenant), `customer_addresses`, vista `customer_overview` (Customer 360 y estado configurable).
- **Órdenes:** `orders` (estado general + totales + `pricing`), `order_items` (precio congelado), `order_discounts`.
- **Producción:** `workflows` y `workflow_steps` (configurables); `order_production_steps` (copia por orden, con `assigned_to` ≠ `completed_by`); `quality_issues`.
- **Entregas:** `routes` y `deliveries` (cada delivery es una parada de ruta: pickup o delivery, con `stop_position`).
- **Pagos:** `payments` (libro con llave de idempotencia; los reembolsos son asientos), `payment_links`, `webhook_events`, `tenant_integrations` y `tenant_secrets` (este último solo lo lee el servidor).
- **Notificaciones:** `notification_templates` (auto/manual por evento y canal), `notifications` (cola con `dedupe_key`).
- **Auditoría:** `audit_log` (actor, acción, entidad, antes/después, contexto), solo lectura.

Todas las tablas hijas usan llaves foráneas compuestas `(tenant_id, id)`, así que es imposible, por ejemplo, que una orden del tenant A apunte a un cliente del tenant B.

## Seguridad

- **RLS en todo:** lectura por membresía y permiso; `anon` solo puede ejecutar `get_public_order(token)` y `get_invitation(token)`.
- **Escrituras con reglas solo por funciones:** el cliente no tiene `insert`/`update` sobre órdenes, pagos, entregas, pasos de producción ni equipo.
- **Configuración escribible solo en ciertas columnas:** catálogo, clientes y ajustes se escriben directo, con grants por columna (nunca `tenant_id`, `plan`, etc.).
- **Membresías solo por RPC** (`create_tenant`, `accept_invitation`, `update_member`). Un usuario no puede darse un rol ni meterse a otro tenant. Siempre queda al menos un dueño activo.
- **Idempotencia:**
  - Pagos manuales: `idempotency_key`.
  - Pagos de proveedor: `(provider, provider_payment_id)`.
  - Webhooks: `webhook_events`.
  - Notificaciones: `dedupe_key` y claim atómico.
  - Cron: operaciones idempotentes.
- **Secretos:** las credenciales de proveedores de cada tenant viven en `tenant_secrets`, que no tiene grants para el cliente. Las llaves de plataforma van en variables de entorno del servidor.
- **Seguimiento del cliente:** token aleatorio de 192 bits por orden; nunca se autentica solo con el teléfono.
- **Evidencias:** bucket privado `evidence/<tenant_id>/…` con URLs firmadas.

Los tests en `supabase/tests/` cubren:

- aislamiento entre tenants;
- intentos de escalada de privilegios;
- el flujo operativo completo.

## Cómo extender

- **Un permiso nuevo:** agrégalo al `insert into public.permissions` en una migración nueva y a `src/domain/permissions.ts`. El test de paridad falla si falta uno de los dos.
- **Un proveedor de pagos:** implementa `PaymentProvider` en `api/_lib/providers/` y regístralo en `PROVIDERS`. El libro de pagos y las órdenes no cambian.
- **Un canal de notificación** (WhatsApp Business API, SMS): implementa `NotificationProvider` y agrégalo en `tenantNotificationProviders`. Las plantillas en modo "auto" de ese canal empezarán a enviarse solas.
- **Membresías, créditos y lealtad (V1):** el motor de precios ya tiene las etapas `membership` y `credits` en su pipeline, hoy vacías. Implementa la etapa y alimenta el contexto; el orden de etapas es configurable por tenant.
- **Módulos de inteligencia (capacidad, forecasting, Copilot):** leen de las mismas tablas. Los datos para capacidad ya se registran: duración estimada por fase, `started_at`/`completed_at` por paso y responsable/ejecutor.

## Qué se dejó fuera a propósito

Se dejaron fuera, por diseño:

- puntos, rankings y penalizaciones de empleados;
- membresías específicas de un negocio;
- zonas o reglas de CDMX;
- Uber Direct;
- optimización avanzada de rutas.

Todo esto entra después como configuración o módulo, sin tocar el core. Ver `docs/analisis-laundry-os.md`.
