-- ============================================================================
-- 0004 · Orders, configurable production workflow, quality issues
-- ============================================================================

-- ── Workflow configuration (per tenant) ─────────────────────────────────────

create table public.workflows (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  is_default boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create unique index workflows_one_default on public.workflows (tenant_id) where is_default;

create table public.workflow_steps (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  workflow_id         uuid not null,
  name                text not null check (length(btrim(name)) between 1 and 60),
  position            int not null,
  active              boolean not null default true,
  requires_assignment boolean not null default false,
  -- Empty = any member with production.work can take it.
  allowed_role_ids    uuid[] not null default '{}',
  estimated_minutes   int check (estimated_minutes is null or estimated_minutes >= 0),
  priority            int not null default 0,
  color               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, workflow_id) references public.workflows(tenant_id, id) on delete cascade
);

create index workflow_steps_order on public.workflow_steps (workflow_id, position);

-- ── Orders ──────────────────────────────────────────────────────────────────

create table public.order_counters (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  last_number bigint not null default 0
);

-- The general lifecycle. Keep in sync with src/domain/orders.ts (tested).
create table app.order_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

insert into app.order_transitions (from_status, to_status) values
  ('created', 'scheduled'),
  ('created', 'picked_up'),
  ('created', 'in_production'),
  ('created', 'cancelled'),
  ('scheduled', 'picked_up'),
  ('scheduled', 'cancelled'),
  ('picked_up', 'in_production'),
  ('picked_up', 'cancelled'),
  ('in_production', 'ready'),
  ('in_production', 'cancelled'),
  ('ready', 'out_for_delivery'),
  ('ready', 'delivered'),
  ('ready', 'in_production'),
  ('out_for_delivery', 'delivered'),
  ('out_for_delivery', 'ready');

create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  number               bigint not null,
  public_token         text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  customer_id          uuid not null,
  fulfillment          text not null default 'delivery' check (fulfillment in ('delivery', 'walk_in')),
  status               text not null default 'created' check (status in (
                         'created', 'scheduled', 'picked_up', 'in_production', 'ready',
                         'out_for_delivery', 'delivered', 'cancelled')),
  priority             text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  workflow_id          uuid,
  current_step_id      uuid,
  pickup_address_id    uuid,
  delivery_address_id  uuid,
  delivery_zone_id     uuid,
  promised_at          timestamptz,
  notes                text,
  internal_notes       text,
  subtotal_cents       bigint not null default 0,
  discount_cents       bigint not null default 0,
  delivery_fee_cents   bigint not null default 0,
  tax_cents            bigint not null default 0,
  total_cents          bigint not null default 0 check (total_cents >= 0),
  amount_paid_cents    bigint not null default 0,
  balance_cents        bigint generated always as (greatest(total_cents - amount_paid_cents, 0)) stored,
  payment_status       text not null default 'paid' check (payment_status in ('pending', 'partially_paid', 'paid', 'refunded', 'failed')),
  pricing              jsonb,
  priced_at            timestamptz,
  delivery_fee_override boolean not null default false,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  ready_at             timestamptz,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  unique (tenant_id, number),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id),
  foreign key (tenant_id, workflow_id) references public.workflows(tenant_id, id) on delete set null (workflow_id),
  foreign key (tenant_id, pickup_address_id) references public.customer_addresses(tenant_id, id) on delete set null (pickup_address_id),
  foreign key (tenant_id, delivery_address_id) references public.customer_addresses(tenant_id, id) on delete set null (delivery_address_id),
  foreign key (tenant_id, delivery_zone_id) references public.delivery_zones(tenant_id, id) on delete set null (delivery_zone_id)
);

create index orders_tenant_status on public.orders (tenant_id, status, promised_at);
create index orders_tenant_created on public.orders (tenant_id, created_at desc);
create index orders_customer on public.orders (tenant_id, customer_id, created_at desc);
create index orders_open_balance on public.orders (tenant_id) where balance_cents > 0 and status <> 'cancelled';

create table public.order_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  order_id             uuid not null,
  position             int not null,
  product_id           uuid,
  sku                  text,
  name                 text not null,
  unit                 text not null,
  quantity             numeric(12, 3) not null check (quantity > 0),
  unit_price_cents     bigint not null check (unit_price_cents >= 0),
  list_total_cents     bigint not null,
  volume_rule_id       uuid,
  volume_savings_cents bigint not null default 0,
  gross_cents          bigint not null,
  discount_cents       bigint not null default 0,
  net_cents            bigint not null check (net_cents >= 0),
  taxable              boolean not null default true,
  custom_price         boolean not null default false,
  notes                text,
  unique (order_id, position),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products(tenant_id, id) on delete set null (product_id)
);

