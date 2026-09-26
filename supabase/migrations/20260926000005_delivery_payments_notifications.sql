-- ============================================================================
-- 0005 · Delivery (routes & stops), payments ledger, integrations, notifications
-- ============================================================================

-- ── Routes & deliveries ─────────────────────────────────────────────────────
-- A delivery row is one stop (pickup or delivery) of an order. A route groups
-- stops for one courier on one day; `stop_position` orders them.

create table public.routes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  route_date   date not null,
  name         text,
  courier_id   uuid,
  status       text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  started_at   timestamptz,
  completed_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, courier_id) references public.tenant_members(tenant_id, user_id) on delete set null (courier_id)
);

create index routes_day on public.routes (tenant_id, route_date);

create table public.deliveries (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  order_id       uuid not null,
  type           text not null check (type in ('pickup', 'delivery')),
  status         text not null default 'scheduled' check (status in (
                   'scheduled', 'assigned', 'en_route', 'arrived', 'completed', 'failed', 'cancelled')),
  address_id     uuid,
  -- Snapshot: the stop keeps the address it was planned with.
  address        jsonb not null default '{}'::jsonb,
  scheduled_date date not null,
  window_start   time,
  window_end     time,
  window_label   text,
  courier_id     uuid,
  route_id       uuid,
  stop_position  int,
  notes          text,
  failure_reason text,
  proof_paths    text[] not null default '{}',
  started_at     timestamptz,
  arrived_at     timestamptz,
  completed_at   timestamptz,
  completed_by   uuid,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, address_id) references public.customer_addresses(tenant_id, id) on delete set null (address_id),
  foreign key (tenant_id, courier_id) references public.tenant_members(tenant_id, user_id) on delete set null (courier_id),
  foreign key (tenant_id, completed_by) references public.tenant_members(tenant_id, user_id) on delete set null (completed_by),
  foreign key (tenant_id, route_id) references public.routes(tenant_id, id) on delete set null (route_id)
);

-- One live pickup and one live delivery per order; failed ones can be rescheduled.
create unique index deliveries_one_active on public.deliveries (order_id, type)
  where status not in ('failed', 'cancelled');
create index deliveries_day on public.deliveries (tenant_id, scheduled_date, status);
create index deliveries_courier on public.deliveries (tenant_id, courier_id, scheduled_date);
create index deliveries_route on public.deliveries (route_id, stop_position);

-- ── Payments ────────────────────────────────────────────────────────────────
-- An append-mostly ledger. The order's paid amount and payment status are
-- always derived from it (app.recompute_order_payment), never set by hand.

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  order_id            uuid not null,
  kind                text not null default 'payment' check (kind in ('payment', 'refund')),
  method              text not null check (method in ('cash', 'card', 'transfer', 'online')),
  provider            text not null default 'manual',
  provider_payment_id text,
  status              text not null default 'succeeded' check (status in ('pending', 'succeeded', 'failed')),
  amount_cents        bigint not null check (amount_cents > 0),
  currency            text not null default 'MXN',
  -- Same key twice = same payment. Protects against double taps and retries.
  idempotency_key     text not null,
  refund_of           uuid references public.payments(id),
  delivery_id         uuid,
  notes               text,
  recorded_by         uuid,
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id),
  foreign key (tenant_id, delivery_id) references public.deliveries(tenant_id, id) on delete set null (delivery_id)
);

create unique index payments_provider_ref on public.payments (provider, provider_payment_id)
  where provider_payment_id is not null;
create index payments_order on public.payments (tenant_id, order_id, created_at);
create index payments_day on public.payments (tenant_id, created_at desc);

create table public.payment_links (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  order_id     uuid not null,
  provider     text not null,
  provider_ref text,
  url          text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status       text not null default 'active' check (status in ('active', 'paid', 'expired', 'cancelled')),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade
);

create index payment_links_order on public.payment_links (tenant_id, order_id, created_at desc);

-- Every incoming webhook is recorded once; replays are acknowledged and ignored.
create table public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  event_key    text not null,
  tenant_id    uuid references public.tenants(id) on delete cascade,
  payload      jsonb,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text,
  unique (provider, event_key)
);

-- Per-tenant provider configuration. `config` is readable by the tenant's
-- admins; `tenant_secrets` is only ever read by server code (service role).
create table public.tenant_integrations (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  provider   text not null check (provider in ('mercadopago', 'resend', 'whatsapp')),
  enabled    boolean not null default false,
  config     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

create table public.tenant_secrets (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  provider   text not null,
  secrets    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

-- ── Notifications ───────────────────────────────────────────────────────────

create table public.notification_templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  event      text not null check (event in (
               'order_created', 'pickup_scheduled', 'order_received', 'production_update',
               'order_ready', 'out_for_delivery', 'order_delivered', 'payment_reminder')),
  channel    text not null check (channel in ('email', 'whatsapp', 'sms')),
  subject    text,
  body       text not null,
  enabled    boolean not null default true,
  -- auto: sent by the system. manual: queued for staff to send with one tap.
  mode       text not null default 'manual' check (mode in ('auto', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, event, channel)
);

create table public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  order_id            uuid,
  customer_id         uuid,
  template_id         uuid references public.notification_templates(id) on delete set null,
  event               text not null,
  channel             text not null,
  mode                text not null check (mode in ('auto', 'manual')),
  recipient           text not null,
  -- Snapshot of the template and its variables at the time of the event;
  -- rendered by src/domain/templates.ts (the only renderer).
  subject_template    text,
  body_template       text not null,
  variables           jsonb not null default '{}'::jsonb,
  status              text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  dedupe_key          text not null,
  attempts            int not null default 0,
  last_error          text,
  provider_message_id text,
  sent_at             timestamptz,
  sent_by             uuid,
  created_at          timestamptz not null default now(),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete cascade
);

create index notifications_pending on public.notifications (tenant_id, status, mode, created_at);
create index notifications_order on public.notifications (tenant_id, order_id, created_at desc);

-- ── Triggers ────────────────────────────────────────────────────────────────

create trigger routes_touch before update on public.routes for each row execute function app.touch_updated_at();
create trigger deliveries_touch before update on public.deliveries for each row execute function app.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function app.touch_updated_at();
create trigger templates_touch before update on public.notification_templates for each row execute function app.touch_updated_at();
create trigger integrations_touch before update on public.tenant_integrations for each row execute function app.touch_updated_at();
create trigger secrets_touch before update on public.tenant_secrets for each row execute function app.touch_updated_at();

create trigger routes_audit after insert or update or delete on public.routes for each row execute function app.audit_row();
create trigger deliveries_audit after insert or update or delete on public.deliveries for each row execute function app.audit_row();
create trigger payments_audit after insert or update on public.payments for each row execute function app.audit_row();
create trigger payment_links_audit after insert or update on public.payment_links for each row execute function app.audit_row();
create trigger templates_audit after insert or update or delete on public.notification_templates for each row execute function app.audit_row();
create trigger integrations_audit after insert or update on public.tenant_integrations for each row execute function app.audit_row();
