# Análisis de laundry-os (La Laundry / The Clean Club)

Revisión del sistema actual en producción (`TTCMX/laundry-os`) como referencia
para Dark Laundry OS. El objetivo no es portarlo: es extraer las reglas de
negocio reales, las lecciones que ya costaron caro y los errores que no hay
que repetir.

## 1. Qué es hoy

| Aspecto | Estado actual |
|---|---|
| Stack | React 19 + Vite (JS, sin TypeScript), Supabase, Vercel functions, MercadoPago, Resend, Google Maps, Leaflet |
| Tenancy | Single-tenant. Nombre, dominio, remitente y planes de The Clean Club en código |
| Auth | Sin Supabase Auth. Login de empleados contra la tabla `empleados`; sesión en `localStorage` |
| Acceso a datos | El navegador habla directo con Postgres con la anon key (sin RLS efectiva) |
| Tamaño | ~12.8k líneas; `App.jsx` (3.8k) y `Admin.jsx` (2.7k) concentran casi toda la UI |
| Rutas | `/` operación, `/admin` back office, `/courier`, `/miorden` (cliente) |
| Tablas | `pedidos`, `clientes`, `empleados`, `skus`, `categorias`, `descuentos`, `configuracion`, `log_movimientos`, `fallas_calidad`, `driver_locations` |
| Tests | `precios` (107), `fases` (30), `desempeno`: pasan |
| Schema | Las migraciones solo cubren cambios incrementales; el schema base no está versionado |

## 2. Problemas de seguridad (acción inmediata en producción)

Estos afectan a la app que hoy está en producción, independientemente de
Dark Laundry OS.

1. **Contraseñas de empleados en texto plano y legibles por cualquiera.**
   El login hace `select ... password_hash from empleados` con la anon key y
   compara en el navegador (`password !== data.password_hash`). La columna
   contiene la contraseña tal cual, y como la anon key es pública, cualquiera
   puede leer la tabla completa.
2. **Toda la base es legible/escribible desde el navegador.** Sin Auth no hay
   RLS que pueda distinguir a un empleado de un visitante: clientes,
   teléfonos, direcciones, pedidos y pagos son accesibles con la anon key.
   Los controles de rol (`rol === "admin"`) solo existen en el frontend.
3. **Tracking del cliente autenticado solo por teléfono.** `/miorden` entra
   con el número; quien conozca el teléfono de alguien ve sus pedidos y
   dirección.
4. **Fotos en bucket público** (`fotos-pedidos` + `getPublicUrl`): evidencia
   de entregas y prendas accesible por URL.
5. **Secretos en el repo/zip.** El `.env` no está en `.gitignore` y el zip
   incluye `.env` con la key de Resend (prefijo `VITE_`, lo que la mandaría al
   bundle si se referencia). Además `clientes_laundry.json` y
   `pedidos_laundry.json` contienen datos personales reales (~370 clientes).
   Recomendación: rotar la key de Resend, sacar esos archivos del repo e
   historial, añadir `.env` a `.gitignore`.
6. **`/api/mp-reconciliar` recibe el secreto por query string** (queda en
   logs). `cronNoAutorizado` no exige nada si `CRON_SECRET` no está
   configurado.
7. **Pago marcado sin atomicidad.** `marcarPedidoPagado` lee → verifica
   `pagado` → escribe. Dos webhooks simultáneos pueden sumar el LTV dos veces.
   Tampoco valida que el monto aprobado en MercadoPago coincida con el saldo.

## 3. Lo que sí vale la pena llevarse (patrones y lecciones)

Buenas decisiones, casi todas documentadas en comentarios después de un bug
real:

- **Pricing como única fuente de verdad** (`lib/precios.js`): importable desde
  front y server; el monto del link de pago se recalcula en servidor, nunca
  viene del cliente. Mantener exactamente este principio.
- **Orden de descuentos**: descuentos normales primero, membresía al final
  sobre el remanente (15% sobre 20% = 32%, no 35%). Transporte/fees nunca
  descontables. Reparto proporcional de descuentos por línea con el residuo
  de redondeo al último para que las partes sumen exacto.
- **Precio por volumen que nunca encarece** (`min(lista, volumen)`), solo para
  cantidades enteras.
- **Promos tipo "precio" vs tipo "tasa"**: las de tasa compiten con la del
  nivel (gana la mayor), no se suman.
- **Assigned vs completed by**: `courier_id` vs `recogido_por`/`entregado_por`
  y `asignado_*` vs `*_por` por fase, con timestamp de cierre por fase.
- **Reglas de asignación** (`puedeAvanzar`): fase libre → se puede tomar;
  ajena → no; admin destraba. Coincide con el spec.
- **Incidencias no inferidas de retrocesos**: regresar una orden a tiempo es
  lo correcto y no debe castigar a quien lo detectó.
- **Teléfono normalizado** (últimos 10 dígitos) y rellenar huecos del cliente
  sin sobrescribir datos existentes.
- **Webhooks verifican contra la API del proveedor** antes de actuar; nunca
  confían en el payload.
- **Membresía vigente = una sola regla por fecha** (`vigente_hasta >= hoy`),
  el estado crudo del proveedor solo se muestra.
