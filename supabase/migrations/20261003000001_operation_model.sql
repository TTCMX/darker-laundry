-- ============================================================================
-- Operation model: counter only, home delivery only, or hybrid
--   * Each business chooses how it operates; the app shows only the features
--     that apply and the database refuses the rest:
--       walk_in  — counter only: no pickups, deliveries, routes or couriers.
--       delivery — everything is picked up and delivered at home.
--       hybrid   — both (orders are labelled home delivery / counter).
--   * It is part of the plan (each model is priced differently): during the
--     free trial (and on internal businesses) the owner can switch freely;
--     on a paid plan it comes from the plan and is changed by changing plan.
--   * Existing businesses: hybrid. Orders that already exist keep working.
--   * Platform admin (SQL editor), e.g. a paid counter-only plan:
--       update public.tenants set plan = 'walk_in', operation_model = 'walk_in' where slug = '…';
-- ============================================================================

alter table public.tenants add column if not exists operation_model text not null default 'hybrid'
  check (operation_model in ('walk_in', 'delivery', 'hybrid'));
-- Not in the column grants: changed only through set_operation_model.

create or replace function app.operation_model(p_tenant uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select operation_model from public.tenants where id = p_tenant), 'hybrid');
$$;

create or replace function public.set_operation_model(p_tenant uuid, p_model text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  t record;
  v_open int;
begin
  perform app.require_permission(p_tenant, 'settings.manage');
  if p_model not in ('walk_in', 'delivery', 'hybrid') then
    raise exception using errcode = '22023', message = 'invalid operation model';
  end if;
  select * into t from public.tenants where id = p_tenant for update;
  if t.operation_model = p_model then return; end if;
  if t.plan not in ('trial', 'internal') then
    raise exception using errcode = '42501', message = 'the operation model comes from your plan';
  end if;
  -- Don't strand orders that are still in progress.
  select count(*) into v_open from public.orders
  where tenant_id = p_tenant and status not in ('delivered', 'cancelled')
    and ((p_model = 'walk_in' and fulfillment = 'delivery') or (p_model = 'delivery' and fulfillment = 'walk_in'));
  if v_open > 0 then
    raise exception using errcode = '22023', message = format('open orders of the other kind: %s', v_open);
  end if;
  update public.tenants set operation_model = p_model where id = p_tenant;
end $$;

revoke all on function public.set_operation_model(uuid, text) from public, anon;
grant execute on function public.set_operation_model(uuid, text) to authenticated;
revoke all on function app.operation_model(uuid) from public, anon, authenticated;

-- New orders (or a change of type) must fit the model.
create or replace function app.orders_check_fulfillment() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  v_model text := app.operation_model(new.tenant_id);
begin
  if v_model = 'walk_in' and new.fulfillment = 'delivery' then
    raise exception using errcode = '22023', message = 'home delivery is not enabled for this business';
  elsif v_model = 'delivery' and new.fulfillment = 'walk_in' then
    raise exception using errcode = '22023', message = 'counter orders are not enabled for this business';
  end if;
  return new;
end $$;

drop trigger if exists orders_check_fulfillment_ins on public.orders;
create trigger orders_check_fulfillment_ins before insert on public.orders
  for each row execute function app.orders_check_fulfillment();
drop trigger if exists orders_check_fulfillment_upd on public.orders;
create trigger orders_check_fulfillment_upd before update of fulfillment on public.orders
  for each row when (old.fulfillment is distinct from new.fulfillment) execute function app.orders_check_fulfillment();

-- Counter-only businesses have no pickups or deliveries.
create or replace function app.deliveries_check_model() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.operation_model(new.tenant_id) = 'walk_in' then
    raise exception using errcode = '22023', message = 'home delivery is not enabled for this business';
  end if;
  return new;
end $$;

drop trigger if exists deliveries_check_model on public.deliveries;
create trigger deliveries_check_model before insert on public.deliveries
  for each row execute function app.deliveries_check_model();

create or replace function public.my_memberships() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'member_id', m.id,
    'tenant_id', t.id,
    'tenant_name', t.name,
    'slug', t.slug,
    'logo_url', t.logo_url,
    'country', t.country,
    'currency', t.currency,
    'timezone', t.timezone,
    'settings', t.settings,
    'display_name', m.display_name,
    'role_id', r.id,
    'role_name', r.name,
    'role_home', r.home,
    'is_owner', r.is_owner,
    'permissions', case when r.is_owner
      then (select jsonb_agg(code order by code) from public.permissions)
      else coalesce((select jsonb_agg(rp.permission order by rp.permission) from public.role_permissions rp where rp.role_id = r.id), '[]'::jsonb)
    end,
    'plan', t.plan,
    'plan_status', t.plan_status,
    'created_at', t.created_at,
    'trial_ends_at', t.trial_ends_at,
    'access', app.tenant_access(t.id),
    'operation_model', t.operation_model
  ) order by t.name), '[]'::jsonb)
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  join public.roles r on r.id = m.role_id
  where m.user_id = auth.uid() and m.active;
$$;
