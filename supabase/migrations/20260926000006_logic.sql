-- ============================================================================
-- 0006 · Business logic
-- Every state change with rules goes through these functions. They check
-- permissions server-side, lock the rows they change, and write the audit
-- log in the same transaction. Clients never update these tables directly.
-- ============================================================================

-- ── Payments: derived state ─────────────────────────────────────────────────
-- Same rules as src/domain/payments.ts (derivePaymentState).

create or replace function app.recompute_order_payment(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_total bigint;
  v_paid bigint;
  v_refunded bigint;
  v_net bigint;
  v_status text;
  v_last text;
begin
  select total_cents into v_total from public.orders where id = p_order;
  if not found then return; end if;

  select coalesce(sum(amount_cents) filter (where kind = 'payment' and status = 'succeeded'), 0),
         coalesce(sum(amount_cents) filter (where kind = 'refund' and status = 'succeeded'), 0)
    into v_paid, v_refunded
  from public.payments where order_id = p_order;

  v_net := v_paid - v_refunded;
  if v_refunded > 0 and v_net <= 0 then v_status := 'refunded';
  elsif v_net > 0 and v_net >= v_total then v_status := 'paid';
  elsif v_net > 0 then v_status := 'partially_paid';
  elsif v_total = 0 then v_status := 'paid';
  else
    select status into v_last from public.payments where order_id = p_order order by created_at desc, id desc limit 1;
    v_status := case when v_last = 'failed' then 'failed' else 'pending' end;
  end if;

  update public.orders set amount_paid_cents = v_net, payment_status = v_status
  where id = p_order and (amount_paid_cents, payment_status) is distinct from (v_net, v_status);
end $$;

create or replace function app.payments_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.recompute_order_payment(new.order_id);
  return new;
end $$;

create trigger payments_recompute after insert or update of status, amount_cents on public.payments
  for each row execute function app.payments_changed();

create or replace function app.order_total_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.recompute_order_payment(new.id);
  return new;
end $$;

create trigger orders_total_recompute after insert or update of total_cents on public.orders
  for each row execute function app.order_total_changed();

-- ── Notifications: enqueue ──────────────────────────────────────────────────

create or replace function app.enqueue_notification(
  p_order uuid, p_event text, p_dedupe_suffix text default '', p_extra jsonb default '{}'::jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare
  o record;
  c record;
  tn record;
  t record;
  v_vars jsonb;
  v_recipient text;
  v_count int := 0;
  v_id uuid;
begin
  select * into o from public.orders where id = p_order;
  if not found then return 0; end if;
  select * into c from public.customers where id = o.customer_id;
  select * into tn from public.tenants where id = o.tenant_id;

  v_vars := jsonb_build_object(
    'customer_name', split_part(btrim(c.name), ' ', 1),
    'business_name', tn.name,
    'business_phone', tn.phone,
    'order_number', o.number,
    'status', o.status,
    'total_cents', o.total_cents,
    'balance_cents', o.balance_cents,
    'currency', tn.currency,
    'locale', coalesce(tn.settings ->> 'locale', 'es-MX'),
    'timezone', tn.timezone,
    'promised_at', o.promised_at,
    'tracking_token', o.public_token
  ) || coalesce(p_extra, '{}'::jsonb);

  -- A new status message supersedes older ones nobody sent yet: a customer
  -- whose order was delivered should not later get "your order is ready".
  if p_event <> 'payment_reminder' then
    update public.notifications set status = 'cancelled'
    where order_id = o.id and status = 'pending' and event <> 'payment_reminder' and event <> p_event;
  end if;

  for t in
    select * from public.notification_templates
    where tenant_id = o.tenant_id and event = p_event and enabled
  loop
    v_recipient := case t.channel when 'email' then c.email else c.phone_normalized end;
    continue when v_recipient is null;
    insert into public.notifications (
      tenant_id, order_id, customer_id, template_id, event, channel, mode, recipient,
      subject_template, body_template, variables, dedupe_key
    ) values (
      o.tenant_id, o.id, c.id, t.id, p_event, t.channel, t.mode, v_recipient,
      t.subject, t.body, v_vars,
      format('%s:%s:%s:%s', o.id, p_event, t.channel, coalesce(p_dedupe_suffix, ''))
    )
    on conflict (tenant_id, dedupe_key) do nothing
    returning id into v_id;
    if v_id is not null then v_count := v_count + 1; end if;
    v_id := null;
  end loop;
  return v_count;
end $$;

-- ── Production ──────────────────────────────────────────────────────────────

create or replace function app.refresh_current_step(p_order uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_step uuid;
begin
  select id into v_step from public.order_production_steps
  where order_id = p_order and status in ('pending', 'in_progress')
  order by position limit 1;
  update public.orders set current_step_id = v_step
  where id = p_order and current_step_id is distinct from v_step;
  return v_step;
end $$;

create or replace function app.ensure_production_steps(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  o record;
  v_workflow uuid;
  v_last uuid;
begin
  select * into o from public.orders where id = p_order for update;

  if exists (select 1 from public.order_production_steps where order_id = p_order) then
    -- Back to production (rework): reopen the last completed step.
    if not exists (select 1 from public.order_production_steps where order_id = p_order and status in ('pending', 'in_progress')) then
      select id into v_last from public.order_production_steps
      where order_id = p_order and status = 'done' order by position desc limit 1;
      if v_last is null then
        select id into v_last from public.order_production_steps where order_id = p_order order by position desc limit 1;
      end if;
      update public.order_production_steps
      set status = 'pending', completed_at = null, completed_by = null
      where id = v_last;
    end if;
  else
    v_workflow := coalesce(
      o.workflow_id,
      (select id from public.workflows where tenant_id = o.tenant_id and is_default and active limit 1),
      (select id from public.workflows where tenant_id = o.tenant_id and active order by created_at limit 1)
    );
    if v_workflow is null then
      raise exception using errcode = '22023', message = 'no production workflow configured';
    end if;

    insert into public.order_production_steps (
      tenant_id, order_id, workflow_step_id, name, position, requires_assignment, allowed_role_ids, estimated_minutes
    )
    select o.tenant_id, o.id, s.id, s.name, row_number() over (order by s.position, s.created_at),
           s.requires_assignment, s.allowed_role_ids, s.estimated_minutes
    from public.workflow_steps s
    where s.workflow_id = v_workflow and s.active;

    if not found then
      raise exception using errcode = '22023', message = 'the production workflow has no active steps';
    end if;
    update public.orders set workflow_id = v_workflow where id = p_order;
  end if;

  perform app.refresh_current_step(p_order);
end $$;

-- ── Orders: lifecycle ───────────────────────────────────────────────────────

create or replace function app.transition_order(p_order uuid, p_to text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  o record;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if o.status = p_to then return; end if;
  if not exists (select 1 from app.order_transitions where from_status = o.status and to_status = p_to) then
    raise exception using errcode = '22023', message = format('invalid status change %s → %s', o.status, p_to);
  end if;

  perform app.set_audit_context(jsonb_build_object('event', 'order.status_changed', 'note', p_note));
  update public.orders set
    status = p_to,
    ready_at = case when p_to = 'ready' then now() else ready_at end,
    delivered_at = case when p_to = 'delivered' then now() else delivered_at end,
    cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when p_to = 'cancelled' then p_note else cancel_reason end
  where id = p_order;
  perform app.set_audit_context(null);

  if p_to = 'in_production' then
    perform app.ensure_production_steps(p_order);
  elsif p_to = 'ready' then
    -- Marked ready by hand: whatever was left is recorded as skipped.
    update public.order_production_steps set status = 'skipped'
    where order_id = p_order and status in ('pending', 'in_progress');
    perform app.refresh_current_step(p_order);
  elsif p_to = 'cancelled' then
    update public.deliveries set status = 'cancelled'
    where order_id = p_order and status not in ('completed', 'failed', 'cancelled');
    update public.notifications set status = 'cancelled'
    where order_id = p_order and status = 'pending';
  end if;

  perform app.enqueue_notification(p_order, case p_to
    when 'picked_up' then 'order_received'
    when 'ready' then 'order_ready'
    when 'out_for_delivery' then 'out_for_delivery'
    when 'delivered' then 'order_delivered'
  end) where p_to in ('picked_up', 'ready', 'out_for_delivery', 'delivered');
end $$;

create or replace function public.set_order_status(p_order uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.orders where id = p_order;
  if v_tenant is null then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  perform app.require_permission(v_tenant, case when p_status = 'cancelled' then 'orders.cancel' else 'orders.edit' end);
  if p_status = 'ready'
     and exists (select 1 from public.order_production_steps where order_id = p_order and status in ('pending', 'in_progress'))
     and not app.has_permission(v_tenant, 'production.manage') then
    raise exception using errcode = '42501', message = 'production steps are still pending';
  end if;
  perform app.transition_order(p_order, p_status, p_note);
end $$;

create or replace function public.start_production(p_order uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.orders where id = p_order;
  if v_tenant is null then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if not (app.has_permission(v_tenant, 'orders.edit') or app.has_permission(v_tenant, 'production.manage')) then
    perform app.raise_forbidden('missing permission orders.edit');
  end if;
  perform app.transition_order(p_order, 'in_production', null);
end $$;

create or replace function public.update_order_details(
  p_order uuid, p_priority text default null, p_promised_at timestamptz default null,
  p_notes text default null, p_internal_notes text default null
) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  perform app.require_permission(o.tenant_id, 'orders.edit');
  update public.orders set
    priority = coalesce(p_priority, priority),
    promised_at = coalesce(p_promised_at, promised_at),
    notes = coalesce(p_notes, notes),
    internal_notes = coalesce(p_internal_notes, internal_notes)
  where id = p_order;
end $$;

-- ── Production steps ────────────────────────────────────────────────────────

create or replace function app.check_step_role(p_tenant uuid, p_user uuid, p_allowed uuid[]) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_role uuid;
begin
  select role_id into v_role from public.tenant_members where tenant_id = p_tenant and user_id = p_user and active;
  if v_role is null then
    raise exception using errcode = '22023', message = 'the employee is not an active member';
  end if;
  if not app.user_has_permission(p_user, p_tenant, 'production.work') then
    raise exception using errcode = '22023', message = 'the employee cannot work production steps';
  end if;
  if cardinality(p_allowed) > 0 and not (v_role = any (p_allowed)) then
    raise exception using errcode = '22023', message = 'the employee''s role is not allowed on this step';
  end if;
end $$;

create or replace function public.assign_production_step(p_step uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  s record;
  v_actor uuid := app.current_actor();
begin
  select * into s from public.order_production_steps where id = p_step for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'step not found';
  end if;
  if s.status in ('done', 'skipped') then
    raise exception using errcode = '22023', message = 'the step is already closed';
  end if;

  if not app.has_permission(s.tenant_id, 'production.manage') then
    perform app.require_permission(s.tenant_id, 'production.work');
    -- Workers can take a free step for themselves or release their own.
    if p_user is not null and (p_user <> v_actor or (s.assigned_to is not null and s.assigned_to <> v_actor)) then
      perform app.raise_forbidden('the step is assigned to someone else');
    end if;
    if p_user is null and s.assigned_to is distinct from v_actor then
      perform app.raise_forbidden('only a manager can release someone else''s step');
    end if;
  end if;

  if p_user is not null then
    perform app.check_step_role(s.tenant_id, p_user, s.allowed_role_ids);
  end if;

  update public.order_production_steps set
    assigned_to = p_user,
    assigned_at = case when p_user is null then null else now() end,
    assigned_by = case when p_user is null then null else v_actor end
  where id = p_step;
end $$;

create or replace function app.step_for_work(p_step uuid, p_require_assignment boolean)
returns public.order_production_steps
language plpgsql security definer set search_path = public as $$
declare
  s public.order_production_steps;
  v_actor uuid := app.current_actor();
  v_first uuid;
  v_order_status text;
begin
  select * into s from public.order_production_steps where id = p_step for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'step not found';
  end if;
  select status into v_order_status from public.orders where id = s.order_id for update;
  if v_order_status <> 'in_production' then
    raise exception using errcode = '22023', message = 'the order is not in production';
  end if;
  if s.status in ('done', 'skipped') then
    raise exception using errcode = '22023', message = 'the step is already closed';
  end if;
  select id into v_first from public.order_production_steps
  where order_id = s.order_id and status in ('pending', 'in_progress') order by position limit 1;
  if v_first <> s.id then
    raise exception using errcode = '22023', message = 'previous steps are not finished';
  end if;

  if not app.has_permission(s.tenant_id, 'production.manage') then
    perform app.require_permission(s.tenant_id, 'production.work');
    if s.assigned_to is null then
      if p_require_assignment and s.requires_assignment then
        perform app.raise_forbidden('take the step before working on it');
      end if;
      perform app.check_step_role(s.tenant_id, v_actor, s.allowed_role_ids);
      update public.order_production_steps
      set assigned_to = v_actor, assigned_at = now(), assigned_by = v_actor
      where id = p_step;
      s.assigned_to := v_actor;
    elsif s.assigned_to <> v_actor then
      perform app.raise_forbidden('the step is assigned to someone else');
    end if;
  end if;
  return s;
end $$;

create or replace function public.start_production_step(p_step uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  s public.order_production_steps;
begin
  s := app.step_for_work(p_step, true);
  update public.order_production_steps
  set status = 'in_progress', started_at = coalesce(started_at, now())
  where id = p_step;
end $$;

create or replace function public.complete_production_step(p_step uuid, p_notes text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  s public.order_production_steps;
  v_next uuid;
  v_next_name text;
begin
  s := app.step_for_work(p_step, true);
  update public.order_production_steps set
    status = 'done',
    started_at = coalesce(started_at, now()),
    completed_at = now(),
    completed_by = app.current_actor(),
    notes = coalesce(p_notes, notes)
  where id = p_step;

  v_next := app.refresh_current_step(s.order_id);
  if v_next is null then
    perform app.transition_order(s.order_id, 'ready', null);
  else
    select name into v_next_name from public.order_production_steps where id = v_next;
    perform app.enqueue_notification(s.order_id, 'production_update', p_step::text,
      jsonb_build_object('step', v_next_name, 'completed_step', s.name));
  end if;
end $$;

create or replace function public.revert_production_step(p_step uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  s record;
  v_status text;
begin
  select * into s from public.order_production_steps where id = p_step for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'step not found';
  end if;
  perform app.require_permission(s.tenant_id, 'production.manage');
  select status into v_status from public.orders where id = s.order_id for update;
  if v_status not in ('in_production', 'ready') then
    raise exception using errcode = '22023', message = 'the order is no longer in the plant';
  end if;

  perform app.set_audit_context(jsonb_build_object('event', 'production.step_reverted', 'note', p_reason));
  update public.order_production_steps set
    status = 'pending', started_at = null, completed_at = null, completed_by = null
  where order_id = s.order_id and position >= s.position;
  perform app.set_audit_context(null);

  if v_status = 'ready' then
    perform app.transition_order(s.order_id, 'in_production', p_reason);
  end if;
  perform app.refresh_current_step(s.order_id);
end $$;

-- ── Deliveries & routes ─────────────────────────────────────────────────────

create or replace function app.address_snapshot(p_address uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'label', a.label, 'line1', a.line1, 'line2', a.line2, 'neighborhood', a.neighborhood,
    'city', a.city, 'state', a.state, 'postal_code', a.postal_code,
    'instructions', a.instructions, 'lat', a.lat, 'lng', a.lng
  )
  from public.customer_addresses a where a.id = p_address;
$$;

create or replace function app.check_courier(p_tenant uuid, p_courier uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_courier is not null and not app.user_has_permission(p_courier, p_tenant, 'delivery.execute') then
    raise exception using errcode = '22023', message = 'the selected member cannot run deliveries';
  end if;
end $$;

-- The only courier, when there is exactly one (roles that land in the courier app).
create or replace function app.single_courier(p_tenant uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then (array_agg(m.user_id))[1] end
  from public.tenant_members m join public.roles r on r.id = m.role_id
  where m.tenant_id = p_tenant and m.active and r.home = 'courier';
$$;

create or replace function public.schedule_delivery(
  p_order uuid,
  p_type text,
  p_date date,
  p_window_label text default null,
  p_window_start time default null,
  p_window_end time default null,
  p_address_id uuid default null,
  p_notes text default null,
  p_courier uuid default null
) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
  v_address uuid;
  v_courier uuid := p_courier;
  v_id uuid;
  v_settings jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if not (app.has_permission(o.tenant_id, 'delivery.manage') or app.has_permission(o.tenant_id, 'orders.edit')) then
    perform app.raise_forbidden('missing permission delivery.manage');
  end if;
  if p_type not in ('pickup', 'delivery') then
    raise exception using errcode = '22023', message = 'invalid delivery type';
  end if;
  if o.status in ('delivered', 'cancelled') then
    raise exception using errcode = '22023', message = 'the order is closed';
  end if;
  if p_type = 'pickup' and o.status not in ('created', 'scheduled') then
    raise exception using errcode = '22023', message = 'the order was already received';
  end if;

  v_address := coalesce(p_address_id, case when p_type = 'pickup' then o.pickup_address_id else o.delivery_address_id end);
  if v_address is null or not exists (
    select 1 from public.customer_addresses where id = v_address and customer_id = o.customer_id
  ) then
    raise exception using errcode = '22023', message = 'a valid customer address is required';
  end if;

  if v_courier is null then
    select settings into v_settings from public.tenants where id = o.tenant_id;
    if coalesce((v_settings #>> '{delivery,auto_assign_single_courier}')::boolean, true) then
      v_courier := app.single_courier(o.tenant_id);
    end if;
  end if;
  perform app.check_courier(o.tenant_id, v_courier);

  insert into public.deliveries (
    tenant_id, order_id, type, status, address_id, address, scheduled_date,
    window_label, window_start, window_end, courier_id, notes, created_by
  ) values (
    o.tenant_id, o.id, p_type, case when v_courier is null then 'scheduled' else 'assigned' end,
    v_address, app.address_snapshot(v_address), p_date,
    p_window_label, p_window_start, p_window_end, v_courier, p_notes, app.current_actor()
  ) returning id into v_id;

  if p_type = 'pickup' then
    update public.orders set pickup_address_id = coalesce(pickup_address_id, v_address) where id = o.id;
    if o.status = 'created' then perform app.transition_order(o.id, 'scheduled', null); end if;
    perform app.enqueue_notification(o.id, 'pickup_scheduled', v_id::text,
      jsonb_build_object('pickup_date', p_date, 'pickup_window', p_window_label));
  else
    update public.orders set delivery_address_id = coalesce(delivery_address_id, v_address) where id = o.id;
  end if;
  return v_id;
end $$;

create or replace function public.update_delivery(
  p_delivery uuid,
  p_date date default null,
  p_window_label text default null,
  p_window_start time default null,
  p_window_end time default null,
  p_courier uuid default null,
  p_notes text default null,
  p_clear_courier boolean default false
) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  d record;
  v_courier uuid;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'delivery not found';
  end if;
  perform app.require_permission(d.tenant_id, 'delivery.manage');
  if d.status in ('completed', 'failed', 'cancelled') then
    raise exception using errcode = '22023', message = 'the stop is closed';
  end if;
  v_courier := case when p_clear_courier then null else coalesce(p_courier, d.courier_id) end;
  perform app.check_courier(d.tenant_id, v_courier);

  update public.deliveries set
    scheduled_date = coalesce(p_date, scheduled_date),
    window_label = coalesce(p_window_label, window_label),
    window_start = coalesce(p_window_start, window_start),
    window_end = coalesce(p_window_end, window_end),
    notes = coalesce(p_notes, notes),
    courier_id = v_courier,
    status = case
      when status in ('scheduled', 'assigned') then case when v_courier is null then 'scheduled' else 'assigned' end
      else status end,
    route_id = case when p_date is not null and p_date <> scheduled_date then null else route_id end,
    stop_position = case when p_date is not null and p_date <> scheduled_date then null else stop_position end
  where id = p_delivery;
end $$;

create or replace function public.save_route(
  p_tenant uuid,
  p_route uuid,
  p_date date,
  p_name text,
  p_courier uuid,
  p_delivery_ids uuid[]
) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_route uuid := p_route;
  v_bad int;
begin
  perform app.require_permission(p_tenant, 'delivery.manage');
  perform app.check_courier(p_tenant, p_courier);

  select count(*) into v_bad
  from unnest(coalesce(p_delivery_ids, '{}')) as x(id)
  left join public.deliveries d on d.id = x.id and d.tenant_id = p_tenant
  where d.id is null or d.status in ('completed', 'failed', 'cancelled');
  if v_bad > 0 then
    raise exception using errcode = '22023', message = 'some stops do not exist or are already closed';
  end if;

  if v_route is null then
    insert into public.routes (tenant_id, route_date, name, courier_id, created_by)
    values (p_tenant, p_date, p_name, p_courier, app.current_actor())
    returning id into v_route;
  else
    update public.routes set route_date = p_date, name = p_name, courier_id = p_courier
    where id = v_route and tenant_id = p_tenant;
    if not found then
      raise exception using errcode = 'P0002', message = 'route not found';
    end if;
  end if;

  update public.deliveries set route_id = null, stop_position = null
  where route_id = v_route and not (id = any (coalesce(p_delivery_ids, '{}')));

  update public.deliveries d set
    route_id = v_route,
    stop_position = x.pos,
    courier_id = coalesce(p_courier, d.courier_id),
    status = case when d.status = 'scheduled' and coalesce(p_courier, d.courier_id) is not null then 'assigned' else d.status end
  from unnest(coalesce(p_delivery_ids, '{}')) with ordinality as x(id, pos)
  where d.id = x.id and d.tenant_id = p_tenant;

  return v_route;
end $$;

create or replace function public.start_route(p_route uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  r record;
begin
  select * into r from public.routes where id = p_route for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'route not found';
  end if;
  if not (app.has_permission(r.tenant_id, 'delivery.manage')
          or (r.courier_id = app.current_actor() and app.has_permission(r.tenant_id, 'delivery.execute'))) then
    perform app.raise_forbidden('not your route');
  end if;
  if r.status = 'planned' then
    update public.routes set status = 'in_progress', started_at = now() where id = p_route;
  end if;
end $$;

create or replace function public.update_delivery_status(
  p_delivery uuid,
  p_status text,
  p_note text default null,
  p_failure_reason text default null,
  p_proof_paths text[] default '{}'
) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  d record;
  o record;
  v_actor uuid := app.current_actor();
  v_rank_from int;
  v_rank_to int;
begin
  select * into d from public.deliveries where id = p_delivery for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'delivery not found';
  end if;
  select * into o from public.orders where id = d.order_id for update;

  if not (app.has_permission(d.tenant_id, 'delivery.manage')
          or (d.courier_id = v_actor and app.has_permission(d.tenant_id, 'delivery.execute'))) then
    perform app.raise_forbidden('not your stop');
  end if;
  if p_status = 'cancelled' and not app.has_permission(d.tenant_id, 'delivery.manage') then
    perform app.raise_forbidden('only dispatch can cancel a stop');
  end if;
  if d.status in ('completed', 'failed', 'cancelled') then
    raise exception using errcode = '22023', message = 'the stop is already closed';
  end if;
  if p_status not in ('en_route', 'arrived', 'completed', 'failed', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid stop status';
  end if;

  v_rank_from := case d.status when 'en_route' then 1 when 'arrived' then 2 else 0 end;
  v_rank_to := case p_status when 'en_route' then 1 when 'arrived' then 2 else 3 end;
  if v_rank_to < v_rank_from then
    raise exception using errcode = '22023', message = 'a stop cannot go backwards';
  end if;
  if p_status = 'failed' and coalesce(btrim(p_failure_reason), '') = '' then
    raise exception using errcode = '22023', message = 'a failure reason is required';
  end if;
  if d.type = 'delivery' and p_status in ('en_route', 'arrived', 'completed')
     and o.status not in ('ready', 'out_for_delivery') then
    raise exception using errcode = '22023', message = 'the order is not ready for delivery';
  end if;

  update public.deliveries set
    status = p_status,
    started_at = case when p_status = 'en_route' then coalesce(started_at, now()) else started_at end,
    arrived_at = case when p_status = 'arrived' then now() else arrived_at end,
    completed_at = case when p_status in ('completed', 'failed') then now() else completed_at end,
    completed_by = case when p_status in ('completed', 'failed') then v_actor else completed_by end,
    failure_reason = case when p_status = 'failed' then p_failure_reason else failure_reason end,
    proof_paths = proof_paths || coalesce(p_proof_paths, '{}'),
    notes = case when p_note is null or btrim(p_note) = '' then notes
                 else concat_ws(E'\n', notes, p_note) end
  where id = p_delivery;

  if d.type = 'pickup' and p_status = 'completed' and o.status in ('created', 'scheduled') then
    perform app.transition_order(o.id, 'picked_up', null);
  elsif d.type = 'delivery' and p_status in ('en_route', 'arrived') and o.status = 'ready' then
    perform app.transition_order(o.id, 'out_for_delivery', null);
  elsif d.type = 'delivery' and p_status = 'completed' then
    perform app.transition_order(o.id, 'delivered', null);
  elsif d.type = 'delivery' and p_status in ('failed', 'cancelled') and o.status = 'out_for_delivery' then
    perform app.transition_order(o.id, 'ready', coalesce(p_failure_reason, p_note));
  end if;

  if d.route_id is not null and not exists (
    select 1 from public.deliveries where route_id = d.route_id and status not in ('completed', 'failed', 'cancelled')
  ) then
    update public.routes set status = 'completed', completed_at = now()
    where id = d.route_id and status <> 'completed';
  end if;
end $$;

-- ── Payments ────────────────────────────────────────────────────────────────

create or replace function app.courier_has_order(p_order uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.deliveries d
    where d.order_id = p_order and d.courier_id = app.current_actor()
      and d.status not in ('cancelled')
      and app.has_permission(d.tenant_id, 'delivery.execute')
  );
$$;

create or replace function public.record_payment(
  p_order uuid,
  p_amount_cents bigint,
  p_method text,
  p_idempotency_key text,
  p_notes text default null,
  p_delivery uuid default null
) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
  v_id uuid;
  v_settings jsonb;
begin
  if coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception using errcode = '22023', message = 'idempotency key required';
  end if;
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if not (app.has_permission(o.tenant_id, 'payments.record') or app.courier_has_order(o.id)) then
    perform app.raise_forbidden('missing permission payments.record');
  end if;

  -- A retry of a payment already recorded returns the original.
  select id into v_id from public.payments where tenant_id = o.tenant_id and idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception using errcode = '22023', message = 'amount must be positive';
  end if;
  if p_method not in ('cash', 'card', 'transfer', 'online') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;
  if o.status = 'cancelled' then
    raise exception using errcode = '22023', message = 'the order is cancelled';
  end if;
  select settings into v_settings from public.tenants where id = o.tenant_id;
  if not coalesce((v_settings #>> '{payments,allow_overpayment}')::boolean, false)
     and p_amount_cents > o.balance_cents then
    raise exception using errcode = '22023', message = 'amount exceeds the balance';
  end if;
  if p_delivery is not null and not exists (select 1 from public.deliveries where id = p_delivery and order_id = o.id) then
    raise exception using errcode = '22023', message = 'the stop does not belong to this order';
  end if;

  insert into public.payments (
    tenant_id, order_id, kind, method, provider, status, amount_cents, currency,
    idempotency_key, delivery_id, notes, recorded_by
  )
  select o.tenant_id, o.id, 'payment', p_method, 'manual', 'succeeded', p_amount_cents, t.currency,
         p_idempotency_key, p_delivery, p_notes, app.current_actor()
  from public.tenants t where t.id = o.tenant_id
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.record_refund(
  p_payment uuid, p_amount_cents bigint, p_reason text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  p record;
  v_refunded bigint;
  v_id uuid;
begin
  select * into p from public.payments where id = p_payment;
  if not found then
    raise exception using errcode = 'P0002', message = 'payment not found';
  end if;
  perform app.require_permission(p.tenant_id, 'payments.refund');
  perform 1 from public.orders where id = p.order_id for update;

  select id into v_id from public.payments where tenant_id = p.tenant_id and idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;

  if p.kind <> 'payment' or p.status <> 'succeeded' then
    raise exception using errcode = '22023', message = 'only a successful payment can be refunded';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;
  select coalesce(sum(amount_cents), 0) into v_refunded
  from public.payments where refund_of = p.id and status = 'succeeded';
  if p_amount_cents <= 0 or p_amount_cents > p.amount_cents - v_refunded then
    raise exception using errcode = '22023', message = 'invalid refund amount';
  end if;

  insert into public.payments (
    tenant_id, order_id, kind, method, provider, status, amount_cents, currency,
    idempotency_key, refund_of, notes, recorded_by
  ) values (
    p.tenant_id, p.order_id, 'refund', p.method, 'manual', 'succeeded', p_amount_cents, p.currency,
    p_idempotency_key, p.id, p_reason, app.current_actor()
  ) returning id into v_id;
  return v_id;
end $$;

-- ── Notifications: staff actions ────────────────────────────────────────────

create or replace function public.mark_notification(p_notification uuid, p_status text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  n record;
begin
  select * into n from public.notifications where id = p_notification for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'notification not found';
  end if;
  perform app.require_permission(n.tenant_id, 'notifications.send');
  if p_status not in ('sent', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid status';
  end if;
  update public.notifications set
    status = p_status,
    sent_at = case when p_status = 'sent' then now() else sent_at end,
    sent_by = case when p_status = 'sent' then app.current_actor() else sent_by end
  where id = p_notification and status in ('pending', 'failed');
end $$;

create or replace function public.queue_payment_reminder(p_order uuid) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
begin
  select * into o from public.orders where id = p_order;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  perform app.require_permission(o.tenant_id, 'notifications.send');
  if o.balance_cents <= 0 then
    raise exception using errcode = '22023', message = 'the order has no balance';
  end if;
  return app.enqueue_notification(p_order, 'payment_reminder', to_char(now(), 'YYYYMMDDHH24MI'));
end $$;

-- ── Server-only functions (service role) ────────────────────────────────────
-- Called by the API layer after it verified the user's session. They re-check
-- membership and permissions for the actor they act on behalf of.

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
    if v_existing.status in ('delivered', 'cancelled') then
      raise exception using errcode = '22023', message = 'a closed order cannot be edited';
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
  if jsonb_array_length(p_pricing -> 'lines') = 0
     or v_total is null or v_total < 0 or v_fee < 0 or v_tax < 0 or v_discount < 0
     or v_lines_net <> v_subtotal - v_discount
     or v_total <> v_subtotal - v_discount + v_fee + v_tax then
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
      pricing, priced_at, delivery_fee_override, created_by
    ) values (
      p_tenant, v_number, v_customer,
      coalesce(p_order ->> 'fulfillment', 'delivery'),
      coalesce(p_order ->> 'priority', 'normal'),
      (p_order ->> 'promised_at')::timestamptz,
      p_order ->> 'notes', p_order ->> 'internal_notes',
      v_pickup, v_delivery, v_zone,
      v_subtotal, v_discount, v_fee, v_tax, v_total,
      p_pricing, now(), v_override, p_actor
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
      pricing = p_pricing, priced_at = now(), delivery_fee_override = v_override
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

  if v_is_new then
    perform app.enqueue_notification(v_id, 'order_created');
  end if;

  return jsonb_build_object('id', v_id, 'number', v_number, 'public_token', v_token);
end $$;

-- Online payments reported by a provider (after the API verified them with
-- the provider). Idempotent on (provider, provider_payment_id): webhook
-- replays update the same row and never add money twice.
create or replace function public.svc_record_provider_payment(
  p_tenant uuid,
  p_order uuid,
  p_provider text,
  p_provider_payment_id text,
  p_status text,
  p_amount_cents bigint,
  p_raw jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_id uuid;
  v_prev text;
  v_currency text;
begin
  perform app.act_as(null, 'webhook');
  if not exists (select 1 from public.orders where id = p_order and tenant_id = p_tenant) then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if p_status not in ('pending', 'succeeded', 'failed') then
    raise exception using errcode = '22023', message = 'invalid status';
  end if;
  perform 1 from public.orders where id = p_order for update;

  select id, status into v_id, v_prev from public.payments
  where provider = p_provider and provider_payment_id = p_provider_payment_id;

  if v_id is null then
    select currency into v_currency from public.tenants where id = p_tenant;
    insert into public.payments (
      tenant_id, order_id, kind, method, provider, provider_payment_id, status, amount_cents,
      currency, idempotency_key, raw
    ) values (
      p_tenant, p_order, 'payment', 'online', p_provider, p_provider_payment_id, p_status, p_amount_cents,
      v_currency, p_provider || ':' || p_provider_payment_id, p_raw
    ) returning id into v_id;
  elsif v_prev <> 'succeeded' and v_prev <> p_status then
    -- A succeeded payment is final here; refunds are separate ledger entries.
    update public.payments set status = p_status, raw = p_raw where id = v_id;
  end if;

  if p_status = 'succeeded' then
    update public.payment_links set status = 'paid'
    where order_id = p_order and provider = p_provider and status = 'active';
  end if;

  return jsonb_build_object('payment_id', v_id, 'changed', v_prev is distinct from p_status);
end $$;
