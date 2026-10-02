-- ============================================================================
-- Routes take ready deliveries from any day
--   * When building a route, every ready home-delivery order can be added,
--     whatever day it was scheduled for (late or ahead of time). Saving the
--     route moves its stops to the route's day.
-- ============================================================================

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
    scheduled_date = p_date,
    courier_id = coalesce(p_courier, d.courier_id),
    status = case when d.status = 'scheduled' and coalesce(p_courier, d.courier_id) is not null then 'assigned' else d.status end
  from unnest(coalesce(p_delivery_ids, '{}')) with ordinality as x(id, pos)
  where d.id = x.id and d.tenant_id = p_tenant;

  return v_route;
end $$;
