-- Operation model: counter only / home delivery only / hybrid.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as tenant_b from public.tenants where slug = 'lav-b' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set owner '00000000-0000-0000-0000-00000000000a'
\set owner_b '00000000-0000-0000-0000-00000000000b'
\set front '00000000-0000-0000-0000-0000000000fa'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

select test.assert((select operation_model from public.tenants where id = :'tenant_b') = 'hybrid', 'default is hybrid');

-- Tenant B (no open orders): only its owner can change it; front desk / others can't.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.throws(format($$select public.set_operation_model(%L, 'walk_in')$$, :'tenant_b'), '42501', 'other tenants cannot change it');
select test.throws(format($$update public.tenants set operation_model = 'walk_in' where id = %L$$, :'tenant_a'), '42501', 'not writable directly');
select set_config('request.jwt.claims', json_build_object('sub', :'owner_b')::text, false);
select test.throws(format($$select public.set_operation_model(%L, 'nope')$$, :'tenant_b'), 'invalid operation model', 'validated');
select public.set_operation_model(:'tenant_b', 'walk_in');
select test.assert((select m ->> 'operation_model' from jsonb_array_elements(public.my_memberships()) m where m ->> 'tenant_id' = :'tenant_b') = 'walk_in', 'app sees the model');
reset role;

-- Tenant A has open orders of both kinds: switching to a single model is refused.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.throws(format($$select public.set_operation_model(%L, 'walk_in')$$, :'tenant_a'), 'open orders of the other kind', 'open delivery orders block counter-only');
reset role;

-- Counter only: no delivery orders, no pickups/deliveries; counter orders fine.
update public.tenants set operation_model = 'walk_in' where id = :'tenant_a';
reset request.jwt.claims;
set role service_role;
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_a',
  json_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')), 'home delivery is not enabled', 'no delivery orders when counter-only');
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as walk \gset
reset role;
select test.assert((select status from public.orders where id = :'walk') = 'in_production', 'counter orders work');
select id as old_delivery from public.orders where tenant_id = :'tenant_a' and customer_id = :'customer_a' and fulfillment = 'delivery' and status not in ('delivered', 'cancelled') limit 1 \gset
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.throws(format($$select public.schedule_delivery(%L, 'delivery', current_date, null, null, null, %L)$$, :'old_delivery', :'address_a'), 'home delivery is not enabled', 'no new stops');
reset role;
-- Existing orders keep working (no fulfillment change).
update public.orders set notes = 'sigue funcionando' where id = :'old_delivery';

-- Delivery only: counter orders refused.
update public.tenants set operation_model = 'delivery' where id = :'tenant_a';
reset request.jwt.claims;
set role service_role;
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_a',
  json_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'), replace(:'priced', 'PRODUCT', :'product_wf')),
  'counter orders are not enabled', 'no counter orders when delivery-only');
reset role;

-- On a paid plan the model comes from the plan.
update public.tenants set plan = 'walk_in', operation_model = 'walk_in' where id = :'tenant_b';
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner_b')::text, false);
select test.throws(format($$select public.set_operation_model(%L, 'hybrid')$$, :'tenant_b'), 'comes from your plan', 'paid plan fixes the model');
reset role;

update public.tenants set operation_model = 'hybrid', plan = 'trial' where id in (:'tenant_a', :'tenant_b');
