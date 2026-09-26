-- ============================================================================
-- 0007 · Tenant onboarding, team management, public tracking, reporting
-- ============================================================================

-- ── Tenant seed ─────────────────────────────────────────────────────────────
-- Sensible defaults so a new laundry can operate on day one. Everything here
-- is data the tenant can change afterwards.

create or replace function app.seed_tenant(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_role uuid;
  v_workflow uuid;
begin
  insert into public.roles (tenant_id, key, name, description, is_owner, is_system)
  values (p_tenant, 'owner', 'Dueño', 'Acceso total', true, true)
  returning id into v_owner;

  insert into public.roles (tenant_id, key, name, description, is_system)
  values (p_tenant, 'manager', 'Gerente', 'Operación, clientes y reportes', true)
  returning id into v_role;
  insert into public.role_permissions (tenant_id, role_id, permission)
  select p_tenant, v_role, code from public.permissions
  where code not in ('team.manage', 'settings.manage');

  insert into public.roles (tenant_id, key, name, description, is_system)
  values (p_tenant, 'front_desk', 'Mostrador', 'Órdenes, clientes y cobros', true)
  returning id into v_role;
  insert into public.role_permissions (tenant_id, role_id, permission)
  select p_tenant, v_role, unnest(array[
    'dashboard.view', 'orders.view', 'orders.create', 'orders.edit', 'customers.view', 'customers.edit',
    'production.view', 'delivery.view', 'payments.view', 'payments.record', 'quality.report', 'notifications.send'
  ]);

  insert into public.roles (tenant_id, key, name, description, is_system)
  values (p_tenant, 'production', 'Producción', 'Trabaja las fases de producción', true)
  returning id into v_role;
  insert into public.role_permissions (tenant_id, role_id, permission)
  select p_tenant, v_role, unnest(array['production.view', 'production.work', 'quality.report']);

  insert into public.roles (tenant_id, key, name, description, is_system, home)
  values (p_tenant, 'driver', 'Courier', 'Rutas, recolecciones, entregas y cobro en ruta', true, 'courier')
  returning id into v_role;
  insert into public.role_permissions (tenant_id, role_id, permission)
  select p_tenant, v_role, unnest(array['delivery.execute', 'quality.report']);

  insert into public.workflows (tenant_id, name, is_default)
  values (p_tenant, 'Estándar', true)
  returning id into v_workflow;
  insert into public.workflow_steps (tenant_id, workflow_id, name, position, estimated_minutes)
  values (p_tenant, v_workflow, 'Lavado', 1, 60),
         (p_tenant, v_workflow, 'Secado', 2, 45),
         (p_tenant, v_workflow, 'Doblado', 3, 30),
         (p_tenant, v_workflow, 'Control de calidad', 4, 10),
         (p_tenant, v_workflow, 'Empaque', 5, 10);

  insert into public.notification_templates (tenant_id, event, channel, subject, body, enabled, mode)
  select p_tenant, e.event, c.channel, e.subject, e.body,
         e.event <> 'production_update',
         case when c.channel = 'email' then 'auto' else 'manual' end
  from (values
    ('order_created', 'Recibimos tu orden #{{order_number}}',
     'Hola {{customer_name}}, registramos tu orden #{{order_number}} en {{business_name}}. Total: {{total}}. Síguela aquí: {{tracking_url}}'),
    ('pickup_scheduled', 'Recolección agendada',
     'Hola {{customer_name}}, pasaremos por tu ropa el {{pickup_date}} ({{pickup_window}}). Orden #{{order_number}}: {{tracking_url}}'),
    ('order_received', 'Tu ropa ya está con nosotros',
     'Hola {{customer_name}}, ya recibimos tu orden #{{order_number}}. Te avisamos cuando esté lista: {{tracking_url}}'),
    ('production_update', 'Avance de tu orden #{{order_number}}',
     'Hola {{customer_name}}, tu orden #{{order_number}} avanzó a: {{step}}. {{tracking_url}}'),
    ('order_ready', 'Tu orden #{{order_number}} está lista',
     'Hola {{customer_name}}, tu orden #{{order_number}} está lista. Saldo: {{balance}}. {{tracking_url}}'),
    ('out_for_delivery', 'Tu orden va en camino',
     'Hola {{customer_name}}, tu orden #{{order_number}} va en camino. {{tracking_url}}'),
    ('order_delivered', 'Orden entregada',
     'Hola {{customer_name}}, entregamos tu orden #{{order_number}}. ¡Gracias por confiar en {{business_name}}!'),
    ('payment_reminder', 'Saldo pendiente de tu orden #{{order_number}}',
     'Hola {{customer_name}}, tu orden #{{order_number}} tiene un saldo de {{balance}}. Puedes pagar aquí: {{tracking_url}}')
  ) as e(event, subject, body)
  cross join (values ('email'), ('whatsapp')) as c(channel);

  return v_owner;
end $$;

create or replace function public.create_tenant(
  p_name text,
  p_slug text,
  p_display_name text,
  p_country text default 'MX',
  p_currency text default 'MXN',
  p_timezone text default 'America/Mexico_City'
) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_user uuid := auth.uid();
  v_tenant uuid;
  v_owner_role uuid;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if (select count(*) from public.tenants where created_by = v_user) >= 5 then
    raise exception using errcode = '22023', message = 'tenant limit reached';
  end if;
  if exists (select 1 from public.tenants where slug = lower(p_slug)) then
    raise exception using errcode = '23505', message = 'this address is already taken';
  end if;

  insert into public.tenants (name, slug, country, currency, timezone, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), upper(p_country), upper(p_currency), p_timezone, v_user)
  returning id into v_tenant;

  v_owner_role := app.seed_tenant(v_tenant);

  insert into public.tenant_members (tenant_id, user_id, role_id, display_name)
  values (v_tenant, v_user, v_owner_role, coalesce(nullif(btrim(p_display_name), ''), 'Dueño'));

  return v_tenant;
