-- ============================================================================
-- 0011 · Order photos
-- Photos of an order at any point of the process (reception, each production
-- step, delivery). Each photo records the order status and production step it
-- was taken at, and who took it. Files live in the private "evidence" bucket
-- under "<tenant_id>/orders/<order_id>/…".
-- ============================================================================

create table public.order_photos (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  order_id     uuid not null,
  path         text not null check (length(path) between 3 and 500),
  caption      text check (caption is null or length(caption) <= 500),
  order_status text,
  step_id      uuid,
  step_name    text,
  delivery_id  uuid,
  taken_by     uuid,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, step_id) references public.order_production_steps(tenant_id, id) on delete set null (step_id),
  foreign key (tenant_id, delivery_id) references public.deliveries(tenant_id, id) on delete set null (delivery_id)
);

create index order_photos_order on public.order_photos (tenant_id, order_id, created_at);

-- Context is stamped by the server, not trusted from the client.
create or replace function app.order_photo_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o record;
begin
  select status, current_step_id into o from public.orders where id = new.order_id and tenant_id = new.tenant_id;
  new.taken_by := app.current_actor();
  new.order_status := o.status;
  new.created_at := now();
  -- Photos must live in this tenant's folder.
  if split_part(new.path, '/', 1) <> new.tenant_id::text then
    raise exception using errcode = '22023', message = 'invalid photo path';
  end if;
  if new.step_id is null then new.step_id := o.current_step_id; end if;
  if new.step_id is not null then
    select name into new.step_name from public.order_production_steps where id = new.step_id and order_id = new.order_id;
    if new.step_name is null then new.step_id := null; end if;
  end if;
  if new.delivery_id is not null
     and not exists (select 1 from public.deliveries where id = new.delivery_id and order_id = new.order_id) then
    new.delivery_id := null;
  end if;
  return new;
end $$;

create trigger order_photos_defaults before insert on public.order_photos
  for each row execute function app.order_photo_defaults();
create trigger order_photos_audit after insert or delete on public.order_photos
  for each row execute function app.audit_row();

alter table public.order_photos enable row level security;
revoke all on public.order_photos from anon, authenticated;
grant all on public.order_photos to service_role;
grant select, delete on public.order_photos to authenticated;
grant insert (tenant_id, order_id, path, caption, step_id, delivery_id) on public.order_photos to authenticated;

-- Whoever can see the order (front desk, production, the courier of one of
-- its stops) can see and add photos. Only the author or an order editor can
-- remove one.
create policy order_photos_select on public.order_photos for select to authenticated
  using (app.can_view_order(tenant_id, order_id));
create policy order_photos_insert on public.order_photos for insert to authenticated
  with check (app.can_view_order(tenant_id, order_id));
create policy order_photos_delete on public.order_photos for delete to authenticated
  using (app.can_view_order(tenant_id, order_id)
         and (taken_by = app.current_actor() or app.has_permission(tenant_id, 'orders.edit')));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.order_photos;
  end if;
end $$;
