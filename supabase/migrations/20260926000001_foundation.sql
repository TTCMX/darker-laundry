-- ============================================================================
-- Dark Laundry OS · 0001 · Foundation
-- Extensions, private `app` schema, utilities, tenants and the audit log.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- Private schema: helpers used by policies and RPCs. It is NOT exposed through
-- the Data API, so nothing in here can be called directly by clients.
create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- Supabase grants every new table/function in `public` to anon and
-- authenticated by default. We flip that: nothing is reachable unless a
-- migration grants it explicitly (see 0010_security.sql).
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- EXECUTE for PUBLIC is a global default, so it can only be revoked globally.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ── Utilities ───────────────────────────────────────────────────────────────

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- Same algorithm as src/domain/phone.ts (both are covered by the same cases).
create or replace function app.normalize_phone(p_raw text, p_country text default 'MX') returns text
language plpgsql immutable as $$
declare
  d text;
  trimmed text;
  has_plus boolean;
  v_cc text;
  v_len int;
begin
  if p_raw is null or btrim(p_raw) = '' then return null; end if;
  trimmed := btrim(p_raw);
  d := regexp_replace(trimmed, '\D', '', 'g');
  if d = '' then return null; end if;
  has_plus := left(trimmed, 1) = '+' or left(trimmed, 2) = '00';
  if left(d, 2) = '00' then d := substr(d, 3); end if;

  select c.cc, c.len into v_cc, v_len
  from (values ('MX','52',10), ('US','1',10), ('CA','1',10), ('CO','57',10),
               ('ES','34',9), ('AR','54',10), ('CL','56',9), ('PE','51',9)) as c(iso, cc, len)
  where c.iso = upper(coalesce(p_country, 'MX'));
  if v_cc is null then v_cc := '52'; v_len := 10; end if;

  if not has_plus and length(d) = v_len then return '+' || v_cc || d; end if;
  if left(d, 3) = '521' and length(d) = 13 then return '+52' || substr(d, 4); end if;
  if left(d, length(v_cc)) = v_cc and length(d) = length(v_cc) + v_len then return '+' || d; end if;
  if has_plus and length(d) between 8 and 15 then return '+' || d; end if;
  return null;
end $$;

-- ── Actor context ───────────────────────────────────────────────────────────
-- Requests from the app carry a Supabase JWT (auth.uid()). Server functions
-- run with the service role and declare who they act for via
-- `app.act_as(user_id, type)`, which only service-role code can reach.

-- An explicit act_as (only reachable from service-role functions) wins over
-- the JWT: server code acting for a user must never be confused with itself.
create or replace function app.current_actor() returns uuid
language sql stable as $$
  select coalesce(app.try_uuid(nullif(current_setting('app.actor_id', true), '')), auth.uid());
$$;

create or replace function app.current_actor_type() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('app.actor_type', true), ''),
    case when auth.uid() is not null then 'user' else 'system' end
  );
$$;

create or replace function app.act_as(p_actor uuid, p_type text default 'user') returns void
language plpgsql as $$
begin
  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  perform set_config('app.actor_type', coalesce(p_type, 'system'), true);
end $$;

-- Optional note attached to the audit entries written in this transaction.
create or replace function app.set_audit_context(p_context jsonb) returns void
language plpgsql as $$
begin
  perform set_config('app.audit_context', coalesce(p_context::text, ''), true);
end $$;

create or replace function app.raise_forbidden(p_message text default 'forbidden') returns void
language plpgsql as $$
begin
  raise exception using errcode = '42501', message = p_message;
end $$;

-- ── Tenants ─────────────────────────────────────────────────────────────────