- **Idempotencia de tareas periódicas** con marca de última ejecución.
- **Fechas locales, no UTC** (bugs reales de membresías "expiradas" un día
  antes).
- **Paginación contra el tope de 1000 filas de PostgREST**. En el nuevo
  sistema, la búsqueda por teléfono debe ser una consulta indexada sobre la
  columna normalizada, no un escaneo paginado.
- **`log_movimientos`** con `accion` + `detalle` JSON: precedente del audit
  log, pero sin previous/new value ni actor obligatorio.

## 4. Lo que hay que convertir en configuración

| Hoy (hardcodeado) | En Dark Laundry OS |
|---|---|
| `FASES` fijas: lavando/secando/detallado/empaquetado, con columnas por fase en `pedidos` | `workflows` + `workflow_steps` por tenant; `production_assignments` como filas (order, step, assigned_to, completed_by, completed_at) |
| Estado de la orden = fase de producción (una sola máquina) | Estado general de la orden separado del paso de producción |
| Tabla `VOLUMEN` de tenis en código | `pricing_rules` tipo volumen por SKU/categoría, con escalones |
| `TASA_NIVEL`, `PROMOS_MEMBRESIA`, `PLANES` (Clean Club +/VIP) | Módulo futuro de memberships; en MVP solo el hook en el pipeline de pricing |
| `DESCUENTOS` en código (CX, QA, F&F, Staff…) | `discounts` por tenant (ya existe tabla `descuentos`, pero duplicada en código) |
| Transporte detectado con regex `/transporte/i` | Fee explícito (`delivery_fee`) con reglas por zona, no un SKU identificado por nombre |
| Puntos = 5% del total, solo con correo | Loyalty (V1), configurable |
| Ventanas `10am-4pm`, `8pm-10pm`, sin sábado, entrega = +3 días | `delivery_windows`, horarios y SLA por tenant |
| Semáforo por umbrales por estado | Riesgo calculado por paso: duración estimada vs promised date |
| Tags de cliente: nuevo, VIP ≥ $5000, churn > 90 días, > 45 días | Reglas de customer status configurables |
| "Presión" de planta con pesos por ítem | Base futura de capacity; no en MVP |
| Dominios CORS, remitente, `statement_descriptor`, textos WhatsApp, recibo | Settings del tenant + templates de notificación |
| Auto-asignar courier si solo hay uno | Regla opcional en settings |

## 5. Lo que no se lleva

- Sistema de puntos, pesos por fase y penalizaciones de empleados
  (`lib/desempeno.js`, `fallas_calidad.puntos`).
- Zonas de CDMX (`update_zonas*.sql`), Uber Direct y sus ventanas de 1 hora.
- Scripts de importación y de parches de datos (`update-*.js`, `import-data.js`).
- Planes y ids de MercadoPago de Clean Club.
- Cálculo de LTV/total_pedidos como contadores mutados desde el navegador:
  en el nuevo sistema se derivan de órdenes y pagos (vista o agregados
  mantenidos en servidor).

## 6. Mapeo de entidades

| laundry-os | Dark Laundry OS |
|---|---|
| — | `tenants`, `memberships` (user↔tenant↔role), `roles`, `permissions` |
| `empleados` (rol texto, password) | `auth.users` (Supabase Auth) + `employees` |
| `clientes` (dir, zona, puntos, ltv, suscripción…) | `customers` + `customer_addresses`; métricas derivadas |
| `pedidos.items` (JSON) | `orders` + `order_items` con precio congelado y breakdown guardado |
| `pedidos.pago` `{metodo, pagado, anticipo}` | `payments` (transacciones con idempotency key) → estado derivado: pending / partial / paid / refunded |
| `pedidos.estado` + columnas por fase | `orders.status` + `production_assignments` |
| `pedidos.courier_id`, fechas, `ventana_recoleccion` | `deliveries` (pickup/delivery) + `routes` + `route_stops` |
| `ordenRuta` en `configuracion` | `route_stops.position` |
| `skus`, `categorias` | `products`, `product_categories` |
| `descuentos` | `discounts`, `pricing_rules` |
| `fallas_calidad` | `quality_issues` (sin puntos) |
| `log_movimientos` | `audit_log` (actor, action, entity, before, after) |
| `fotos` JSON + bucket público | Storage privado por tenant con URLs firmadas |
| `driver_locations` | Opcional en MVP |
| `configuracion` (key/value) | `tenant_settings` tipado por sección |
| `/miorden` por teléfono | `/t/{public_token}` por orden |

## 7. Recomendaciones para arrancar

1. Migraciones versionadas desde el día uno, incluido el schema base, con RLS
   por `tenant_id` en todas las tablas operativas.
2. Toda escritura con reglas (transiciones de estado, pagos, asignaciones)
   pasa por funciones de servidor o RPCs de Postgres que validan permiso y
   escriben audit log en la misma transacción.
3. Portar `lib/precios.js` a TypeScript como motor de pricing parametrizado
   por reglas del tenant, reutilizando sus 107 casos de prueba como
   especificación (reescritos con reglas configuradas en vez de constantes).
