-- ============================================================================
-- 0010 · Orders without items
-- A pickup is often booked before anyone knows what the customer will send.
-- Orders can now be saved with no items (total 0, payment "pending"); the
-- items are captured when the laundry is received, and production cannot
-- start until the order has items.
-- ============================================================================

create or replace function app.recompute_order_payment(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_total bigint;
  v_paid bigint;
  v_refunded bigint;
  v_net bigint;
  v_status text;
  v_last text;
  v_has_items boolean;
begin
  select total_cents, coalesce(jsonb_array_length(pricing -> 'lines'), 0) > 0
    into v_total, v_has_items
  from public.orders where id = p_order;
  if not found then return; end if;

  select coalesce(sum(amount_cents) filter (where kind = 'payment' and status = 'succeeded'), 0),
         coalesce(sum(amount_cents) filter (where kind = 'refund' and status = 'succeeded'), 0)
    into v_paid, v_refunded
  from public.payments where order_id = p_order;

  v_net := v_paid - v_refunded;
  if v_refunded > 0 and v_net <= 0 then v_status := 'refunded';
  elsif v_net > 0 and v_net >= v_total then v_status := 'paid';
  elsif v_net > 0 then v_status := 'partially_paid';
  -- A zero total is only "paid" once the order has been priced with items:
  -- a pickup booked before knowing what the customer sends is still pending.
  elsif v_total = 0 and v_has_items then v_status := 'paid';
  else
    select status into v_last from public.payments where order_id = p_order order by created_at desc, id desc limit 1;
    v_status := case when v_last = 'failed' then 'failed' else 'pending' end;
  end if;

  update public.orders set amount_paid_cents = v_net, payment_status = v_status
  where id = p_order and (amount_paid_cents, payment_status) is distinct from (v_net, v_status);
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
    if not exists (select 1 from public.order_items where order_id = p_order) then
      raise exception using errcode = '22023', message = 'add the order items before production';
    end if;
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

-- Existing zero-total orders with no items were marked "paid": fix them.
update public.orders set payment_status = 'pending'
where total_cents = 0 and amount_paid_cents = 0 and payment_status = 'paid'
  and coalesce(jsonb_array_length(pricing -> 'lines'), 0) = 0;
