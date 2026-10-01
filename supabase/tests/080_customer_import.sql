-- Customer import: validation, duplicates, preview (dry run), addresses, points, permissions.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set prod '00000000-0000-0000-0000-0000000000a1'
\set owner_b '00000000-0000-0000-0000-00000000000b'
select count(*) as before_count from public.customers where tenant_id = :'tenant_a' \gset

\set rows '[{"name":"Imp Uno","phone":"55 1111 2222","email":"uno@imp.test","line1":"Calle 1 #10","neighborhood":"Centro","city":"CDMX","tags":"vip, frecuente","points":"40","customer_since":"2024-03-01"},{"name":"Imp Dos","phone":"(55) 3333-4444"},{"name":"Imp Uno otra vez","phone":"+52 1 55 1111 2222"},{"name":"","phone":"5599990000"},{"name":"Imp Malo","phone":"123"},{"name":"Imp Correo","email":"no-es-correo"},{"name":"Imp Tres","email":"TRES@IMP.TEST","points":"abc","customer_since":"ayer"}]'

set role authenticated;
-- Production staff can't import; other tenants can't import into A.
select set_config('request.jwt.claims', json_build_object('sub', :'prod')::text, false);
select test.throws(format('select public.import_customers(%L, %L)', :'tenant_a', '[]'), '42501', 'production role cannot import');
select set_config('request.jwt.claims', json_build_object('sub', :'owner_b')::text, false);
select test.throws(format('select public.import_customers(%L, %L)', :'tenant_a', '[]'), '42501', 'other tenant cannot import');

-- Preview (dry run) as the owner: full results, nothing written.
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.import_customers(:'tenant_a', :'rows'::jsonb, '{"dry_run":true}') as preview \gset
select test.assert((:'preview'::jsonb ->> 'created')::int = 3, 'preview: 3 new');
select test.assert((:'preview'::jsonb ->> 'duplicates')::int = 1, 'preview: duplicate within the file (same phone, other format)');
select test.assert((:'preview'::jsonb ->> 'errors')::int = 3, 'preview: missing name, bad phone, bad email');
select test.assert((:'preview'::jsonb #>> '{rows,4,message}') like 'Teléfono inválido%', 'bad phone message');
select test.assert(jsonb_array_length(:'preview'::jsonb #> '{rows,6,warnings}') = 2, 'bad points and date are warnings, not errors');
reset role;
select test.assert((select count(*) from public.customers where tenant_id = :'tenant_a') = :before_count, 'dry run writes nothing');
select test.assert(not exists (select 1 from public.customer_addresses where line1 = 'Calle 1 #10'), 'dry run writes no addresses');

-- Real import.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.import_customers(:'tenant_a', :'rows'::jsonb) as res \gset
select test.assert((:'res'::jsonb ->> 'created')::int = 3 and (:'res'::jsonb ->> 'duplicates')::int = 1, 'import matches the preview');
reset role;
select id as uno from public.customers where tenant_id = :'tenant_a' and phone_normalized = '+525511112222' \gset
select test.assert((select name from public.customers where id = :'uno') = 'Imp Uno', 'first occurrence wins');
select test.assert((select tags from public.customers where id = :'uno') @> array['vip', 'frecuente'], 'tags split by comma');
select test.assert((select created_at::date from public.customers where id = :'uno') = '2024-03-01', 'customer since kept');
select test.assert((select count(*) from public.customer_addresses where customer_id = :'uno' and is_default and neighborhood = 'Centro') = 1, 'address imported as default');
select test.assert(app.loyalty_balance(:'uno', null) = 40, 'opening points');
select test.assert((select email from public.customers where tenant_id = :'tenant_a' and name = 'Imp Tres') = 'tres@imp.test', 'email lowercased');

-- Import again with "update": fills empty fields, adds tags/addresses, never doubles points.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.import_customers(:'tenant_a',
  '[{"name":"Otro nombre","phone":"5511112222","email":"nuevo@imp.test","tags":"empresa","line1":"Oficina 5","points":"40"},{"name":"Imp Dos","phone":"5533334444","email":"dos@imp.test"}]'::jsonb,
  '{"on_duplicate":"update"}') as upd \gset
select test.assert((:'upd'::jsonb ->> 'updated')::int = 2, 'both updated');
reset role;
select test.assert((select name from public.customers where id = :'uno') = 'Imp Uno', 'name not overwritten');
select test.assert((select email from public.customers where id = :'uno') = 'uno@imp.test', 'existing email kept');
select test.assert((select tags from public.customers where id = :'uno') @> array['vip', 'empresa'], 'tags merged');
select test.assert((select count(*) from public.customer_addresses where customer_id = :'uno') = 2, 'new address added');
select test.assert(app.loyalty_balance(:'uno', null) = 40, 'points not doubled');
select test.assert((select email from public.customers where tenant_id = :'tenant_a' and name = 'Imp Dos') = 'dos@imp.test', 'empty email filled');

-- Front desk can import customers but not load points.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.import_customers(:'tenant_a', '[{"name":"Imp Front","phone":"5577778888","points":"10"}]'::jsonb) as fr \gset
select test.assert((:'fr'::jsonb ->> 'created')::int = 1, 'front desk imports');
select test.assert((:'fr'::jsonb #>> '{rows,0,warnings,0}') = 'Sin permiso para cargar puntos', 'points need loyalty.manage');
select test.throws(format('select public.import_customers(%L, %L)', :'tenant_a', (select jsonb_agg(jsonb_build_object('name', 'x' || g)) from generate_series(1, 1001) g)), '22023', 'batch limit');
reset role;
