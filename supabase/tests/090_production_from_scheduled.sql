-- An order with a booked pickup can go straight to production, and the
-- pending pickup is cancelled once the clothes are in the store.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set driver '00000000-0000-0000-0000-0000000000d1'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as ord_p \gset
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as ord_r \gset
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as ord_c \gset
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.schedule_delivery(:'ord_p', 'pickup', current_date, 'Mañana', '09:00', '13:00') as pk_p \gset
select public.schedule_delivery(:'ord_r', 'pickup', current_date, 'Mañana', '09:00', '13:00') as pk_r \gset
select public.schedule_delivery(:'ord_c', 'pickup', current_date, 'Mañana', '09:00', '13:00') as pk_c \gset
select test.assert((select status from public.orders where id = :'ord_p') = 'scheduled', 'booking a pickup schedules the order');

-- Straight to production from "scheduled" (was: invalid status change).
select public.start_production(:'ord_p');
reset role;
select test.assert((select status from public.orders where id = :'ord_p') = 'in_production', 'scheduled → in production');
select test.assert((select count(*) from public.order_production_steps where order_id = :'ord_p') > 0, 'production steps created');
select test.assert((select status from public.deliveries where id = :'pk_p') = 'cancelled', 'pending pickup cancelled');
select test.assert((select notes from public.deliveries where id = :'pk_p') like '%se recibió en tienda%', 'with the reason');

-- Received at the counter: same.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.set_order_status(:'ord_r', 'picked_up');
reset role;
select test.assert((select status from public.deliveries where id = :'pk_r') = 'cancelled', 'counter reception cancels the pickup');

-- The courier completing the pickup keeps it completed.
update public.deliveries set courier_id = :'driver', status = 'assigned' where id = :'pk_c';
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'driver')::text, false);
select public.update_delivery_status(:'pk_c', 'completed');
reset role;
select test.assert((select status from public.deliveries where id = :'pk_c') = 'completed', 'courier pickup stays completed');
select test.assert((select status from public.orders where id = :'ord_c') = 'in_production', 'and the order goes into production');