4. Pagos: tabla de transacciones con `unique(provider, provider_payment_id)`
   para que un webhook repetido no duplique dinero; el estado de pago de la
   orden se deriva de la suma.
5. Partir la UI por módulos (orders, production, delivery, customers,
   catalog, settings) en lugar de archivos de miles de líneas.

---

# Anexo: laundry-saas (primer intento multi-tenant)

Revisión de `TTCMX/laundry-saas` (último commit 2026-06-09). Es un fork de
una versión anterior de laundry-os al que se le agregó Supabase Auth,
tenants, RLS, invitaciones, multi-sucursal y billing con Stripe. La
operación (`App.jsx` 3.8k líneas, `Admin.jsx` 2k) sigue siendo la de La
Laundry, anterior a `lib/precios.js` y `lib/fases.js`.

## Qué rescatar

- **Onboarding SaaS completo**: signup, verificación de correo, forgot/reset
  password, `create_tenant` (RPC security definer que crea tenant + admin en
  una transacción), `TenantContext`, `ProtectedRoute`.
- **Invitaciones por token** (`tenant_invitations` + `accept_invite`) con
  `select ... for update` contra doble aceptación, expiración y un solo uso.
- **Helpers `get_my_tenant_id()` / `get_my_role()` security definer** para
  que las políticas no consulten `tenant_users` directamente (evita la
  recursión que ya les pasó, documentada en `migration_fix_rls_recursion.sql`).
- **Audit log inmutable por RLS** (`update`/`delete` con `using (false)`).
- **Webhook de Stripe con verificación de firma** sobre el raw body.
- **Idea de producto**: planes por tipo de operación (tradicional, delivery,
  híbrida) y walk-in vs delivery como tipo de orden. Encaja con el principio
  de "core universal + configuración".
- `REPLICA IDENTITY FULL` para que Realtime filtre por `tenant_id` en
  deletes.

## Problemas encontrados

1. **Escalada de privilegios entre tenants (crítico).** Tras el fix de
   recursión, las políticas vigentes de `tenant_users` son
   `insert with check (user_id = auth.uid())` y
   `update using (user_id = auth.uid())`. Cualquier usuario registrado puede
   insertarse en el tenant que quiera con `role = 'admin'`, o subirse a admin
   en el suyo, directamente con la anon key. Las altas en `tenant_users`
   solo deberían ocurrir vía `create_tenant` / `accept_invite`.
2. **Roles con `limit 1` sin orden**: `get_my_tenant_id()` y `get_my_role()`
   toman una fila cualquiera. Con más de un tenant por usuario (consultores,
   dueños de varias lavanderías) el resultado es indeterminado; hoy se
   "resuelve" prohibiendo pertenecer a más de uno.
3. **Roles fijos** en un `check` (`admin`, `staff`, `driver`): no hay RBAC.
4. **RLS de escritura demasiado amplia**: cualquier miembro (incluido un
   driver) puede editar cualquier pedido o cliente del tenant; `configuracion`
   es `for all` para todos los miembros. Los permisos por rol siguen en el
   frontend.
5. **Dos modelos en paralelo**: `orders`/`customers`/`tenant_services`
   (schema.sql, inglés) y `pedidos`/`clientes`/`skus` (migration_v2, español).
   La app usa el segundo; el primero quedó huérfano.
6. **`tenant_id` en tablas hijas sin FK compuesta**: nada impide que un
   pedido del tenant A apunte a un cliente del tenant B.
7. **Mismos datos personales en el repo** (`clientes_laundry.json`,
   `pedidos_laundry.json`) y scripts de parche de La Laundry.
8. Migraciones sueltas en la raíz sin orden ni herramienta; el fix de
   recursión se aplicó a mano en el SQL Editor.
9. `invite_user_to_tenant` (schema.sql) permite a un admin asignar cualquier
   rol sin validar `p_role`, y busca en `auth.users` por email: sigue
   existiendo junto a la versión con tokens.

## Conclusión

La capa SaaS (auth, tenants, invitaciones, onboarding, billing) es la parte
reutilizable como referencia de flujo, no como código: hay que rehacer las
políticas desde cero. La capa operativa no aporta nada frente a laundry-os,
que tiene la versión más madura de pricing y fases.

Para Dark Laundry OS:

- Membresías `tenant_members(tenant_id, user_id, role_id)` escritas solo por
  RPCs; políticas con `exists (select 1 from tenant_members ...)` a través de
  funciones security definer que reciben el `tenant_id` de la fila, así un
  usuario puede pertenecer a varios tenants sin ambigüedad.
- `roles` / `permissions` / `role_permissions` por tenant, con un helper
  `has_permission(tenant_id, 'orders.update')` usado en políticas y RPCs.
- FKs compuestas `(tenant_id, id)` en tablas hijas.
- Migraciones versionadas con Supabase CLI y tests de RLS (usuario de tenant
  A no ve ni escribe nada de B; driver no edita catálogo; nadie se
  auto-asigna rol).
- El billing SaaS (Stripe) queda fuera del MVP operativo, pero el modelo de
  tenant deja preparado `plan` / `plan_status`.