end $$;

-- Everything the app needs to know about "me": tenants, role, permissions.
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
    end
  ) order by t.name), '[]'::jsonb)
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  join public.roles r on r.id = m.role_id
  where m.user_id = auth.uid() and m.active;
$$;

-- ── Invitations ─────────────────────────────────────────────────────────────

create or replace function public.create_invitation(
  p_tenant uuid, p_role uuid, p_email text default null, p_display_name text default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_owner_role boolean;
  v_id uuid;
  v_token text;
begin
  perform app.require_permission(p_tenant, 'team.manage');
  select is_owner into v_owner_role from public.roles where id = p_role and tenant_id = p_tenant;
  if v_owner_role is null then
    raise exception using errcode = 'P0002', message = 'role not found';
  end if;
  if v_owner_role and not app.is_owner(p_tenant) then
    perform app.raise_forbidden('only an owner can invite owners');
  end if;
  insert into public.tenant_invitations (tenant_id, email, role_id, display_name, invited_by)
  values (p_tenant, nullif(lower(btrim(coalesce(p_email, ''))), ''), p_role, nullif(btrim(coalesce(p_display_name, '')), ''), app.current_actor())
  returning id, token into v_id, v_token;
  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;

create or replace function public.get_invitation(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tenant_name', t.name,
    'role_name', r.name,
    'email', i.email,
    'display_name', i.display_name,
    'valid', i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  )
  from public.tenant_invitations i
  join public.tenants t on t.id = i.tenant_id
  join public.roles r on r.id = i.role_id
  where i.token = p_token;
$$;

create or replace function public.accept_invitation(p_token text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  i record;
  v_user uuid := auth.uid();
  v_email text;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  select * into i from public.tenant_invitations where token = p_token for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'invitation not found';
  end if;
  if i.accepted_at is not null or i.revoked_at is not null or i.expires_at < now() then
    raise exception using errcode = '22023', message = 'the invitation is no longer valid';
  end if;
  select lower(email) into v_email from auth.users where id = v_user;
  if i.email is not null and i.email <> v_email then
    raise exception using errcode = '42501', message = 'this invitation was sent to another email address';
  end if;

  insert into public.tenant_members (tenant_id, user_id, role_id, display_name)
  values (i.tenant_id, v_user, i.role_id,
          coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), i.display_name, split_part(v_email, '@', 1)))
  on conflict (tenant_id, user_id) do update set role_id = excluded.role_id, active = true;

  update public.tenant_invitations set accepted_at = now(), accepted_by = v_user where id = i.id;
  return i.tenant_id;
