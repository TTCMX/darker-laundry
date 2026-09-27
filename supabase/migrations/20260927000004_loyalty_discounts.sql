-- ============================================================================
-- 0013 · Loyalty program and discount codes
--
-- Loyalty (optional, configured in tenants.settings.loyalty):
--   * Points are earned when an order is delivered AND fully paid: either
--     N points per amount spent or a fixed number per order. The earn row is
--     a function of the order's state (app.loyalty_settle), so edits, refunds
--     and cancellations adjust it automatically and it is never duplicated.
--   * Points are redeemed inside an order (pricing "credits" stage); the
--     database checks the program is on, the point value and the balance.
--   * A ledger (loyalty_transactions) is the only source of balances.
-- Discounts:
--   * auto_apply: preselected on new orders.
--   * code: discounts with a code are applied by typing it.
-- ============================================================================

insert into public.permissions (code, description) values
  ('loyalty.manage', 'Ajustar puntos de lealtad');

-- Managers of existing tenants get it (new tenants get it from the seed).
insert into public.role_permissions (tenant_id, role_id, permission)
select tenant_id, id, 'loyalty.manage' from public.roles where key = 'manager'
on conflict do nothing;

-- ── Discounts ───────────────────────────────────────────────────────────────

alter table public.discounts add column if not exists auto_apply boolean not null default false;
grant update (auto_apply) on public.discounts to authenticated;

-- ── Loyalty ledger ──────────────────────────────────────────────────────────

alter table public.orders
  add column if not exists points_redeemed int not null default 0 check (points_redeemed >= 0),
  add column if not exists loyalty_credit_cents bigint not null default 0 check (loyalty_credit_cents >= 0);

create table public.loyalty_transactions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,
  order_id    uuid,
  kind        text not null check (kind in ('earn', 'redeem', 'adjust')),
  points      int not null check (points <> 0),
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade
);

create unique index loyalty_one_per_order on public.loyalty_transactions (order_id, kind) where kind in ('earn', 'redeem');
create index loyalty_customer on public.loyalty_transactions (tenant_id, customer_id, created_at desc);

create trigger loyalty_audit after insert or update or delete on public.loyalty_transactions
  for each row execute function app.audit_row();

alter table public.loyalty_transactions enable row level security;
revoke all on public.loyalty_transactions from anon, authenticated;
grant all on public.loyalty_transactions to service_role;
grant select on public.loyalty_transactions to authenticated;
create policy loyalty_select on public.loyalty_transactions for select to authenticated
  using (app.can_view_customer(tenant_id, customer_id));

create or replace function app.loyalty_balance(p_customer uuid, p_exclude_order uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(points), 0)::int from public.loyalty_transactions
  where customer_id = p_customer
    and not (p_exclude_order is not null and order_id = p_exclude_order and kind = 'redeem');
$$;