create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  legal_name  text,
  tax_id      text,
  phone       text,
  email       text,
  address     text,
  logo_url    text,
  country     text not null default 'MX',
  currency    text not null default 'MXN',
  timezone    text not null default 'America/Mexico_City',
  settings    jsonb not null default '{}'::jsonb,
  plan        text not null default 'trial',
  plan_status text not null default 'active' check (plan_status in ('active', 'past_due', 'suspended', 'cancelled')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger tenants_touch before update on public.tenants
  for each row execute function app.touch_updated_at();

create or replace function app.tenant_today(p_tenant uuid) returns date
language sql stable as $$
  select (now() at time zone coalesce((select timezone from public.tenants where id = p_tenant), 'UTC'))::date;
$$;

-- ── Audit log ───────────────────────────────────────────────────────────────
-- Append-only. Written by triggers (row changes) inside the same transaction
-- as the change itself, so nothing is changed without a record.

create table public.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  actor_type  text not null default 'user' check (actor_type in ('user', 'system', 'customer', 'webhook')),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  order_id    uuid,
  before      jsonb,
  after       jsonb,
  context     jsonb
);

create index audit_log_tenant_time on public.audit_log (tenant_id, occurred_at desc);
create index audit_log_entity on public.audit_log (tenant_id, entity_type, entity_id);
create index audit_log_order on public.audit_log (tenant_id, order_id, occurred_at) where order_id is not null;

-- Columns never copied into the audit log.
create or replace function app.audit_redact(p jsonb) returns jsonb
language sql immutable as $$
  select case when p is null then null else p - 'public_token' - 'updated_at' - 'pricing' end;
$$;

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  k text;
  v_tenant uuid;
  v_id uuid;
  v_order uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := app.audit_redact(to_jsonb(old)); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := app.audit_redact(to_jsonb(new)); end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if (v_old -> k) is distinct from (v_new -> k) then
        v_before := v_before || jsonb_build_object(k, v_old -> k);
        v_after := v_after || jsonb_build_object(k, v_new -> k);
      end if;
    end loop;
    if v_after = '{}'::jsonb then return new; end if;
  else
    v_before := v_old;
    v_after := v_new;
  end if;

  v_tenant := coalesce(v_new ->> 'tenant_id', v_old ->> 'tenant_id')::uuid;
  v_id := app.try_uuid(coalesce(v_new ->> 'id', v_old ->> 'id'));
  v_order := case when tg_table_name = 'orders' then v_id
                  else app.try_uuid(coalesce(v_new ->> 'order_id', v_old ->> 'order_id')) end;

  -- Deleting a tenant cascades through everything; there is nothing to audit into.
  if not exists (select 1 from public.tenants where id = v_tenant) then
    return coalesce(new, old);
  end if;

  insert into public.audit_log (tenant_id, actor_id, actor_type, action, entity_type, entity_id, order_id, before, after, context)
  values (
    v_tenant, app.current_actor(), app.current_actor_type(), lower(tg_op), tg_table_name, v_id, v_order,
    case when tg_op = 'INSERT' then null else v_before end,
    case when tg_op = 'DELETE' then null else v_after end,
    app.try_jsonb(current_setting('app.audit_context', true))
  );
  return coalesce(new, old);
end $$;

create or replace function app.try_jsonb(p text) returns jsonb
language plpgsql immutable as $$
begin
  if p is null or p = '' then return null; end if;
  return p::jsonb;
exception when others then
  return null;
end $$;

-- Explicit domain events ("order.status_changed", "payment.recorded"...) that
-- are easier to read than raw row diffs on a timeline.
create or replace function app.log_event(
  p_tenant uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_order uuid default null, p_before jsonb default null, p_after jsonb default null
) returns void
language sql security definer set search_path = public, app as $$
  insert into public.audit_log (tenant_id, actor_id, actor_type, action, entity_type, entity_id, order_id, before, after, context)
  values (p_tenant, app.current_actor(), app.current_actor_type(), p_action, p_entity_type, p_entity_id, p_order,
          p_before, p_after, app.try_jsonb(current_setting('app.audit_context', true)));
$$;

create trigger tenants_audit after update on public.tenants
  for each row execute function app.audit_row();
