-- Orders flow into production by themselves; home deliveries get on the route when ready.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set driver '00000000-0000-0000-0000-0000000000d1'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'
\set empty '{"version":1,"lines":[],"subtotal_cents":0,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":0,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
-- Counter order with services → production right away.
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as walk \gset
-- Pickup order booked without services.
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery',
  'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a', 'promised_at', now() + interval '3 days'), :'empty'::jsonb) ->> 'id') as pick \gset
reset role;
select test.assert((select status from public.orders where id = :'walk') = 'in_production', 'counter order goes straight to production');
select test.assert((select count(*) from public.order_production_steps where order_id = :'walk') > 0, 'with its production steps');
select test.assert((select status from public.orders where id = :'pick') = 'created', 'pickup order waits for the clothes');

-- Received without services: waits in "received"; capturing them starts production.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.set_order_status(:'pick', 'picked_up');
reset role;
select test.assert((select status from public.orders where id = :'pick') = 'picked_up', 'no services yet: stays received');
reset request.jwt.claims;
set role service_role;
select public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('id', :'pick', 'customer_id', :'customer_a', 'fulfillment', 'delivery',
  'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a', 'promised_at', now() + interval '3 days'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb);
reset role;
select test.assert((select status from public.orders where id = :'pick') = 'in_production', 'services captured → production');

-- Production finishes → the delivery is scheduled by itself, on the promised day.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.complete_production_step(id) from public.order_production_steps where order_id = :'pick' order by position;
reset role;
select test.assert((select status from public.orders where id = :'pick') = 'ready', 'ready');
select test.assert((select count(*) from public.deliveries where order_id = :'pick' and type = 'delivery' and status in ('scheduled', 'assigned')) = 1,
  'delivery stop created');
select test.assert((select scheduled_date from public.deliveries where order_id = :'pick' and type = 'delivery')
  >= (select (promised_at at time zone t.timezone)::date from public.orders o join public.tenants t on t.id = o.tenant_id where o.id = :'pick'),
  'not before the promised day');
select test.assert((select window_label is not null from public.deliveries where order_id = :'pick' and type = 'delivery'), 'with a time window');
select test.assert((select courier_id from public.deliveries where order_id = :'pick' and type = 'delivery') = :'driver'::uuid,
  'assigned to the only courier');

-- A failed delivery is not rescheduled by itself.
select id as stop from public.deliveries where order_id = :'pick' and type = 'delivery' \gset
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'driver')::text, false);
select public.update_delivery_status(:'stop', 'en_route');
select public.update_delivery_status(:'stop', 'failed', null, 'No había nadie');
reset role;
select test.assert((select status from public.orders where id = :'pick') = 'ready', 'back to ready');
select test.assert((select count(*) from public.deliveries where order_id = :'pick' and type = 'delivery' and status in ('scheduled', 'assigned')) = 0,
  'failed delivery is rescheduled by hand');

-- Counter orders never get a delivery stop.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.complete_production_step(id) from public.order_production_steps where order_id = :'walk' order by position;
reset role;
select test.assert((select status from public.orders where id = :'walk') = 'ready', 'counter order ready');
select test.assert(not exists (select 1 from public.deliveries where order_id = :'walk'), 'no stop for counter orders');
