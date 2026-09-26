-- ============================================================================
-- 0003 · Catalog, pricing configuration, delivery zones, customers
-- Money is stored as integer cents (bigint) everywhere.
-- ============================================================================

create table public.product_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.products (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  category_id       uuid,
  sku               text,
  name              text not null check (length(btrim(name)) between 1 and 120),
  description       text,
  unit              text not null default 'piece',
  base_price_cents  bigint not null default 0 check (base_price_cents >= 0),
  taxable           boolean not null default true,
  variable_price    boolean not null default false,
  active            boolean not null default true,
  estimated_minutes int check (estimated_minutes is null or estimated_minutes >= 0),
  production_notes  text,
  sort_order        int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, sku),
  foreign key (tenant_id, category_id) references public.product_categories(tenant_id, id) on delete set null (category_id)
);

create index products_tenant_active on public.products (tenant_id, active, sort_order);

-- Volume rules. config = { packages: [{qty, total_cents}], tiers: [{min_qty, unit_price_cents}] }
create table public.pricing_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  kind        text not null default 'volume' check (kind in ('volume')),
  product_id  uuid,
  category_id uuid,
  priority    int not null default 0,
  active      boolean not null default true,
  starts_at   timestamptz,
  ends_at     timestamptz,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (product_id is not null or category_id is not null),
  check (jsonb_typeof(config) = 'object'),
  foreign key (tenant_id, product_id) references public.products(tenant_id, id) on delete cascade,
  foreign key (tenant_id, category_id) references public.product_categories(tenant_id, id) on delete cascade
);

create table public.discounts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  name               text not null check (length(btrim(name)) between 1 and 80),
  code               text,
  kind               text not null check (kind in ('percentage', 'fixed')),
  value              numeric(12, 2) not null check (value >= 0),
  product_ids        uuid[] not null default '{}',
  category_ids       uuid[] not null default '{}',
  min_order_cents    bigint check (min_order_cents is null or min_order_cents >= 0),
  max_discount_cents bigint check (max_discount_cents is null or max_discount_cents >= 0),
  starts_at          timestamptz,
  ends_at            timestamptz,
  usage_limit        int check (usage_limit is null or usage_limit > 0),
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (kind <> 'percentage' or value <= 100),
  unique (tenant_id, id)
);

create unique index discounts_code on public.discounts (tenant_id, upper(code)) where code is not null;

create table public.delivery_zones (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 80),
  fee_cents       bigint not null default 0 check (fee_cents >= 0),
  free_over_cents bigint check (free_over_cents is null or free_over_cents >= 0),
  min_order_cents bigint check (min_order_cents is null or min_order_cents >= 0),
  postal_codes    text[] not null default '{}',
  active          boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id)
);

-- ── Customers ───────────────────────────────────────────────────────────────

create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  phone            text,
  phone_normalized text,
  email            text,
  notes            text,
  tags             text[] not null default '{}',
  archived_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id)
);

-- The phone is the natural customer key at the counter: one customer per number.
create unique index customers_phone on public.customers (tenant_id, phone_normalized) where phone_normalized is not null;
create index customers_name on public.customers (tenant_id, lower(name));
create index customers_email on public.customers (tenant_id, lower(email)) where email is not null;

create or replace function app.customers_normalize() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.phone_normalized := app.normalize_phone(
    new.phone, (select country from public.tenants where id = new.tenant_id)
  );
  if new.phone is not null and btrim(new.phone) <> '' and new.phone_normalized is null then
    raise exception using errcode = '22023', message = 'invalid phone number';
  end if;
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, app.current_actor()); end if;
  return new;
end $$;

create trigger customers_normalize before insert or update of phone, email, name on public.customers
  for each row execute function app.customers_normalize();

create table public.customer_addresses (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  customer_id  uuid not null,
  label        text,
  line1        text not null check (length(btrim(line1)) between 1 and 200),
  line2        text,
  neighborhood text,
  city         text,
  state        text,
  postal_code  text,
  instructions text,
  lat          double precision,
  lng          double precision,
  zone_id      uuid,
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete cascade,
  foreign key (tenant_id, zone_id) references public.delivery_zones(tenant_id, id) on delete set null (zone_id)
);

create index customer_addresses_customer on public.customer_addresses (tenant_id, customer_id);
create unique index customer_addresses_one_default on public.customer_addresses (customer_id) where is_default;

-- ── Triggers ────────────────────────────────────────────────────────────────

create trigger product_categories_touch before update on public.product_categories for each row execute function app.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();
create trigger pricing_rules_touch before update on public.pricing_rules for each row execute function app.touch_updated_at();
create trigger discounts_touch before update on public.discounts for each row execute function app.touch_updated_at();
create trigger delivery_zones_touch before update on public.delivery_zones for each row execute function app.touch_updated_at();
create trigger customers_touch before update on public.customers for each row execute function app.touch_updated_at();
create trigger customer_addresses_touch before update on public.customer_addresses for each row execute function app.touch_updated_at();

create trigger product_categories_audit after insert or update or delete on public.product_categories for each row execute function app.audit_row();
create trigger products_audit after insert or update or delete on public.products for each row execute function app.audit_row();
create trigger pricing_rules_audit after insert or update or delete on public.pricing_rules for each row execute function app.audit_row();
create trigger discounts_audit after insert or update or delete on public.discounts for each row execute function app.audit_row();
create trigger delivery_zones_audit after insert or update or delete on public.delivery_zones for each row execute function app.audit_row();
create trigger customers_audit after insert or update or delete on public.customers for each row execute function app.audit_row();
create trigger customer_addresses_audit after insert or update or delete on public.customer_addresses for each row execute function app.audit_row();
