-- Orders and their stops can be edited at any time.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as order_1, customer_id as customer_a from public.orders where tenant_id = :'tenant_a' and number = 1 \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set prod1 '00000000-0000-0000-0000-0000000000a1'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":3,"unit_price_cents":3500,"list_total_cents":10500,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10500,"discount_cents":0,"net_cents":10500,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10500,"discount_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10500,"applied_discounts":[],"steps":[]}'

select test.assert((select status from public.orders where id = :'order_1') = 'delivered', 'fixture: order 1 is delivered');

-- A delivered order can still be corrected.
reset request.jwt.claims;
set role service_role;
select public.svc_save_order(:'front', :'tenant_a',
  jsonb_build_object('id', :'order_1', 'customer_id', :'customer_a', 'fulfillment', 'delivery', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) is not null as ok;
reset role;
select test.assert((select total_cents from public.orders where id = :'order_1') = 10500, 'delivered order re-priced');
select test.assert((select status from public.orders where id = :'order_1') = 'delivered', 'status unchanged by edits');

-- Front desk reschedules a pickup: new day, new address, then cancels it.
insert into public.customer_addresses (tenant_id, customer_id, line1) values (:'tenant_a', :'customer_a', 'Oficina 22');
select id as address_b from public.customer_addresses where customer_id = :'customer_a' and line1 = 'Oficina 22' \gset
reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a'),
  '{"version":1,"lines":[],"subtotal_cents":0,"discount_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":0,"applied_discounts":[],"steps":[]}'::jsonb) ->> 'id') as order_y \gset
reset role;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.schedule_delivery(:'order_y', 'pickup', current_date) as stop_y \gset
select public.update_delivery(:'stop_y', current_date + 2, 'Tarde', '13:00', '18:00', null, 'Tocar timbre', true, :'address_b');
select test.assert((select scheduled_date from public.deliveries where id = :'stop_y') = current_date + 2, 'rescheduled');
select test.assert((select address ->> 'line1' from public.deliveries where id = :'stop_y') = 'Oficina 22', 'address changed with snapshot');
select test.assert((select courier_id from public.deliveries where id = :'stop_y') is null, 'courier cleared');
select test.throws(format($$select public.update_delivery(%L, null, null, null, null, null, null, false, %L)$$, :'stop_y', gen_random_uuid()),
  'valid customer address', 'address must belong to the customer');
select public.update_delivery_status(:'stop_y', 'cancelled', 'Cliente no estará');
select test.assert((select status from public.deliveries where id = :'stop_y') = 'cancelled', 'front desk can cancel a stop');

-- Production staff cannot edit stops.
select public.schedule_delivery(:'order_y', 'pickup', current_date) as stop_z \gset
select set_config('request.jwt.claims', json_build_object('sub', :'prod1')::text, false);
select test.throws(format($$select public.update_delivery(%L, current_date + 1)$$, :'stop_z'), '42501', 'production cannot reschedule');
reset role;