create table public.order_discounts (
  tenant_id    uuid not null,
  order_id     uuid not null,
  discount_id  uuid not null,
  name         text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  primary key (order_id, discount_id),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, discount_id) references public.discounts(tenant_id, id) on delete cascade
);

create index order_discounts_discount on public.order_discounts (discount_id);

-- ── Production ──────────────────────────────────────────────────────────────
-- Steps are copied from the workflow when production starts, so editing the
-- workflow later never rewrites the history of orders already in the plant.

create table public.order_production_steps (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  order_id            uuid not null,
  workflow_step_id    uuid,
  name                text not null,
  position            int not null,
  requires_assignment boolean not null default false,
  allowed_role_ids    uuid[] not null default '{}',
  estimated_minutes   int,
  status              text not null default 'pending' check (status in ('pending', 'in_progress', 'done', 'skipped')),
  -- Who is responsible vs. who actually did it.
  assigned_to         uuid,
  assigned_at         timestamptz,
  assigned_by         uuid,
  started_at          timestamptz,
  completed_at        timestamptz,
  completed_by        uuid,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (order_id, position),
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, workflow_step_id) references public.workflow_steps(tenant_id, id) on delete set null (workflow_step_id),
  foreign key (tenant_id, assigned_to) references public.tenant_members(tenant_id, user_id) on delete set null (assigned_to),
  foreign key (tenant_id, completed_by) references public.tenant_members(tenant_id, user_id) on delete set null (completed_by)
);

create index production_steps_assignee on public.order_production_steps (tenant_id, assigned_to) where status in ('pending', 'in_progress');

alter table public.orders
  add foreign key (tenant_id, current_step_id) references public.order_production_steps(tenant_id, id)
  on delete set null (current_step_id) deferrable initially deferred;

-- ── Quality issues ──────────────────────────────────────────────────────────
-- Informational: they never translate automatically into employee penalties.

create table public.quality_issues (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  order_id            uuid not null,
  production_step_id  uuid,
  phase_name          text,
  type                text not null default 'damage' check (type in ('damage', 'stain', 'missing_item', 'wrong_process', 'delay', 'customer_complaint', 'other')),
  severity            text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  description         text not null check (length(btrim(description)) between 1 and 2000),
  reported_by         uuid,
  responsible_user_id uuid,
  status              text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  resolution          text,
  resolved_by         uuid,
  resolved_at         timestamptz,
  photo_paths         text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, production_step_id) references public.order_production_steps(tenant_id, id) on delete set null (production_step_id),
  foreign key (tenant_id, responsible_user_id) references public.tenant_members(tenant_id, user_id) on delete set null (responsible_user_id)
);

create index quality_issues_open on public.quality_issues (tenant_id, status, created_at desc);
create index quality_issues_order on public.quality_issues (tenant_id, order_id);

create or replace function app.quality_issue_defaults() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.reported_by := app.current_actor();
    new.status := 'open';
    new.resolved_by := null;
    new.resolved_at := null;
    if new.production_step_id is not null and new.phase_name is null then
      select name into new.phase_name from public.order_production_steps where id = new.production_step_id;
    end if;
  elsif new.status in ('resolved', 'dismissed') and old.status not in ('resolved', 'dismissed') then
    new.resolved_by := app.current_actor();
    new.resolved_at := now();
  elsif new.status not in ('resolved', 'dismissed') then
    new.resolved_by := null;
    new.resolved_at := null;
  end if;
  return new;
end $$;

create trigger quality_issues_defaults before insert or update on public.quality_issues
  for each row execute function app.quality_issue_defaults();

-- ── Triggers ────────────────────────────────────────────────────────────────

create trigger workflows_touch before update on public.workflows for each row execute function app.touch_updated_at();
create trigger workflow_steps_touch before update on public.workflow_steps for each row execute function app.touch_updated_at();
create trigger orders_touch before update on public.orders for each row execute function app.touch_updated_at();
create trigger production_steps_touch before update on public.order_production_steps for each row execute function app.touch_updated_at();
create trigger quality_issues_touch before update on public.quality_issues for each row execute function app.touch_updated_at();

create trigger workflows_audit after insert or update or delete on public.workflows for each row execute function app.audit_row();
create trigger workflow_steps_audit after insert or update or delete on public.workflow_steps for each row execute function app.audit_row();
create trigger orders_audit after insert or update or delete on public.orders for each row execute function app.audit_row();
create trigger production_steps_audit after insert or update on public.order_production_steps for each row execute function app.audit_row();
create trigger quality_issues_audit after insert or update or delete on public.quality_issues for each row execute function app.audit_row();
