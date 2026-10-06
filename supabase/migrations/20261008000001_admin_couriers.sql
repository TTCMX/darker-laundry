-- ============================================================================
-- No couriers? Administrative staff can take the route
--   * team_members() tells which members can run deliveries (can_deliver):
--     the courier picker falls back to them when the business has no one
--     with the Courier role (Dueño, Gerente and any role with
--     delivery.execute; app.check_courier already accepts them).
--   * The automatic assignment uses the only courier, or, when there are
--     none, the only member who can run deliveries (e.g. an owner working
--     alone).
-- ============================================================================

create or replace function public.team_members(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select case when app.is_member(p_tenant) then coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'user_id', m.user_id, 'display_name', m.display_name, 'phone', m.phone,
    'active', m.active, 'role_id', m.role_id, 'role_name', r.name, 'role_home', r.home, 'is_owner', r.is_owner,
    'can_deliver', m.active and (r.is_owner or exists (
      select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission = 'delivery.execute')),
    'email', case when app.has_permission(p_tenant, 'team.manage') then u.email end
  ) order by m.active desc, m.display_name), '[]'::jsonb) else '[]'::jsonb end
  from public.tenant_members m
  join public.roles r on r.id = m.role_id
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant;
$$;

create or replace function app.single_courier(p_tenant uuid) returns uuid
language sql stable security definer set search_path = public as $$
  with couriers as (
    select m.user_id from public.tenant_members m join public.roles r on r.id = m.role_id
    where m.tenant_id = p_tenant and m.active and r.home = 'courier'
  ), staff as (
    select m.user_id from public.tenant_members m join public.roles r on r.id = m.role_id
    where m.tenant_id = p_tenant and m.active and r.home <> 'courier'
      and app.user_has_permission(m.user_id, p_tenant, 'delivery.execute')
  )
  select case
    when (select count(*) from couriers) = 1 then (select user_id from couriers)
    when (select count(*) from couriers) = 0 and (select count(*) from staff) = 1 then (select user_id from staff)
  end;
$$;
