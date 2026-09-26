-- ============================================================================
-- 0009 · Storage (evidence photos) and Realtime
-- Guarded so the migrations also run on plain Postgres (CI tests).
-- ============================================================================

grant select on public.customer_overview to service_role;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    -- Private bucket: photos of garments, proof of delivery, quality evidence.
    -- Files live under "<tenant_id>/..." and are served with signed URLs.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('evidence', 'evidence', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
    on conflict (id) do nothing;

    execute $p$
      create policy evidence_read on storage.objects for select to authenticated
      using (bucket_id = 'evidence' and app.is_member(app.try_uuid((storage.foldername(name))[1])))
    $p$;
    execute $p$
      create policy evidence_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'evidence' and app.is_member(app.try_uuid((storage.foldername(name))[1])))
    $p$;
  end if;

  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.orders, public.order_production_steps, public.deliveries, public.routes;
  end if;
end $$;
