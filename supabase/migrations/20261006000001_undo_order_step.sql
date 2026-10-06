-- ============================================================================
-- Undo one step of an order (fat-finger mistakes on the board)
--   public.undo_order_step(order, reason) moves an order exactly one step back
--   from wherever it is, the reverse of the board's "advance":
--     delivered        → ready (a completed delivery stop is reopened)
--     out_for_delivery → ready (the stop goes back to scheduled / assigned)
--     ready / in_production with a finished phase → that phase is reopened
--     ready with no phases → in_production
--     in_production / picked_up before any phase is done → back to "to pick
--       up" (the pickup stop is reopened) or to created
--   Permissions: orders.edit, or production.manage for phases; a production
--   worker can reopen a phase they finished themselves. Audited.
-- ============================================================================

create or replace function public.undo_order_step(p_order uuid, p_reason text default null) returns text
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
  v_actor uuid := app.current_actor();
  v_step record;
  v_stop record;
  v_to text;
  v_from int;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;

  perform app.set_audit_context(jsonb_build_object('event', 'order.step_undone', 'note', nullif(btrim(p_reason), '')));

  -- Delivered or on the way: back to ready.
  if o.status in ('delivered', 'out_for_delivery') then
    if not (app.has_permission(o.tenant_id, 'orders.edit') or app.has_permission(o.tenant_id, 'delivery.manage')) then
      perform app.raise_forbidden('missing permission orders.edit');
    end if;
    select * into v_stop from public.deliveries
    where order_id = o.id and type = 'delivery'
      and status in (case when o.status = 'delivered' then 'completed' else 'en_route' end, 'en_route', 'arrived')
    order by coalesce(completed_at, arrived_at, started_at, created_at) desc limit 1;
    if found then
      update public.deliveries set
        status = case when courier_id is null then 'scheduled' else 'assigned' end,
        started_at = null, arrived_at = null, completed_at = null, completed_by = null
      where id = v_stop.id;
      if v_stop.route_id is not null then
        update public.routes set status = 'in_progress', completed_at = null
        where id = v_stop.route_id and status = 'completed';
      end if;
    end if;
    update public.orders set status = 'ready', delivered_at = null where id = o.id;
    perform app.set_audit_context(null);
    return 'ready';
  end if;

  -- In the plant: reopen the last finished phase.
  if o.status in ('in_production', 'ready') then
    select * into v_step from public.order_production_steps
    where order_id = o.id and status in ('done', 'skipped')
    order by position desc limit 1;
    if found then
      if not (app.has_permission(o.tenant_id, 'production.manage')
              or (v_step.completed_by = v_actor and app.has_permission(o.tenant_id, 'production.work'))) then
        perform app.raise_forbidden('only a manager can reopen someone else''s phase');
      end if;
      -- "Marcar lista" skips every pending phase at once: undo them together.
      if v_step.status = 'skipped' then
        select min(position) into v_from from public.order_production_steps
        where order_id = o.id and status = 'skipped'
          and position > coalesce((select max(position) from public.order_production_steps where order_id = o.id and status = 'done'), 0);
      else
        v_from := v_step.position;
      end if;
      update public.order_production_steps set
        status = 'pending', started_at = null, completed_at = null, completed_by = null
      where order_id = o.id and position >= v_from;
      if o.status = 'ready' then
        update public.orders set status = 'in_production', ready_at = null where id = o.id;
      end if;
      perform app.refresh_current_step(o.id);
      perform app.set_audit_context(null);
      return 'in_production';
    end if;
    if o.status = 'ready' then
      perform app.require_permission(o.tenant_id, 'production.manage');
      update public.orders set status = 'in_production', ready_at = null where id = o.id;
      perform app.ensure_production_steps(o.id);
      perform app.refresh_current_step(o.id);
      perform app.set_audit_context(null);
      return 'in_production';
    end if;
  end if;

  -- Received / just started: back to before the clothes arrived.
  if o.status in ('in_production', 'picked_up') then
    perform app.require_permission(o.tenant_id, 'orders.edit');
    select * into v_stop from public.deliveries
    where order_id = o.id and type = 'pickup' and status in ('completed', 'cancelled')
    order by coalesce(completed_at, created_at) desc limit 1;
    if found then
      update public.deliveries set
        status = case when courier_id is null then 'scheduled' else 'assigned' end,
        started_at = null, arrived_at = null, completed_at = null, completed_by = null,
        notes = nullif(btrim(replace(coalesce(notes, ''), 'Cancelada: la ropa se recibió en tienda.', ''), E'\n '), '')
      where id = v_stop.id;
      if v_stop.route_id is not null then
        update public.routes set status = 'in_progress', completed_at = null
        where id = v_stop.route_id and status = 'completed';
      end if;
      v_to := 'scheduled';
    elsif o.fulfillment = 'delivery' then
      v_to := 'created';
    else
      -- Counter orders start production as soon as they have services:
      -- there is no earlier step to go back to.
      raise exception using errcode = '22023', message = 'nothing to undo';
    end if;
    update public.orders set status = v_to, current_step_id = null where id = o.id;
    perform app.set_audit_context(null);
    return v_to;
  end if;

  raise exception using errcode = '22023', message = 'nothing to undo';
end $$;

revoke all on function public.undo_order_step(uuid, text) from public, anon;
grant execute on function public.undo_order_step(uuid, text) to authenticated;
