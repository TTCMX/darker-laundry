-- ============================================================================
-- Production flow without extra steps
--   * An order enters production by itself as soon as the clothes are in the
--     store and its services are captured:
--       - counter (walk-in) orders, when created with services;
--       - pickup orders, when received (courier completes the pickup or
--         "Recibir en tienda"); without services they wait in "Recibidas"
--         and enter as soon as the services are captured.
--   * Home-delivery orders get their delivery stop scheduled by themselves
--     when production finishes (marked ready): next available window from
--     the promised date, on a working day, assigned to the courier when
--     there is only one. So they show up on the route.
--   * Both are best-effort: if something is missing (no workflow, no
--     address) the order simply stays where it is, as before.
-- ============================================================================

create or replace function app.auto_start_production(p_order uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
begin
  select id, status, fulfillment into o from public.orders where id = p_order;
  if not found then return; end if;
  if not (o.status = 'picked_up' or (o.status = 'created' and o.fulfillment = 'walk_in')) then return; end if;
  if not exists (select 1 from public.order_items where order_id = p_order) then return; end if;
  begin
    perform app.transition_order(p_order, 'in_production', null);
  exception when others then
    null; -- e.g. no production workflow configured: stays received
  end;
end $$;

-- Deferred to the end of the transaction: the order's items are saved after
-- the order row, so this sees the final state of a save.
create or replace function app.orders_auto_start() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.auto_start_production(new.id);
  return null;
end $$;

drop trigger if exists orders_auto_start on public.orders;
create constraint trigger orders_auto_start
  after insert or update on public.orders
  deferrable initially deferred
  for each row
  when (new.status = 'picked_up' or (new.status = 'created' and new.fulfillment = 'walk_in'))
  execute function app.orders_auto_start();

create or replace function app.auto_schedule_delivery(p_order uuid) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
  v_settings jsonb;
  v_tz text;
  v_address uuid;
  v_windows jsonb;
  v_days jsonb;
  v_today date;
  v_now time;
  v_start date;
  v_pref time;
  v_day date;
  v_win jsonb;
  v_pick jsonb;
  v_courier uuid;
  v_id uuid;
  i int;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.fulfillment <> 'delivery' or o.status in ('delivered', 'cancelled') then return null; end if;
  if exists (select 1 from public.deliveries where order_id = p_order and type = 'delivery'
             and status not in ('completed', 'failed', 'cancelled')) then
    return null;
  end if;
  v_address := coalesce(o.delivery_address_id, o.pickup_address_id);
  if v_address is null or not exists (select 1 from public.customer_addresses where id = v_address and customer_id = o.customer_id) then
    return null; -- no address: scheduled by hand from the order
  end if;

  select settings, coalesce(timezone, 'UTC') into v_settings, v_tz from public.tenants where id = o.tenant_id;
  -- Same defaults as src/domain/settings.ts.
  v_windows := coalesce(v_settings #> '{delivery,windows}',
    '[{"id":"morning","label":"Mañana","start":"09:00","end":"13:00"},{"id":"afternoon","label":"Tarde","start":"13:00","end":"18:00"}]'::jsonb);
  v_days := coalesce(v_settings #> '{operations,working_days}', '["mon","tue","wed","thu","fri","sat"]'::jsonb);
  v_today := (now() at time zone v_tz)::date;
  v_now := (now() at time zone v_tz)::time;
  v_start := v_today;
  if o.promised_at is not null and (o.promised_at at time zone v_tz)::date > v_today then
    v_start := (o.promised_at at time zone v_tz)::date;
    v_pref := (o.promised_at at time zone v_tz)::time;
  end if;

  for i in 0 .. 13 loop
    v_day := v_start + i;
    continue when jsonb_array_length(v_days) > 0
      and not v_days ? (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from v_day)::int];
    v_pick := null;
    for v_win in
      select w from jsonb_array_elements(v_windows) w
      where (v_day > v_today or (w ->> 'end')::time > v_now)
      order by (w ->> 'start')::time
    loop
      if v_pick is null then v_pick := v_win; end if;
      if v_pref is not null and v_day = v_start and v_pref between (v_win ->> 'start')::time and (v_win ->> 'end')::time then
        v_pick := v_win;
        exit;
      end if;
    end loop;
    exit when v_pick is not null or jsonb_array_length(v_windows) = 0;
  end loop;

  if coalesce((v_settings #>> '{delivery,auto_assign_single_courier}')::boolean, true) then
    v_courier := app.single_courier(o.tenant_id);
  end if;

  begin
    insert into public.deliveries (
      tenant_id, order_id, type, status, address_id, address, scheduled_date,
      window_label, window_start, window_end, courier_id, notes, created_by
    ) values (
      o.tenant_id, o.id, 'delivery', case when v_courier is null then 'scheduled' else 'assigned' end,
      v_address, app.address_snapshot(v_address), v_day,
      v_pick ->> 'label', (v_pick ->> 'start')::time, (v_pick ->> 'end')::time, v_courier,
      'Programada automáticamente al quedar lista.', app.current_actor()
    ) returning id into v_id;
    update public.orders set delivery_address_id = coalesce(delivery_address_id, v_address) where id = o.id;
  exception when others then
    return null; -- never block finishing production
  end;
  return v_id;
end $$;

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

  -- The clothes are already in the store (received at the counter or sent
  -- straight to production): a pickup still pending must not send the
  -- courier to the customer's door.
  if o.status in ('created', 'scheduled') and p_to in ('picked_up', 'in_production') then
    update public.deliveries
    set status = 'cancelled',
        notes = concat_ws(E'\n', nullif(notes, ''), 'Cancelada: la ropa se recibió en tienda.')
    where order_id = p_order and type = 'pickup' and status not in ('completed', 'failed', 'cancelled');
  end if;

  if p_to = 'in_production' then
    perform app.ensure_production_steps(p_order);
  elsif p_to = 'ready' then
    -- Marked ready by hand: whatever was left is recorded as skipped.
    update public.order_production_steps set status = 'skipped'
    where order_id = p_order and status in ('pending', 'in_progress');
    perform app.refresh_current_step(p_order);
    -- Home delivery: straight onto the route (not after a failed delivery,
    -- which is rescheduled by hand).
    if o.status = 'in_production' then
      perform app.auto_schedule_delivery(p_order);
    end if;
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

  -- Received with its services captured: production starts right away.
  if p_to = 'picked_up' then
    perform app.auto_start_production(p_order);
  end if;
end $$;

revoke all on function app.auto_start_production(uuid), app.auto_schedule_delivery(uuid) from public, anon, authenticated;