-- Same formula as pointsEarned() in src/domain/loyalty.ts.
create or replace function app.loyalty_points_for(p_total bigint, p_settings jsonb) returns int
language sql immutable as $$
  select case
    when not coalesce((p_settings #>> '{loyalty,enabled}')::boolean, false) or p_total <= 0 then 0
    when (p_settings #>> '{loyalty,min_order_cents}') is not null
         and p_total < (p_settings #>> '{loyalty,min_order_cents}')::bigint then 0
    when coalesce(p_settings #>> '{loyalty,earn_mode}', 'amount') = 'orders'
      then greatest(0, floor(coalesce((p_settings #>> '{loyalty,points_per_order}')::numeric, 10)))::int
    when coalesce((p_settings #>> '{loyalty,step_cents}')::bigint, 1000) <= 0 then 0
    else (floor(p_total / coalesce((p_settings #>> '{loyalty,step_cents}')::bigint, 1000))
          * greatest(0, floor(coalesce((p_settings #>> '{loyalty,points_per_step}')::numeric, 1))))::int
  end;
$$;

-- The earn row always matches the order's current state.
create or replace function app.loyalty_settle(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  o record;
  v_settings jsonb;
  v_points int;
begin
  select id, tenant_id, customer_id, status, payment_status, total_cents into o from public.orders where id = p_order;
  if not found then return; end if;

  if o.status = 'cancelled' then
    delete from public.loyalty_transactions where order_id = o.id and kind in ('earn', 'redeem');
    return;
  end if;

  select settings into v_settings from public.tenants where id = o.tenant_id;
  -- Turning the program off freezes history; it does not erase it.
  if not coalesce((v_settings #>> '{loyalty,enabled}')::boolean, false) then return; end if;

  v_points := case when o.status = 'delivered' and o.payment_status = 'paid'
                   then app.loyalty_points_for(o.total_cents, v_settings) else 0 end;
  if v_points > 0 then
    insert into public.loyalty_transactions (tenant_id, customer_id, order_id, kind, points)
    values (o.tenant_id, o.customer_id, o.id, 'earn', v_points)
    on conflict (order_id, kind) where kind in ('earn', 'redeem')
    do update set points = excluded.points, customer_id = excluded.customer_id
    where loyalty_transactions.points is distinct from excluded.points
       or loyalty_transactions.customer_id is distinct from excluded.customer_id;
  else
    delete from public.loyalty_transactions where order_id = o.id and kind = 'earn';
  end if;
end $$;

create or replace function app.orders_loyalty() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.loyalty_settle(new.id);
  return new;
end $$;

create trigger orders_loyalty after update of status, payment_status, total_cents, customer_id on public.orders
  for each row execute function app.orders_loyalty();

-- Manual adjustments (goodwill, corrections, migrating balances).
create or replace function public.adjust_loyalty_points(p_customer uuid, p_points int, p_note text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_tenant uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant from public.customers where id = p_customer;
  if v_tenant is null then
    raise exception using errcode = 'P0002', message = 'customer not found';
  end if;
  perform app.require_permission(v_tenant, 'loyalty.manage');
  if p_points is null or p_points = 0 then
    raise exception using errcode = '22023', message = 'points must not be zero';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;
  if app.loyalty_balance(p_customer, null) + p_points < 0 then
    raise exception using errcode = '22023', message = 'not enough loyalty points';
  end if;
  insert into public.loyalty_transactions (tenant_id, customer_id, kind, points, note, created_by)
  values (v_tenant, p_customer, 'adjust', p_points, btrim(p_note), app.current_actor())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.adjust_loyalty_points(uuid, int, text) from public, anon;
grant execute on function public.adjust_loyalty_points(uuid, int, text) to authenticated;
revoke all on function app.loyalty_balance(uuid, uuid), app.loyalty_points_for(bigint, jsonb), app.loyalty_settle(uuid) from public, anon, authenticated;

-- ── Orders: redemption ──────────────────────────────────────────────────────

create or replace function public.svc_save_order(p_actor uuid, p_tenant uuid, p_order jsonb, p_pricing jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_id uuid := app.try_uuid(p_order ->> 'id');
  v_existing record;
  v_is_new boolean := app.try_uuid(p_order ->> 'id') is null;
  v_number bigint;
  v_customer uuid := app.try_uuid(p_order ->> 'customer_id');
  v_pickup uuid := app.try_uuid(p_order ->> 'pickup_address_id');
  v_delivery uuid := app.try_uuid(p_order ->> 'delivery_address_id');
  v_zone uuid := app.try_uuid(p_order ->> 'delivery_zone_id');
  v_subtotal bigint := (p_pricing ->> 'subtotal_cents')::bigint;
  v_discount bigint := (p_pricing ->> 'discount_cents')::bigint;
  v_fee bigint := (p_pricing ->> 'delivery_fee_cents')::bigint;
  v_tax bigint := (p_pricing ->> 'tax_cents')::bigint;
  v_total bigint := (p_pricing ->> 'total_cents')::bigint;
  v_points int := coalesce((p_pricing ->> 'points_redeemed')::int, 0);
  v_credit bigint := coalesce((p_pricing ->> 'credit_cents')::bigint, 0);
  v_settings jsonb;
  v_lines_net bigint;
  v_override boolean := coalesce((p_order ->> 'delivery_fee_override')::boolean, false);
  v_token text;
begin
  perform app.act_as(p_actor, 'user');

  if v_id is null then
    perform app.require_permission(p_tenant, 'orders.create');
  else
    select * into v_existing from public.orders where id = v_id and tenant_id = p_tenant for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'order not found';
    end if;
    perform app.require_permission(p_tenant, 'orders.edit');
    -- Orders stay editable at any stage (corrections after delivery included);
    -- only cancelled orders are frozen.
    if v_existing.status = 'cancelled' then
      raise exception using errcode = '22023', message = 'a cancelled order cannot be edited';
    end if;
  end if;

  if v_override or exists (
    select 1 from jsonb_array_elements(p_pricing -> 'lines') l where l ->> 'product_id' is null
  ) then
    perform app.require_permission(p_tenant, 'orders.price_override');
  end if;

  if not exists (select 1 from public.customers where id = v_customer and tenant_id = p_tenant) then
    raise exception using errcode = '22023', message = 'customer not found';
  end if;
  if (v_pickup is not null and not exists (select 1 from public.customer_addresses where id = v_pickup and customer_id = v_customer))
     or (v_delivery is not null and not exists (select 1 from public.customer_addresses where id = v_delivery and customer_id = v_customer)) then
    raise exception using errcode = '22023', message = 'the address does not belong to the customer';
  end if;

  -- Defense in depth: the stored breakdown must add up.
  select coalesce(sum((l ->> 'net_cents')::bigint), 0) into v_lines_net from jsonb_array_elements(p_pricing -> 'lines') l;
  if v_total is null or v_total < 0 or v_fee < 0 or v_tax < 0 or v_discount < 0
     or v_lines_net <> v_subtotal - v_discount
     or v_points < 0 or v_credit < 0
     or v_total <> v_subtotal - v_discount - v_credit + v_fee + v_tax then
    raise exception using errcode = '22023', message = 'inconsistent pricing';
  end if;

  -- Loyalty redemption: the program must be on, the value must match the
  -- configured point value and the customer must have the points.
  if v_points > 0 then
    select settings into v_settings from public.tenants where id = p_tenant;
    if not coalesce((v_settings #>> '{loyalty,enabled}')::boolean, false) then
      raise exception using errcode = '22023', message = 'the loyalty program is disabled';
    end if;
    if v_credit <> v_points * coalesce((v_settings #>> '{loyalty,point_value_cents}')::bigint, 100) then
      raise exception using errcode = '22023', message = 'inconsistent pricing';
    end if;
    if app.loyalty_balance(v_customer, v_id) < v_points then
      raise exception using errcode = '22023', message = 'not enough loyalty points';
    end if;
  elsif v_credit <> 0 then
    raise exception using errcode = '22023', message = 'inconsistent pricing';
  end if;

  if v_id is null then
    insert into public.order_counters (tenant_id, last_number) values (p_tenant, 1)
    on conflict (tenant_id) do update set last_number = public.order_counters.last_number + 1
    returning last_number into v_number;

    insert into public.orders (
      tenant_id, number, customer_id, fulfillment, priority, promised_at, notes, internal_notes,
      pickup_address_id, delivery_address_id, delivery_zone_id,
      subtotal_cents, discount_cents, delivery_fee_cents, tax_cents, total_cents,
      pricing, priced_at, delivery_fee_override, created_by, points_redeemed, loyalty_credit_cents
    ) values (
      p_tenant, v_number, v_customer,
      coalesce(p_order ->> 'fulfillment', 'delivery'),
      coalesce(p_order ->> 'priority', 'normal'),
      (p_order ->> 'promised_at')::timestamptz,
      p_order ->> 'notes', p_order ->> 'internal_notes',
      v_pickup, v_delivery, v_zone,
      v_subtotal, v_discount, v_fee, v_tax, v_total,
      p_pricing, now(), v_override, p_actor, v_points, v_credit
    ) returning id, public_token into v_id, v_token;
  else
    update public.orders set
      customer_id = v_customer,
      fulfillment = coalesce(p_order ->> 'fulfillment', fulfillment),
      priority = coalesce(p_order ->> 'priority', priority),
      promised_at = (p_order ->> 'promised_at')::timestamptz,
      notes = p_order ->> 'notes',
      internal_notes = p_order ->> 'internal_notes',
      pickup_address_id = v_pickup,
      delivery_address_id = v_delivery,
      delivery_zone_id = v_zone,
      subtotal_cents = v_subtotal, discount_cents = v_discount, delivery_fee_cents = v_fee,
      tax_cents = v_tax, total_cents = v_total,
      pricing = p_pricing, priced_at = now(), delivery_fee_override = v_override,
      points_redeemed = v_points, loyalty_credit_cents = v_credit
    where id = v_id
    returning number, public_token into v_number, v_token;
    delete from public.order_items where order_id = v_id;
    delete from public.order_discounts where order_id = v_id;
  end if;

  insert into public.order_items (
    tenant_id, order_id, position, product_id, sku, name, unit, quantity, unit_price_cents,
    list_total_cents, volume_rule_id, volume_savings_cents, gross_cents, discount_cents, net_cents,
    taxable, custom_price, notes
  )
  select p_tenant, v_id, (l ->> 'index')::int + 1, app.try_uuid(l ->> 'product_id'), l ->> 'sku', l ->> 'name', l ->> 'unit',
         (l ->> 'quantity')::numeric, (l ->> 'unit_price_cents')::bigint, (l ->> 'list_total_cents')::bigint,
         app.try_uuid(l ->> 'volume_rule_id'), (l ->> 'volume_savings_cents')::bigint, (l ->> 'gross_cents')::bigint,
         (l ->> 'discount_cents')::bigint, (l ->> 'net_cents')::bigint, (l ->> 'taxable')::boolean,
         (l ->> 'custom_price')::boolean, l ->> 'notes'
  from jsonb_array_elements(p_pricing -> 'lines') l;

  insert into public.order_discounts (tenant_id, order_id, discount_id, name, amount_cents)
  select p_tenant, v_id, (d ->> 'id')::uuid, d ->> 'name', (d ->> 'amount_cents')::bigint
  from jsonb_array_elements(coalesce(p_pricing -> 'applied_discounts', '[]'::jsonb)) d
  where exists (select 1 from public.discounts x where x.id = (d ->> 'id')::uuid and x.tenant_id = p_tenant);

  if v_points > 0 then
    insert into public.loyalty_transactions (tenant_id, customer_id, order_id, kind, points, created_by)
    values (p_tenant, v_customer, v_id, 'redeem', -v_points, p_actor)
    on conflict (order_id, kind) where kind in ('earn', 'redeem')
    do update set points = excluded.points, customer_id = excluded.customer_id;
  else
    delete from public.loyalty_transactions where order_id = v_id and kind = 'redeem';
  end if;

  -- Items are written after the order row: settle the payment state now.
  perform app.recompute_order_payment(v_id);

  if v_is_new then
    perform app.enqueue_notification(v_id, 'order_created');
  end if;

  return jsonb_build_object('id', v_id, 'number', v_number, 'public_token', v_token);
end $$;

-- ── Public tracking: points earned and balance ──────────────────────────────

create or replace function public.get_public_order(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  o record;
  v jsonb;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into o from public.orders where public_token = p_token;
  if not found then return null; end if;

  select jsonb_build_object(
    'number', o.number,
    'status', o.status,
    'fulfillment', o.fulfillment,
    'created_at', o.created_at,
    'promised_at', o.promised_at,
    'delivered_at', o.delivered_at,
    'notes', o.notes,
    'currency', t.currency,
    'locale', coalesce(t.settings ->> 'locale', 'es-MX'),
    'business', jsonb_build_object('name', t.name, 'phone', t.phone, 'email', t.email, 'logo_url', t.logo_url, 'address', t.address),
    'customer_first_name', split_part(btrim(c.name), ' ', 1),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'unit', i.unit, 'net_cents', i.net_cents, 'gross_cents', i.gross_cents) order by i.position)
      from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'breakdown', coalesce(o.pricing -> 'steps', '[]'::jsonb),
    'total_cents', o.total_cents,
    'amount_paid_cents', o.amount_paid_cents,
    'balance_cents', o.balance_cents,
    'payment_status', o.payment_status,
    'production', coalesce((
      select jsonb_agg(jsonb_build_object('name', s.name, 'status', s.status, 'completed_at', s.completed_at) order by s.position)
      from public.order_production_steps s where s.order_id = o.id and s.status <> 'skipped'), '[]'::jsonb),
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object('type', d.type, 'status', d.status, 'date', d.scheduled_date,
        'window', d.window_label, 'completed_at', d.completed_at) order by d.scheduled_date, d.type)
      from public.deliveries d where d.order_id = o.id and d.status <> 'cancelled'), '[]'::jsonb),
    'loyalty', case when coalesce((t.settings #>> '{loyalty,enabled}')::boolean, false) then jsonb_build_object(
      'points_earned', coalesce((select points from public.loyalty_transactions where order_id = o.id and kind = 'earn'), 0),
      'points_redeemed', o.points_redeemed,
      'balance', app.loyalty_balance(o.customer_id, null),
      'point_value_cents', coalesce((t.settings #>> '{loyalty,point_value_cents}')::bigint, 100)
    ) end,
    'online_payment', exists (
      select 1 from public.tenant_integrations ti
      where ti.tenant_id = o.tenant_id and ti.provider = 'mercadopago' and ti.enabled)
  ) into v
  from public.tenants t, public.customers c
  where t.id = o.tenant_id and c.id = o.customer_id;
  return v;
end $$;

-- ── Customer 360: points balance ────────────────────────────────────────────

create or replace view public.customer_overview with (security_invoker = true) as
select
  c.id, c.tenant_id, c.name, c.phone, c.phone_normalized, c.email, c.notes, c.tags, c.archived_at, c.created_at,
  coalesce(s.total_orders, 0)::int as total_orders,
  coalesce(s.lifetime_spend_cents, 0)::bigint as lifetime_spend_cents,
  case when coalesce(s.total_orders, 0) > 0 then (s.lifetime_spend_cents / s.total_orders)::bigint else 0 end as avg_order_cents,
  s.last_order_at,
  s.first_order_at,
  coalesce(s.balance_due_cents, 0)::bigint as balance_due_cents,
  app.customer_status(coalesce(s.total_orders, 0)::int, s.last_order_at, t.settings) as status,
  coalesce((select sum(l.points) from public.loyalty_transactions l where l.customer_id = c.id), 0)::int as points_balance
from public.customers c
join public.tenants t on t.id = c.tenant_id
left join lateral (
  select count(*) as total_orders,
         sum(o.total_cents) as lifetime_spend_cents,
         max(o.created_at) as last_order_at,
         min(o.created_at) as first_order_at,
         sum(o.balance_cents) as balance_due_cents
  from public.orders o
  where o.customer_id = c.id and o.status <> 'cancelled'
) s on true;