end $$;

create or replace function public.revoke_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.tenant_invitations where id = p_invitation;
  if v_tenant is null then
    raise exception using errcode = 'P0002', message = 'invitation not found';
  end if;
  perform app.require_permission(v_tenant, 'team.manage');
  update public.tenant_invitations set revoked_at = now() where id = p_invitation and accepted_at is null;
end $$;

-- ── Members & roles ─────────────────────────────────────────────────────────

create or replace function public.update_member(
  p_member uuid, p_role uuid default null, p_display_name text default null,
  p_phone text default null, p_active boolean default null
) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  m record;
  v_current_owner boolean;
  v_new_owner boolean;
begin
  select tm.*, r.is_owner into m from public.tenant_members tm join public.roles r on r.id = tm.role_id
  where tm.id = p_member for update of tm;
  if not found then
    raise exception using errcode = 'P0002', message = 'member not found';
  end if;
  perform app.require_permission(m.tenant_id, 'team.manage');

  v_current_owner := m.is_owner;
  if p_role is not null then
    select is_owner into v_new_owner from public.roles where id = p_role and tenant_id = m.tenant_id;
    if v_new_owner is null then
      raise exception using errcode = 'P0002', message = 'role not found';
    end if;
  end if;
  if (v_current_owner or coalesce(v_new_owner, false)) and not app.is_owner(m.tenant_id) then
    perform app.raise_forbidden('only an owner can change owners');
  end if;

  update public.tenant_members set
    role_id = coalesce(p_role, role_id),
    display_name = coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), display_name),
    phone = coalesce(p_phone, phone),
    active = coalesce(p_active, active)
  where id = p_member;
end $$;

create or replace function public.save_role(
  p_tenant uuid, p_role uuid, p_name text, p_description text, p_home text, p_permissions text[]
) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_role uuid := p_role;
  v_key text;
begin
  perform app.require_permission(p_tenant, 'team.manage');
  if exists (select 1 from unnest(coalesce(p_permissions, '{}')) p where p not in (select code from public.permissions)) then
    raise exception using errcode = '22023', message = 'unknown permission';
  end if;
  if v_role is null then
    v_key := left(regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g'), 30) || '_' || substr(md5(random()::text), 1, 6);
    v_key := regexp_replace(v_key, '^_+', '');
    insert into public.roles (tenant_id, key, name, description, home)
    values (p_tenant, v_key, btrim(p_name), p_description, coalesce(p_home, 'backoffice'))
    returning id into v_role;
  else
    if exists (select 1 from public.roles where id = v_role and tenant_id = p_tenant and is_owner) then
      perform app.raise_forbidden('the owner role cannot be edited');
    end if;
    update public.roles set name = btrim(p_name), description = p_description, home = coalesce(p_home, home)
    where id = v_role and tenant_id = p_tenant;
    if not found then
      raise exception using errcode = 'P0002', message = 'role not found';
    end if;
  end if;

  delete from public.role_permissions
  where role_id = v_role and not (permission = any (coalesce(p_permissions, '{}')));
  insert into public.role_permissions (tenant_id, role_id, permission)
  select p_tenant, v_role, p from unnest(coalesce(p_permissions, '{}')) p
  on conflict do nothing;
  return v_role;
end $$;

create or replace function public.delete_role(p_role uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  r record;
begin
  select * into r from public.roles where id = p_role;
  if not found then
    raise exception using errcode = 'P0002', message = 'role not found';
  end if;
  perform app.require_permission(r.tenant_id, 'team.manage');
  if r.is_owner then
    perform app.raise_forbidden('the owner role cannot be deleted');
  end if;
  if exists (select 1 from public.tenant_members where role_id = p_role) then
    raise exception using errcode = '22023', message = 'the role still has members';
  end if;
  delete from public.roles where id = p_role;
end $$;

create or replace function public.team_members(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select case when app.is_member(p_tenant) then coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'user_id', m.user_id, 'display_name', m.display_name, 'phone', m.phone,
    'active', m.active, 'role_id', m.role_id, 'role_name', r.name, 'role_home', r.home, 'is_owner', r.is_owner,
    'email', case when app.has_permission(p_tenant, 'team.manage') then u.email end
  ) order by m.active desc, m.display_name), '[]'::jsonb) else '[]'::jsonb end
  from public.tenant_members m
  join public.roles r on r.id = m.role_id
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant;
$$;

