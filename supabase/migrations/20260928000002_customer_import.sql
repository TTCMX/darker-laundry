-- ============================================================================
-- Customer import (from another system: Excel / CSV)
--   * public.import_customers(tenant, rows, options) imports up to 1000 rows
--     per call; the app sends big files in batches.
--   * Duplicates are detected by phone (normalized) or email, against the
--     existing customers and against earlier rows of the same file.
--   * options.dry_run runs everything and rolls it back: the preview shows
--     exactly what the import will do.
--   * options.on_duplicate: 'skip' (default) or 'update' (fills empty fields,
--     adds tags and new addresses; never overwrites data already captured).
--   * Opening points balance: only with loyalty.manage, and only for customers
--     whose balance is 0 (re-importing the same file never doubles points).
-- ============================================================================

create or replace function public.import_customers(p_tenant uuid, p_rows jsonb, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_dry boolean := coalesce((p_options ->> 'dry_run')::boolean, false);
  v_update boolean := coalesce(p_options ->> 'on_duplicate', 'skip') = 'update';
  v_can_points boolean;
  v_country text;
  v_results jsonb := '[]'::jsonb;
  v_row jsonb;
  v_i int := 0;
  v_name text;
  v_phone text;
  v_phone_n text;
  v_email text;
  v_notes text;
  v_tags text[];
  v_since timestamptz;
  v_points int;
  v_line1 text;
  v_existing public.customers%rowtype;
  v_id uuid;
  v_status text;
  v_msg text;
  v_warn text[];
  v_created int := 0;
  v_updated int := 0;
  v_skipped int := 0;
  v_errors int := 0;
begin
  perform app.require_permission(p_tenant, 'customers.edit');
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'rows must be an array';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception using errcode = '22023', message = 'at most 1000 rows per call';
  end if;
  v_can_points := app.has_permission(p_tenant, 'loyalty.manage');
  select country into v_country from public.tenants where id = p_tenant;

  begin
    for v_row in select value from jsonb_array_elements(p_rows) loop
      v_i := v_i + 1;
      v_id := null;
      v_warn := '{}';
      v_status := null;
      v_msg := null;
      v_name := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
      v_phone := nullif(btrim(coalesce(v_row ->> 'phone', '')), '');
      v_email := nullif(lower(btrim(coalesce(v_row ->> 'email', ''))), '');
      v_notes := nullif(btrim(coalesce(v_row ->> 'notes', '')), '');
      v_line1 := nullif(btrim(coalesce(v_row ->> 'line1', '')), '');
      v_tags := coalesce(
        (select array_agg(distinct lower(btrim(t))) from jsonb_array_elements_text(
           case jsonb_typeof(v_row -> 'tags') when 'array' then v_row -> 'tags'
                else to_jsonb(regexp_split_to_array(coalesce(v_row ->> 'tags', ''), '\s*[,;]\s*')) end) t
         where btrim(t) <> ''), '{}');
      v_phone_n := app.normalize_phone(v_phone, v_country);

      if v_name is null then
        v_status := 'error'; v_msg := 'Falta el nombre';
      elsif length(v_name) > 120 then
        v_status := 'error'; v_msg := 'Nombre demasiado largo';
      elsif v_phone is not null and v_phone_n is null then
        v_status := 'error'; v_msg := format('Teléfono inválido: %s', v_phone);
      elsif v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        v_status := 'error'; v_msg := format('Correo inválido: %s', v_email);
      end if;

      begin
        v_points := nullif(btrim(coalesce(v_row ->> 'points', '')), '')::numeric::int;
      exception when others then
        v_points := null;
        v_warn := v_warn || 'Puntos no numéricos: ignorados'::text;
      end;
      begin
        v_since := nullif(btrim(coalesce(v_row ->> 'customer_since', '')), '')::date::timestamptz;
        if v_since > now() then v_since := null; v_warn := v_warn || 'Fecha de alta futura: ignorada'::text; end if;
      exception when others then
        v_since := null;
        v_warn := v_warn || 'Fecha de alta no reconocida: ignorada'::text;
      end;

      if v_status is null then
        -- Same person already registered (or earlier in this file)?
        select * into v_existing from public.customers c
        where c.tenant_id = p_tenant
          and ((v_phone_n is not null and c.phone_normalized = v_phone_n)
               or (v_email is not null and c.email = v_email))
        order by (c.phone_normalized = v_phone_n) desc nulls last
        limit 1;

        begin
          if v_existing.id is not null and not v_update then
            v_status := 'duplicate';
            v_id := v_existing.id;
            v_msg := format('Ya existe: %s', v_existing.name);
          elsif v_existing.id is not null then
            v_id := v_existing.id;
            update public.customers set
              phone = coalesce(phone, v_phone),
              email = coalesce(email, case when not exists (
                        select 1 from public.customers x where x.tenant_id = p_tenant and x.email = v_email and x.id <> v_existing.id)
                      then v_email end),
              notes = case when v_notes is null or coalesce(notes, '') like '%' || v_notes || '%' then notes
                           else nullif(concat_ws(E'\n', notes, v_notes), '') end,
              tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || v_tags) t)
            where id = v_existing.id;
            v_status := 'updated';
            v_msg := format('Se completó: %s', v_existing.name);
          else
            insert into public.customers (tenant_id, name, phone, email, notes, tags, created_at)
            values (p_tenant, v_name, v_phone, v_email, v_notes, v_tags, coalesce(v_since, now()))
            returning id into v_id;
            v_status := 'created';
          end if;

          if v_status in ('created', 'updated') and v_line1 is not null
             and not exists (select 1 from public.customer_addresses a where a.customer_id = v_id and lower(btrim(a.line1)) = lower(v_line1)) then
            insert into public.customer_addresses (tenant_id, customer_id, label, line1, line2, neighborhood, city, state, postal_code, instructions, is_default)
            values (p_tenant, v_id, 'Casa', left(v_line1, 200),
                    nullif(btrim(coalesce(v_row ->> 'line2', '')), ''),
                    nullif(btrim(coalesce(v_row ->> 'neighborhood', '')), ''),
                    nullif(btrim(coalesce(v_row ->> 'city', '')), ''),
                    nullif(btrim(coalesce(v_row ->> 'state', '')), ''),
                    nullif(btrim(coalesce(v_row ->> 'postal_code', '')), ''),
                    nullif(btrim(coalesce(v_row ->> 'instructions', '')), ''),
                    not exists (select 1 from public.customer_addresses a where a.customer_id = v_id));
          end if;

          if v_status in ('created', 'updated') and coalesce(v_points, 0) <> 0 then
            if not v_can_points then
              v_warn := v_warn || 'Sin permiso para cargar puntos'::text;
            elsif v_points < 0 then
              v_warn := v_warn || 'Puntos negativos: ignorados'::text;
            elsif app.loyalty_balance(v_id, null) <> 0 then
              v_warn := v_warn || 'Ya tenía puntos: no se cambiaron'::text;
            else
              insert into public.loyalty_transactions (tenant_id, customer_id, kind, points, note, created_by)
              values (p_tenant, v_id, 'adjust', v_points, 'Saldo inicial (importación)', app.current_actor());
            end if;
          end if;
        exception when others then
          v_status := 'error';
          v_msg := sqlerrm;
          v_id := null;
        end;
      end if;

      case v_status
        when 'created' then v_created := v_created + 1;
        when 'updated' then v_updated := v_updated + 1;
        when 'duplicate' then v_skipped := v_skipped + 1;
        else v_errors := v_errors + 1;
      end case;
      v_results := v_results || jsonb_build_object(
        'index', v_i - 1, 'status', v_status, 'message', v_msg, 'customer_id', v_id,
        'phone', v_phone_n, 'warnings', to_jsonb(v_warn));
    end loop;

    if v_dry then
      raise exception using errcode = 'P0DRY', message = 'dry run';
    end if;
  exception when sqlstate 'P0DRY' then
    null; -- preview: every change above is rolled back, the results are kept
  end;

  return jsonb_build_object(
    'dry_run', v_dry, 'created', v_created, 'updated', v_updated, 'duplicates', v_skipped, 'errors', v_errors,
    'rows', v_results);
end $$;

revoke all on function public.import_customers(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.import_customers(uuid, jsonb, jsonb) to authenticated;
