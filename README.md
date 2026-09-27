# Dark Laundry OS

El sistema operativo para lavanderías con recolección y entrega:
**Orden → Producción → Cliente → Recolección/Entrega → Pago**, en una sola plataforma multi-tenant.

- **Para ponerlo en línea:** [docs/SETUP.md](docs/SETUP.md) (Supabase + Vercel en una pasada)
- **Cómo está construido:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Qué se aprendió del sistema anterior:** [docs/analisis-laundry-os.md](docs/analisis-laundry-os.md)

## Qué incluye el MVP

| Módulo | Qué hace |
|---|---|
| Órdenes | Alta con cliente, servicios, precio en vivo y fecha prometida. Estados generales separados de la producción. |
| Clientes | Customer 360: órdenes, gasto, ticket promedio, saldo y estado configurable. Teléfonos normalizados. |
| Producción | Flujo de fases configurable por lavandería y tablero Kanban con riesgo de vencimiento. Asignación con "responsable" vs. "quién lo hizo". |
| Calidad | Incidencias con fase, severidad, responsable, resolución y fotos. Sin penalizaciones automáticas. |
| Entregas | Recolecciones y entregas, rutas ordenadas por courier y app móvil del courier (navegar, llamar, cobrar, evidencia, fallos). |
| Pagos | Libro de pagos: efectivo, tarjeta, transferencia y en línea. Pagos parciales, reembolsos, links de MercadoPago y webhooks idempotentes. |
| Catálogo y precios | Servicios, categorías, precio por volumen (paquetes y escalones), descuentos, zonas de envío e impuestos. |
| Roles y permisos | RBAC con roles editables por lavandería e invitaciones por enlace. |
| Seguimiento | Página pública `/t/{token}` con progreso, desglose, saldo y botón de pago. |
| Dashboard | Métricas del día, producción por fase y alertas (atrasos, fallos, incidencias, saldos). |
| Notificaciones | Plantillas por evento y canal. Correo automático; WhatsApp manual con un toque. |
| Bitácora | Quién hizo qué y cuándo, con valores antes/después. |

## Stack

React 19 + TypeScript + Vite · Supabase (Postgres, Auth, RLS, Storage, Realtime) · Vercel Functions · MercadoPago · Resend · Diseño "Lúdico Pro" (Outfit, paleta pastel cálida).

## Estructura

```
src/domain/        Reglas de negocio puras (motor de precios, pagos, estados…), compartidas por UI y API
src/features/      Pantallas por módulo
src/ui/            Sistema de diseño "Lúdico Pro" (tokens en theme.css)
api/               Funciones serverless de Vercel (precios, pagos, webhooks, notificaciones)
supabase/          Migraciones SQL y tests de base de datos (RLS, flujo operativo)
docs/              Puesta en marcha, arquitectura, análisis del sistema anterior
```

## Comandos

```bash
npm run dev        # app + /api en http://localhost:5173
npm run check      # typecheck + tests unitarios + tests de base de datos
npm run build      # build de producción
```
