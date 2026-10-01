-- Free trial: 3 months from registration, then read-only.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as some_order from public.orders where tenant_id = :'tenant_a' and status = 'created' limit 1 \gset
\set owner '00000000-0000-0000-0000-00000000000a'
\set front '00000000-0000-0000-0000-0000000000fa'

-- New businesses: trial until 3 months after registration.
select test.assert((select trial_ends_at::date from public.tenants where id = :'tenant_a') = (created_at + interval '3 months')::date, 'trial is 3 months')
from public.tenants where id = :'tenant_a';
select test.assert(app.tenant_access(:'tenant_a') = 'full', 'full access during the trial');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.assert((select m ->> 'access' from jsonb_array_elements(public.my_memberships()) m where m ->> 'tenant_id' = :'tenant_a') = 'full', 'app sees full access');
-- Businesses can't extend their own trial.
select test.throws(format($$update public.tenants set trial_ends_at = now() + interval '10 years' where id = %L$$, :'tenant_a'), '42501', 'trial date not writable');
reset role;

-- Trial over → read-only.
update public.tenants set trial_ends_at = now() - interval '1 minute' where id = :'tenant_a';
select test.assert(app.tenant_access(:'tenant_a') = 'read_only', 'read-only after the trial');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
-- Reads still work.
select test.assert((select count(*) from public.orders where tenant_id = :'tenant_a') > 0, 'orders still visible');
select test.assert((select count(*) from public.customers where tenant_id = :'tenant_a') > 0, 'customers still visible');
-- Writes are blocked (RLS and functions).
select test.throws(format($$insert into public.customers (tenant_id, name) values (%L, 'Nuevo en solo lectura')$$, :'tenant_a'), '42501', 'no new customers');
select test.throws(format($$select public.start_production(%L)$$, :'some_order'), '42501', 'no status changes');
select test.throws(format($$select public.record_payment(%L, 100, 'cash', 'ro-1')$$, :'some_order'), '42501', 'no payments');
select test.throws(format($$select public.import_customers(%L, '[]')$$, :'tenant_a'), '42501', 'no imports');

select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.assert((select m ->> 'access' from jsonb_array_elements(public.my_memberships()) m where m ->> 'tenant_id' = :'tenant_a') = 'read_only', 'app sees read-only');
-- Reports and settings still work for the owner.
select test.assert(public.analytics_sales(:'tenant_a', current_date - 7, current_date) ? 'current', 'reports still work');
update public.tenants set settings = settings where id = :'tenant_a';
reset role;
-- The API (service role acting for the owner) is blocked too.
reset request.jwt.claims;
set role service_role;
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, '{"total_cents":0,"subtotal_cents":0,"discount_cents":0,"delivery_fee_cents":0,"tax_cents":0,"lines":[]}'::jsonb)$$,
  :'owner', :'tenant_a', json_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in')), 'missing permission', 'API order creation blocked');
reset role;

-- Exempt (internal) or extended → full again.
update public.tenants set plan = 'internal' where id = :'tenant_a';
select test.assert(app.tenant_access(:'tenant_a') = 'full', 'internal plan is exempt');
update public.tenants set plan = 'trial', trial_ends_at = now() + interval '1 month' where id = :'tenant_a';
select test.assert(app.tenant_access(:'tenant_a') = 'full', 'extended trial');
update public.tenants set plan_status = 'suspended' where id = :'tenant_a';
select test.assert(app.tenant_access(:'tenant_a') = 'read_only', 'suspended is read-only');
update public.tenants set plan_status = 'active', trial_ends_at = created_at + interval '3 months' where id = :'tenant_a';
