-- ============================================================================
-- Audit fixes
--   1. An order that goes back from ready to production (undo, reverting a
--      phase, rework) no longer keeps the delivery that was scheduled by itself
--      when it became ready: the courier would see a stop for clothes that
--      aren't finished. It is scheduled again when the order is ready again.
--      Deliveries scheduled by hand, or already on the way, are kept.
--   2. notifications.claimed_at: when a send started. The daily cron only
--      puts back in the queue sends stuck for 15 minutes, not ones in flight
--      (it used created_at, so an old notification being sent right now could
--      go out twice).
-- ============================================================================

create or replace function app.orders_back_to_production() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.deliveries
  set status = 'cancelled',
      notes = concat_ws(E'\n', nullif(notes, ''), 'Cancelada: la orden regresó a producción.')
  where order_id = new.id
    and type = 'delivery'
    and status in ('scheduled', 'assigned')
    and notes like 'Programada automáticamente al quedar lista.%';
  return null;
end $$;

drop trigger if exists orders_back_to_production on public.orders;
create trigger orders_back_to_production
  after update of status on public.orders
  for each row
  when (old.status = 'ready' and new.status = 'in_production')
  execute function app.orders_back_to_production();

revoke all on function app.orders_back_to_production() from public, anon, authenticated;

alter table public.notifications add column if not exists claimed_at timestamptz;

-- 3. Indexes
--   The board and the order page read every stop of each order (also failed /
--   cancelled ones, which the partial unique index doesn't cover), and
--   deleting an order cascades to stops and loyalty rows by order.
create index if not exists deliveries_order on public.deliveries (order_id);
create index if not exists loyalty_order on public.loyalty_transactions (order_id) where order_id is not null;
--   Duplicates of orders_tenant_created / payments_day (same columns; a
--   b-tree reads both directions): one less index to update on every write.
drop index if exists public.orders_tenant_created_idx;
drop index if exists public.payments_tenant_created_idx;
