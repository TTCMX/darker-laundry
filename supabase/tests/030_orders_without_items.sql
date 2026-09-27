-- A pickup booked before knowing what the customer will send.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'

\set empty '{"version":1,"lines":[],"subtotal_cents":0,"discount_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":0,"applied_discounts":[],"steps":[{"key":"list_subtotal","label":"Subtotal","amount_cents":0},{"key":"total","label":"Total","amount_cents":0}]}'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":2,"unit_price_cents":3500,"list_total_cents":7000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":7000,"discount_cents":0,"net_cents":7000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":7000,"discount_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":7000,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a'),
  :'empty'::jsonb) ->> 'id') as order_x \gset
reset role;

select test.assert((select total_cents from public.orders where id = :'order_x') = 0, 'order without items has total 0');
select test.assert((select payment_status from public.orders where id = :'order_x') = 'pending', 'order without items is not "paid"');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.schedule_delivery(:'order_x', 'pickup', current_date) is not null as ok;
select test.assert((select status from public.orders where id = :'order_x') = 'scheduled', 'pickup can be booked without items');
select public.set_order_status(:'order_x', 'picked_up');
select test.throws(format($$select public.start_production(%L)$$, :'order_x'), 'add the order items', 'production needs items');
reset role;

-- Items captured at reception.
reset request.jwt.claims;
set role service_role;
select public.svc_save_order(:'front', :'tenant_a',
  jsonb_build_object('id', :'order_x', 'customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) is not null as ok;
reset role;
select test.assert((select total_cents from public.orders where id = :'order_x') = 7000, 'priced after reception');
select test.assert((select payment_status from public.orders where id = :'order_x') = 'pending', 'now owes the total');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.start_production(:'order_x');
select test.assert((select status from public.orders where id = :'order_x') = 'in_production', 'production starts once priced');
reset role;
