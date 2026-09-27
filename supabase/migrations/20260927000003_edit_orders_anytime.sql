-- ============================================================================
-- 0012 · Edit orders at any time
-- * Orders (items, prices, dates, notes) can be edited at any stage, including
--   after delivery; only cancelled orders are frozen.
-- * Front desk (orders.edit) can reschedule, change the address or courier of,
--   and cancel pickups and deliveries, not only dispatch (delivery.manage).
-- ============================================================================

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

  -- Items are written after the order row: settle the payment state now.
  perform app.recompute_order_payment(v_id);

  if v_is_new then
    perform app.enqueue_notification(v_id, 'order_created');
  end if;

  return jsonb_build_object('id', v_id, 'number', v_number, 'public_token', v_token);
end $$;

drop function if exists public.update_delivery(uuid, date, text, time, time, uuid, text, boolean);

create or replace function public.update_delivery(
  p_delivery uuid,
  p_date date default null,
  p_window_label text default null,
  p_window_start time default null,
  p_window_end time default null,
  p_courier uuid default null,
  p_notes text default null,
  p_clear_courier boolean default false,
  p_address_id uuid default null
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
  if not (app.has_permission(d.tenant_id, 'delivery.manage') or app.has_permission(d.tenant_id, 'orders.edit')) then
    perform app.raise_forbidden('missing permission delivery.manage');
  end if;
  if p_address_id is not null and not exists (
    select 1 from public.customer_addresses a join public.orders o on o.customer_id = a.customer_id
    where a.id = p_address_id and o.id = d.order_id
  ) then
    raise exception using errcode = '22023', message = 'a valid customer address is required';
  end if;
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
    address_id = coalesce(p_address_id, address_id),
    address = case when p_address_id is null then address else app.address_snapshot(p_address_id) end,
    courier_id = v_courier,
    status = case
      when status in ('scheduled', 'assigned') then case when v_courier is null then 'scheduled' else 'assigned' end
      else status end,
    route_id = case when p_date is not null and p_date <> scheduled_date then null else route_id end,
    stop_position = case when p_date is not null and p_date <> scheduled_date then null else stop_position end
  where id = p_delivery;
end $$;

grant execute on function public.update_delivery(uuid, date, text, time, time, uuid, text, boolean, uuid) to authenticated;

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
          or (p_status = 'cancelled' and app.has_permission(d.tenant_id, 'orders.edit'))
          or (d.courier_id = v_actor and app.has_permission(d.tenant_id, 'delivery.execute'))) then
    perform app.raise_forbidden('not your stop');
  end if;
  if p_status = 'cancelled' and not (app.has_permission(d.tenant_id, 'delivery.manage') or app.has_permission(d.tenant_id, 'orders.edit')) then
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
