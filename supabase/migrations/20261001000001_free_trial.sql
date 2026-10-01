-- ============================================================================
-- Free trial (first testers)
--   * Every business gets 3 months free from the moment it registers, with
--     every feature. Existing businesses: 3 months from their registration.
--   * When the trial ends (or a subscription is suspended / cancelled) the
--     business becomes read-only: everyone can still see and export their
--     data, the owner can still manage settings and team, but nothing
--     operational can be created or changed. Enforced here, in the
--     permission check every RLS policy and function goes through.
--   * Public order tracking and online payments from customers keep working.
--   * Platform admin (SQL editor):
--       extend:  update public.tenants set trial_ends_at = trial_ends_at + interval '1 month' where slug = '…';
--       exempt:  update public.tenants set plan = 'internal' where slug = '…';
-- ============================================================================

alter table public.tenants add column if not exists trial_ends_at timestamptz;
update public.tenants set trial_ends_at = created_at + interval '3 months' where trial_ends_at is null and plan = 'trial';
alter table public.tenants alter column trial_ends_at set default (now() + interval '3 months');
-- Not in the column grants: businesses cannot extend their own trial.

-- 'full' or 'read_only'.
create or replace function app.tenant_access(p_tenant uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when t.plan_status in ('suspended', 'cancelled') then 'read_only'
    when t.plan = 'trial' and t.trial_ends_at is not null and t.trial_ends_at <= now() then 'read_only'
    else 'full' end
  from public.tenants t where t.id = p_tenant;
$$;

-- Permissions that still work in read-only mode (same rule as src/domain/plan.ts).
create or replace function app.allowed_read_only(p_permission text) returns boolean
language sql immutable as $$
  select p_permission like '%.view' or p_permission in ('settings.manage', 'team.manage');
$$;

create or replace function app.user_has_permission(p_user uuid, p_tenant uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.roles r on r.id = m.role_id
    where m.tenant_id = p_tenant and m.user_id = p_user and m.active
      and (r.is_owner or exists (
        select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission = p_permission
      ))
  ) and (app.allowed_read_only(p_permission) or app.tenant_access(p_tenant) = 'full');
$$;

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
    'access', app.tenant_access(t.id)
  ) order by t.name), '[]'::jsonb)
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  join public.roles r on r.id = m.role_id
  where m.user_id = auth.uid() and m.active;
$$;

revoke all on function app.tenant_access(uuid) from public, anon, authenticated;
