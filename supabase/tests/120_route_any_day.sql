-- A route takes ready deliveries scheduled for another day and moves them to its day.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set driver '00000000-0000-0000-0000-0000000000d1'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery',
  'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a', 'promised_at', now() + interval '5 days'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as ord \gset
reset role;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.set_order_status(:'ord', 'picked_up');
select public.complete_production_step(id) from public.order_production_steps where order_id = :'ord' order by position;
reset role;
select id as stop from public.deliveries where order_id = :'ord' and type = 'delivery' \gset
select test.assert((select scheduled_date from public.deliveries where id = :'stop') > current_date, 'scheduled for a later day');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.save_route(:'tenant_a', null, current_date, 'Hoy', :'driver', array[:'stop']::uuid[]) as route \gset
reset role;
select test.assert((select scheduled_date from public.deliveries where id = :'stop') = current_date, 'moved to the route day');
select test.assert((select route_id from public.deliveries where id = :'stop') = :'route'::uuid, 'on the route');
select test.assert((select stop_position from public.deliveries where id = :'stop') = 1, 'first stop');
