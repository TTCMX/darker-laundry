-- ============================================================================
-- Cancel at any point before delivery; delete orders created by mistake
--   * "Cancelar orden" now works on ready and out-for-delivery orders too
--     (pending pickups/deliveries are cancelled, loyalty points returned).
--   * public.delete_order removes an order entirely (orders.cancel: owners
--     and managers), e.g. created by mistake or for testing. Only when it
--     has no payments: with money involved it must be cancelled and
--     refunded so the cash stays balanced. The deletion and its reason stay
--     in the audit log; production steps, stops, photos, issues,
--     notifications and loyalty movements go with the order.
-- ============================================================================

insert into app.order_transitions (from_status, to_status) values
  ('ready', 'cancelled'),
  ('out_for_delivery', 'cancelled')
on conflict do nothing;

create or replace function public.delete_order(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  o record;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  perform app.require_permission(o.tenant_id, 'orders.cancel');
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;
  if exists (select 1 from public.payments where order_id = p_order) then
    raise exception using errcode = '22023', message = 'the order has payments';
  end if;
  perform app.set_audit_context(jsonb_build_object('event', 'order.deleted', 'note', btrim(p_reason), 'number', o.number));
  delete from public.orders where id = p_order;
  perform app.set_audit_context(null);
end $$;

revoke all on function public.delete_order(uuid, text) from public, anon;
grant execute on function public.delete_order(uuid, text) to authenticated;
