# Puesta en marcha: Supabase + Vercel en una sola pasada

Tiempo estimado: 30–45 minutos. Al final tendrás la app en línea, con base de datos, login, pagos en línea (opcional) y correos (opcional).

> Todo lo que está en **negritas y monoespaciado** (`así`) se copia tal cual.

---

## 0. Antes de empezar

Necesitas cuentas en:

- **GitHub**: el código ya está en `TTCMX/darker-laundry`.
- **Supabase**: base de datos, login y archivos.
- **Vercel**: hosting de la app y de las funciones `/api`.
- Opcional: **MercadoPago** (pagos en línea) y **Resend** (correos).

En tu computadora, solo si vas a usar la opción A del paso 1.2: Node 20+ (`node -v`).

---

## 1. Supabase

### 1.1 Crear el proyecto

1. En [supabase.com](https://supabase.com) → **New project**.
2. Nombre: `dark-laundry-os`. Región: la más cercana a tus clientes (para México, `East US (North Virginia)`).
3. Guarda la **contraseña de la base de datos** en un gestor de contraseñas.
4. Cuando termine de crearse, ve a **Project Settings → API** y copia:
   - **Project URL**: `https://xxxx.supabase.co`
   - **anon public** key
   - **service_role** key (es secreta: nunca va al navegador ni a un archivo con prefijo `VITE_`)
   - El **Reference ID** del proyecto (en Project Settings → General)

### 1.2 Crear las tablas (migraciones)

Elige **una** opción.

**Opción A: con la CLI (recomendada, evita errores de copiado)**

```bash
git clone https://github.com/TTCMX/darker-laundry.git
cd darker-laundry
npx supabase login
npx supabase link --project-ref TU_REFERENCE_ID     # pide la contraseña de la base
npx supabase db push                                 # aplica supabase/migrations/*
```

**Opción B: desde el navegador**

En Supabase → **SQL Editor** → **New query**, pega y ejecuta **en orden** cada archivo de `supabase/migrations/`, del `…0001_foundation.sql` al `…0009_storage_realtime.sql`. Cada uno debe terminar en "Success".

**Verifica:** en **Table Editor** deben aparecer `tenants`, `orders`, `customers`, `payments`, etc. En **Storage** debe existir el bucket privado `evidence`.

### 1.3 Autenticación

En **Authentication → URL Configuration**:

- **Site URL**: la URL de Vercel (paso 2). Si aún no la tienes, pon `http://localhost:5173` y cámbiala al terminar.
- **Redirect URLs**: agrega `https://TU-APP.vercel.app/**` (y tu dominio propio si tienes, p. ej. `https://app.tulavanderia.com/**`).

En **Authentication → Providers → Email**: deja **Email** activado. "Confirm email" puede quedarse activado (recomendado).

**Correos de login en producción:** el correo integrado de Supabase tiene un límite bajo por hora. Antes de invitar a todo tu equipo, configura SMTP propio en **Authentication → Emails → SMTP Settings**. Con Resend: host `smtp.resend.com`, puerto `465`, usuario `resend`, contraseña = tu API key de Resend.

---

## 2. Vercel

1. En [vercel.com](https://vercel.com) → **Add New… → Project** → importa `TTCMX/darker-laundry`.
2. Framework: **Vite** (lo detecta solo por `vercel.json`). No cambies los comandos de build.
3. **Environment Variables**: agrega estas antes del primer deploy.

| Variable | Valor | Obligatoria |
|---|---|---|
| `VITE_SUPABASE_URL` | Project URL de Supabase | Sí |
| `VITE_SUPABASE_ANON_KEY` | anon public key | Sí |
| `SUPABASE_URL` | Project URL de Supabase (la misma) | Sí |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key | Sí |
| `APP_URL` | `https://TU-APP.vercel.app` (o tu dominio) | Sí |
| `CRON_SECRET` | una cadena larga aleatoria (`openssl rand -hex 32`) | Sí |
| `RESEND_API_KEY` | API key de Resend | No |
| `EMAIL_FROM` | `Tu Lavandería <avisos@tudominio.com>` | Si usas Resend |

4. **Deploy**.
5. Comprueba que el servidor quedó bien configurado abriendo `https://TU-APP.vercel.app/api/health`. Debe responder `"supabase": true` y `"app_url": true`.
6. Regresa a Supabase (paso 1.3) y pon la URL definitiva en **Site URL** y **Redirect URLs**.

> **Rama:** Vercel publica en producción la rama por defecto (`main`). Mientras el trabajo siga en `claude/inspiring-faraday-bhnqts`, haz merge a `main` o elige esa rama en Vercel → Settings → Git → Production Branch.

El cron diario (`/api/cron/daily`) queda registrado solo con `vercel.json`: envía los correos que hayan quedado en cola y vence los links de pago viejos. Los correos normales salen al momento, sin esperar al cron.

---

## 3. Primer uso (10 minutos)

1. Abre la app → **Crea una cuenta** → confirma tu correo → **Configura tu lavandería** (nombre, país, moneda, zona horaria). Quedas como **Dueño**.
2. **Ajustes → Operación**: revisa el flujo de producción (viene Lavado → Secado → Doblado → Control de calidad → Empaque). Agrega, quita o reordena fases.
3. **Catálogo**: "Cargar catálogo de ejemplo" y ajusta los precios, o crea tus servicios. Agrega **Precio por volumen**, **Descuentos** y **Zonas de entrega** si aplican.
4. **Ajustes → Entregas**: horarios de recolección y tarifa general de envío.
5. **Ajustes → Precios e impuestos**: IVA incluido, IVA sumado o sin impuestos.
6. **Equipo → Invitar**: genera un enlace por persona con su rol (Gerente, Mostrador, Producción, Courier) y compártelo por WhatsApp. El courier entra directo a su vista móvil.
7. Crea una orden de prueba y recórrela: recolección → producción → entrega → cobro → enlace de seguimiento.

**Cómo fluyen las órdenes** (requiere la migración `20261002000001_production_flow.sql`):
- Una orden de **mostrador** con servicios entra sola a producción al crearla.
- Una orden **a domicilio** entra a producción en cuanto se recibe la ropa (el courier completa la recolección o se pulsa "Recibir en tienda"). Si todavía no tiene servicios, espera en la columna "Por capturar" del tablero y entra sola al capturarlos.
- Al terminar la última fase, las órdenes a domicilio quedan **programadas para entrega** automáticamente: el día prometido (o el siguiente día laboral con horario disponible), en el primer horario libre, asignadas al courier si solo hay uno. Aparecen en Entregas y en la ruta del courier. Una entrega fallida se reprograma a mano.
- Cada orden muestra si es **A domicilio** o **Mostrador** en el tablero, la lista de órdenes y su detalle.
- **Crear ruta** (en Entregas) trae ya seleccionados todos los pedidos listos a domicilio, sin importar el día para el que estaban programados o si no tenían entrega; al guardar, las paradas pasan al día de la ruta (requiere `20261002000002_route_any_day.sql`).

---

## 4. Pagos en línea con MercadoPago (opcional)

1. En MercadoPago → **Tus integraciones** → crea una aplicación → **Credenciales de producción** → copia el **Access token** (`APP_USR-…`). Para probar, usa las credenciales de prueba (`TEST-…`).
2. En la app: **Ajustes → Pagos → MercadoPago**: pega el token y activa "Aceptar pagos en línea". La app valida el token contra MercadoPago al guardar.
3. Copia la **URL de notificaciones** que muestra la app y regístrala en MercadoPago → tu aplicación → **Webhooks** → evento **Pagos**.
4. MercadoPago muestra una **clave secreta** para el webhook: pégala en la app. Con ella se verifica la firma de cada notificación.

Cómo funciona:

- El monto del link siempre es el saldo real de la orden, calculado en el servidor.
- Cada notificación se confirma consultando el pago directamente en MercadoPago.
- Un webhook repetido no duplica dinero.
- Un pago parcial queda como pago parcial.

Los reembolsos se hacen en MercadoPago y se registran en la orden con **Pagos → Reembolsar**.

---

## 5. Correos con Resend (opcional)

1. En [resend.com](https://resend.com) verifica tu dominio (registros DNS).
2. Crea una API key y ponla en Vercel como `RESEND_API_KEY`, con `EMAIL_FROM="Tu Lavandería <avisos@tudominio.com>"`. Haz redeploy.
3. Por defecto las plantillas de **correo** son automáticas y las de **WhatsApp** son manuales: quedan listas en la orden para enviarse con un toque. Se cambian en **Ajustes → Notificaciones**.

Cada lavandería puede usar su propio remitente de Resend desde **Ajustes → Notificaciones → Remitente de correo**.

---

## 5b. Impresora de tickets Bluetooth (opcional)

No requiere configuración en el servidor. Usa el mismo protocolo que la app interna (Bluetooth LE, servicio `0x18F0` / característica `0x2AF1`, ESC/POS) y también prueba los servicios de las impresoras térmicas más comunes.

1. En cada celular o computadora: **Ajustes → Tickets → Conectar** y elige la impresora. Si no aparece, usa **Mostrar todos los dispositivos**. Elige el ancho del papel (58 u 80 mm) y pulsa **Imprimir prueba**.
2. En cualquier orden, el ícono de impresora de la barra superior imprime la nota. Si la impresora no está conectada (por ejemplo, después de recargar la página), se abre el selector y luego imprime.
3. Navegadores compatibles: Chrome o Edge en Android, Windows, macOS y ChromeOS. Safari en iPhone no permite Bluetooth; ahí puedes usar el navegador Bluefy o **⋮ → Imprimir (navegador)**, que imprime el mismo ticket en cualquier impresora instalada (USB, Wi‑Fi o PDF).
4. En **Ajustes → Tickets** se configura el contenido: encabezado, pie, link o QR de seguimiento, puntos de lealtad y espacio para anotar a mano. Los datos del negocio (nombre, RFC, dirección y teléfono) salen de **Ajustes → Negocio**.

## 5c. Análisis (back office)

Menú **Análisis** (dueños y gerentes; permiso `reports.view`, que se puede dar a otros roles en **Equipo → Roles**). Pestañas:

- **Ventas:** ventas, órdenes, ticket promedio, cobrado, clientes nuevos, por cobrar, descuentos y cancelaciones; gráfica por día/semana/mes, mostrador vs. domicilio, métodos de pago y horas pico.
- **Recibos** y **Pagos:** todos los movimientos del periodo con filtros y totales.
- **Servicios:** servicios y categorías más vendidos, descuentos aplicados y costo del programa de lealtad.
- **Clientes:** compradores, nuevos, retención, mejores clientes y clientes valiosos que dejaron de venir.
- **Empleados:** órdenes, ventas y cobros registrados por persona; fases completadas y tiempos contra lo estimado; paradas del courier; incidencias.
- **Operación:** entregas a tiempo, tiempos de proceso, recolecciones/entregas, visitas fallidas y cancelaciones.
- **Incidencias:** por tipo, fase, severidad y responsable, con detalle.

Cada periodo se compara con el anterior de la misma duración, el periodo va en el link (se puede compartir) y cada tabla se descarga en CSV para Excel o Google Sheets. Las ventas cuentan cuando se crea la orden (sin canceladas); lo cobrado cuenta cuando se aplica el pago.

Requiere la migración `20260928000001_analytics.sql`.

## 5d. Importar clientes de otro sistema

**Clientes → Importar** (permiso para editar clientes). Requiere la migración `20260928000002_customer_import.sql`.

1. Exporta tus clientes del sistema anterior como Excel (.xlsx) o CSV, con los títulos de las columnas en la primera fila. Si no sabes qué formato usar, descarga la plantilla desde la misma ventana.
2. La app reconoce las columnas (Nombre, Apellido, Teléfono/Celular, Correo, Dirección, Colonia, CP, Ciudad, Referencias, Notas, Etiquetas, Puntos, Fecha de alta). Puedes cambiar cualquiera o marcarla como "No importar". Si nombre y apellido vienen separados, asigna las dos a Nombre.
3. **Revisar** muestra fila por fila qué pasará, sin guardar nada: nuevos, repetidos (mismo teléfono o correo, aunque esté escrito distinto) y errores (sin nombre, teléfono o correo inválido). Puedes descargar las filas a revisar, corregirlas y volver a importar el archivo: lo ya importado se detecta como repetido.
4. Si el cliente ya existe puedes dejarlo como está o completar sus datos vacíos (nunca se reemplaza lo capturado).
5. Los puntos de lealtad se cargan como saldo inicial solo si quien importa puede ajustar puntos y el cliente no tenía puntos.

Se aceptan CSV separados por coma, punto y coma o tabulador, en UTF-8 o en la codificación de Excel en Windows. Los .xls antiguos hay que guardarlos antes como .xlsx.

## 5e. Prueba gratis (primeros testers)

Requiere la migración `20261001000001_free_trial.sql`.

- Cada negocio tiene **3 meses gratis con todas las funciones**, contados desde que se registra. Los negocios que ya existían reciben 3 meses desde su fecha de registro.
- El dueño ve los días restantes en **Ajustes → Plan** y un aviso en todas las pantallas cuando faltan 15 días o menos.
- Al terminar, el negocio queda en **solo lectura**: se puede consultar, ver Análisis y exportar, y el dueño puede cambiar Ajustes y Equipo, pero no se crean ni modifican órdenes, clientes, pagos, producción ni entregas. Lo bloquea la base de datos, no solo la pantalla. La página de seguimiento de los clientes y los pagos en línea de órdenes existentes siguen funcionando.
- Opcional: `VITE_SUPPORT_EMAIL` en Vercel para mostrar un correo de contacto en esos avisos.

Administración (en el SQL Editor de Supabase; el `slug` es la dirección del negocio):

```sql
-- Ver negocios y cuándo termina su prueba
select name, slug, plan, plan_status, created_at, trial_ends_at from public.tenants order by created_at desc;
-- Extender la prueba un mes
update public.tenants set trial_ends_at = trial_ends_at + interval '1 month' where slug = 'mi-lavanderia';
-- Dejar un negocio sin límite (por ejemplo, tus propias lavanderías)
update public.tenants set plan = 'internal' where slug = 'mi-lavanderia';
```

## 5f. Tipo de operación (mostrador, domicilio o híbrida)

Requiere la migración `20261003000001_operation_model.sql`.

- Se elige al crear el negocio y se ve en **Ajustes → Plan**:
  - **Solo mostrador:** sin recolecciones, entregas, rutas, zonas de entrega ni couriers.
  - **Todo a domicilio:** cada orden lleva recolección y entrega; no hay "entregar en mostrador".
  - **Híbrida:** ambas, con la etiqueta A domicilio / Mostrador en cada orden.
- La app oculta lo que no aplica y la base de datos lo rechaza (no se pueden crear órdenes ni paradas del tipo que no corresponde). Las órdenes que ya existían siguen funcionando.
- **Va con el plan:** durante la prueba gratis (y en negocios `internal`) el dueño lo cambia cuando quiera, siempre que no queden órdenes abiertas del tipo que se quita. Con un plan pagado queda fijo y se cambia cambiando de plan. Los negocios que ya existían quedan como **Híbrida**.

Administración (SQL Editor):

```sql
-- Pasar un negocio a un plan pagado de solo mostrador (o 'delivery' / 'hybrid')
update public.tenants set plan = 'walk_in', operation_model = 'walk_in' where slug = 'mi-lavanderia';
```

## 5g. Cancelar y eliminar órdenes

Requiere la migración `20261005000001_cancel_and_delete_orders.sql`.

- **Cancelar orden** (menú ⋮ de la orden) funciona en cualquier momento antes de entregarla, también si está Lista o En camino. Se cancelan sus recolecciones/entregas pendientes y se devuelven los puntos usados.
- **Eliminar orden** (dueño y gerente) la borra por completo, por ejemplo si se creó por error o era de prueba. Pide un motivo, que queda en la Bitácora. Solo se puede si la orden no tiene pagos; si los tiene, hay que cancelarla y reembolsar para que la caja cuadre.

## 5h. Cómo se usa el día a día

- **Menú**: Inicio, Pedidos, Clientes, Ruta y Ventas arriba; Pagos, Archivo, Catálogo, Equipo, Ajustes y Bitácora en *Back office*. En el teléfono: pestañas abajo (lo que no cabe está en *Más*) y el botón naranja **+** para crear una orden.
- **Pedidos** es el tablero de todo el ciclo: Por recolectar → Por capturar → cada fase de producción → Listas → En ruta → Entregadas hoy. Para mover una orden un paso: el botón de la tarjeta, deslizar a la derecha (avanzar) o a la izquierda (regresar) en el teléfono, o arrastrarla a otra columna en la computadora. *Me toca ahora* deja solo lo que te toca trabajar.
- Al tocar una orden (en el tablero, Inicio, Clientes, Archivo o Ventas) se abre encima de la pantalla en la que estás; al cerrarla regresas a donde estabas. Un enlace directo a la orden la abre como página completa.
- **Archivo** busca cualquier orden, incluidas las entregadas y canceladas.
- **¿Te equivocaste de dedo?** Cualquier paso se puede regresar (botón ↶ de la tarjeta, deslizar a la izquierda o arrastrar a la columna anterior): una fase marcada por error, una entrega, "En ruta" o una recolección. El personal de producción puede regresar las fases que marcó; las de otra persona, solo un gerente. Queda en la bitácora. Requiere la migración `20261006000001_undo_order_step.sql`.

## 6. Desarrollo local

Con Docker instalado:

```bash
npm install
npx supabase start          # levanta Postgres, Auth, Storage y Realtime locales
npx supabase db reset       # aplica todas las migraciones
cp .env.example .env.local  # llena con los valores que imprimió `supabase start` (API URL, anon key, service_role key)
#   APP_URL=http://localhost:5173
npm run dev                 # http://localhost:5173 (UI + /api en el mismo servidor)
```

Verificaciones:

```bash
npm run typecheck   # TypeScript
npm test            # motor de precios, dominio, paridad con la base, iconos
npm run test:db     # migraciones + RLS + flujo operativo completo (Postgres local o $DATABASE_URL)
npm run check       # las tres
```

Si usas un icono nuevo de Material Symbols: `pip install fonttools brotli && npm run icons`.

---

## 7. Problemas comunes

| Síntoma | Causa probable |
|---|---|
| Pantalla de login con aviso "Falta configurar VITE_SUPABASE_URL…" | Faltan las variables `VITE_*` en Vercel, o se agregaron después del build: haz redeploy. |
| `/api/health` responde `"supabase": false` | Falta `SUPABASE_SERVICE_ROLE_KEY` o `SUPABASE_URL` en Vercel. |
| "Tu sesión expiró" al guardar una orden | La service_role key no corresponde al mismo proyecto que la anon key. |
| El enlace del correo de confirmación lleva a localhost | Actualiza **Site URL** y **Redirect URLs** en Supabase. |
| No llegan correos de confirmación | Límite del correo integrado de Supabase: configura SMTP (paso 1.3). |
| El botón "Pagar ahora" no aparece en el seguimiento | MercadoPago no está activado en Ajustes → Pagos. |
| Los pagos en línea no se marcan | Falta registrar el webhook en MercadoPago, o la clave secreta del webhook no coincide. |
