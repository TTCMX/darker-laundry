-- Back to production: the delivery scheduled by itself goes away, and comes back when ready again.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery',
  'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as o_home \gset
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.set_order_status(:'o_home', 'picked_up');
select public.set_order_status(:'o_home', 'ready');
select test.assert((select count(*) from public.deliveries where order_id = :'o_home' and type = 'delivery'
  and status in ('scheduled', 'assigned')) = 1, 'ready: delivery scheduled by itself');
select public.undo_order_step(:'o_home');
select test.assert((select status from public.orders where id = :'o_home') = 'in_production', 'back in production');
select test.assert(not exists (select 1 from public.deliveries where order_id = :'o_home' and type = 'delivery'
  and status in ('scheduled', 'assigned')), 'automatic delivery cancelled');
select public.set_order_status(:'o_home', 'ready');
select test.assert((select count(*) from public.deliveries where order_id = :'o_home' and type = 'delivery'
  and status in ('scheduled', 'assigned')) = 1, 'scheduled again when ready again');
reset role;
