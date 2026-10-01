-- ============================================================================
-- Send to production straight from "scheduled" (pickup booked)
--   * Front desk often receives the clothes before the courier goes (the
--     customer drops them off): an order with a booked pickup can now go to
--     production directly, as the app already offered.
--   * Whenever the clothes reach the store that way (received at the counter
--     or sent to production), a pickup still pending is cancelled so it
--     disappears from the courier's route.
-- ============================================================================

insert into app.order_transitions (from_status, to_status) values
  ('scheduled', 'in_production')
on conflict do nothing;

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