-- ── Public tracking ─────────────────────────────────────────────────────────
-- The customer-facing view of one order, by its unguessable token. Returns
-- only what the customer needs: no internal notes, no staff, no phone.

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
    'online_payment', exists (
      select 1 from public.tenant_integrations ti
      where ti.tenant_id = o.tenant_id and ti.provider = 'mercadopago' and ti.enabled)
  ) into v
  from public.tenants t, public.customers c
  where t.id = o.tenant_id and c.id = o.customer_id;
  return v;
end $$;

-- ── Customers overview ──────────────────────────────────────────────────────
-- Same thresholds as src/domain/customers.ts, read from tenant settings.

create or replace function app.customer_status(p_total int, p_last timestamptz, p_settings jsonb) returns text
language sql stable as $$
  with r as (
    select coalesce((p_settings #>> '{customers,status_rules,active_days}')::numeric, 30) as active_days,
           coalesce((p_settings #>> '{customers,status_rules,at_risk_days}')::numeric, 60) as at_risk_days,
           coalesce((p_settings #>> '{customers,status_rules,churned_days}')::numeric, 120) as churned_days,
           extract(epoch from (now() - p_last)) / 86400 as days
  )
  select case
    when p_last is null or p_total = 0 then 'new'
    when days <= active_days then case when p_total <= 1 then 'new' else 'active' end
    when days <= at_risk_days then 'at_risk'
    when days <= churned_days then 'inactive'
    else 'churned' end
  from r;
$$;

create view public.customer_overview with (security_invoker = true) as
select
  c.id, c.tenant_id, c.name, c.phone, c.phone_normalized, c.email, c.notes, c.tags, c.archived_at, c.created_at,
  coalesce(s.total_orders, 0)::int as total_orders,
  coalesce(s.lifetime_spend_cents, 0)::bigint as lifetime_spend_cents,
  case when coalesce(s.total_orders, 0) > 0 then (s.lifetime_spend_cents / s.total_orders)::bigint else 0 end as avg_order_cents,
  s.last_order_at,
  s.first_order_at,
  coalesce(s.balance_due_cents, 0)::bigint as balance_due_cents,
  app.customer_status(coalesce(s.total_orders, 0)::int, s.last_order_at, t.settings) as status
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

-- ── Dashboard ───────────────────────────────────────────────────────────────

create or replace function public.dashboard_summary(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_tz text;
  v_day date;
  v_from timestamptz;
  v_to timestamptz;
  v jsonb;
begin
  perform app.require_permission(p_tenant, 'dashboard.view');
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_day := app.tenant_today(p_tenant);
  v_from := v_day::timestamp at time zone v_tz;
  v_to := (v_day + 1)::timestamp at time zone v_tz;

  select jsonb_build_object(
    'day', v_day,
    'orders_today', (select count(*) from public.orders where tenant_id = p_tenant and created_at >= v_from and created_at < v_to and status <> 'cancelled'),
    'sales_today_cents', (select coalesce(sum(total_cents), 0) from public.orders where tenant_id = p_tenant and created_at >= v_from and created_at < v_to and status <> 'cancelled'),
    'collected_today_cents', (select coalesce(sum(case when kind = 'payment' then amount_cents else -amount_cents end), 0)
                              from public.payments where tenant_id = p_tenant and status = 'succeeded' and created_at >= v_from and created_at < v_to),
    'pickups_today', (select count(*) from public.deliveries where tenant_id = p_tenant and type = 'pickup' and scheduled_date = v_day and status <> 'cancelled'),
    'pickups_done_today', (select count(*) from public.deliveries where tenant_id = p_tenant and type = 'pickup' and scheduled_date = v_day and status = 'completed'),
    'deliveries_today', (select count(*) from public.deliveries where tenant_id = p_tenant and type = 'delivery' and scheduled_date = v_day and status <> 'cancelled'),
    'deliveries_done_today', (select count(*) from public.deliveries where tenant_id = p_tenant and type = 'delivery' and scheduled_date = v_day and status = 'completed'),
    'in_production', (select count(*) from public.orders where tenant_id = p_tenant and status = 'in_production'),
    'ready', (select count(*) from public.orders where tenant_id = p_tenant and status = 'ready'),
    'overdue', (select count(*) from public.orders where tenant_id = p_tenant and status not in ('delivered', 'cancelled') and promised_at < now()),
    'pending_payments_count', (select count(*) from public.orders where tenant_id = p_tenant and status <> 'cancelled' and balance_cents > 0),
    'pending_payments_cents', (select coalesce(sum(balance_cents), 0) from public.orders where tenant_id = p_tenant and status <> 'cancelled' and balance_cents > 0),
    'open_quality_issues', (select count(*) from public.quality_issues where tenant_id = p_tenant and status in ('open', 'in_progress')),
    'production', coalesce((
      select jsonb_agg(jsonb_build_object('step', x.name, 'count', x.n) order by x.pos)
      from (
        select s.name, min(s.position) as pos, count(*) as n
        from public.orders o join public.order_production_steps s on s.id = o.current_step_id
        where o.tenant_id = p_tenant and o.status = 'in_production'
        group by s.name
      ) x), '[]'::jsonb),
    'overdue_orders', coalesce((
      select jsonb_agg(x) from (
        select o.id, o.number, o.status, o.promised_at, c.name as customer_name
        from public.orders o join public.customers c on c.id = o.customer_id
        where o.tenant_id = p_tenant and o.status not in ('delivered', 'cancelled') and o.promised_at < now()
        order by o.promised_at limit 10) x), '[]'::jsonb),
    'failed_deliveries', coalesce((
      select jsonb_agg(x) from (
        select d.id, d.type, d.failure_reason, d.completed_at, o.id as order_id, o.number, c.name as customer_name
        from public.deliveries d join public.orders o on o.id = d.order_id join public.customers c on c.id = o.customer_id
        where d.tenant_id = p_tenant and d.status = 'failed' and d.completed_at >= now() - interval '2 days'
        order by d.completed_at desc limit 10) x), '[]'::jsonb),
    'unpaid_delivered', coalesce((
      select jsonb_agg(x) from (
        select o.id, o.number, o.balance_cents, o.delivered_at, c.name as customer_name
        from public.orders o join public.customers c on c.id = o.customer_id
        where o.tenant_id = p_tenant and o.status = 'delivered' and o.balance_cents > 0
        order by o.delivered_at desc limit 10) x), '[]'::jsonb),
    'quality_issues', coalesce((
      select jsonb_agg(x) from (
        select q.id, q.severity, q.type, q.description, q.phase_name, q.created_at, o.id as order_id, o.number
        from public.quality_issues q join public.orders o on o.id = q.order_id
        where q.tenant_id = p_tenant and q.status in ('open', 'in_progress')
        order by case q.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, q.created_at desc
        limit 10) x), '[]'::jsonb)
  ) into v;
  return v;
end $$;
