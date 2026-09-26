-- ============================================================================
-- 0002 · Roles & permissions (RBAC)
-- Permissions are a fixed catalog (each one guards code). Roles are per-tenant
-- data: a laundry can create its own roles from these permissions.
-- ============================================================================

create table public.permissions (
  code        text primary key,
  description text not null
);

-- Keep in sync with src/domain/permissions.ts (a unit test checks it).
insert into public.permissions (code, description) values
  ('dashboard.view', 'Ver dashboard'),
  ('orders.view', 'Ver órdenes'),
  ('orders.create', 'Crear órdenes'),
  ('orders.edit', 'Editar órdenes y cambiar estado'),
  ('orders.cancel', 'Cancelar órdenes'),
  ('orders.price_override', 'Precios manuales y envío sin costo'),
  ('customers.view', 'Ver clientes'),
  ('customers.edit', 'Crear y editar clientes'),
  ('production.view', 'Ver producción'),
  ('production.work', 'Trabajar fases de producción'),
  ('production.manage', 'Asignar y reasignar producción'),
  ('quality.report', 'Reportar incidencias'),
  ('quality.manage', 'Resolver incidencias'),
  ('delivery.view', 'Ver entregas y rutas'),
  ('delivery.manage', 'Planear rutas y asignar couriers'),
  ('delivery.execute', 'Ejecutar rutas (courier)'),
  ('payments.view', 'Ver pagos'),
  ('payments.record', 'Registrar pagos'),
  ('payments.refund', 'Reembolsar pagos'),
  ('catalog.manage', 'Administrar catálogo'),
  ('pricing.manage', 'Administrar precios, descuentos y zonas'),
  ('team.manage', 'Administrar equipo y roles'),
  ('settings.manage', 'Administrar configuración'),
  ('notifications.send', 'Enviar notificaciones manuales'),
  ('audit.view', 'Ver bitácora');

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name        text not null check (length(btrim(name)) between 1 and 60),
  description text,
  -- The owner role always has every permission, including future ones.
  is_owner    boolean not null default false,
  is_system   boolean not null default false,
  -- Where members of this role land after login: back office or courier app.
  home        text not null default 'backoffice' check (home in ('backoffice', 'courier')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create unique index roles_one_owner_per_tenant on public.roles (tenant_id) where is_owner;

create table public.role_permissions (
  tenant_id  uuid not null,
  role_id    uuid not null,
  permission text not null references public.permissions(code) on delete cascade,
  primary key (role_id, permission),
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id) on delete cascade
);

create table public.tenant_members (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role_id      uuid not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  phone        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, id),
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id)
);

create index tenant_members_user on public.tenant_members (user_id) where active;

create table public.tenant_invitations (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  token        text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  email        text,
  role_id      uuid not null,
  display_name text,
  invited_by   uuid,
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  accepted_by  uuid,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id) on delete cascade
);

create index tenant_invitations_tenant on public.tenant_invitations (tenant_id, created_at desc);

create trigger roles_touch before update on public.roles for each row execute function app.touch_updated_at();
create trigger members_touch before update on public.tenant_members for each row execute function app.touch_updated_at();

create trigger roles_audit after insert or update or delete on public.roles for each row execute function app.audit_row();
create trigger role_permissions_audit after insert or delete on public.role_permissions for each row execute function app.audit_row();
create trigger members_audit after insert or update or delete on public.tenant_members for each row execute function app.audit_row();
create trigger invitations_audit after insert or update on public.tenant_invitations for each row execute function app.audit_row();

-- ── Access helpers ──────────────────────────────────────────────────────────
-- SECURITY DEFINER so policies can call them without recursing into the RLS
-- of tenant_members. Every check is scoped to the tenant of the row being
-- accessed, so one user can belong to several tenants without ambiguity.

create or replace function app.user_is_member(p_user uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant and m.user_id = p_user and m.active
  );
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
  );
$$;

create or replace function app.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.user_is_member(app.current_actor(), p_tenant);
$$;

create or replace function app.has_permission(p_tenant uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select app.user_has_permission(app.current_actor(), p_tenant, p_permission);
$$;

create or replace function app.is_owner(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m join public.roles r on r.id = m.role_id
    where m.tenant_id = p_tenant and m.user_id = app.current_actor() and m.active and r.is_owner
  );
$$;

create or replace function app.require_permission(p_tenant uuid, p_permission text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if app.current_actor() is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not app.has_permission(p_tenant, p_permission) then
    raise exception using errcode = '42501', message = format('missing permission %s', p_permission);
  end if;
end $$;

-- A tenant must always keep at least one active owner.
create or replace function app.guard_last_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if not exists (select 1 from public.tenants where id = v_tenant) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from public.tenant_members m join public.roles r on r.id = m.role_id
    where m.tenant_id = v_tenant and m.active and r.is_owner
  ) then
    raise exception using errcode = '23514', message = 'a tenant must keep at least one active owner';
  end if;
  return coalesce(new, old);
end $$;

create constraint trigger members_keep_owner after update or delete on public.tenant_members
  for each row execute function app.guard_last_owner();
