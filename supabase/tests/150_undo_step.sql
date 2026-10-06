-- Undo one step of an order (fat-finger mistakes).
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as address_a from public.customer_addresses where customer_id = :'customer_a' limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set prod '00000000-0000-0000-0000-0000000000a1'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as o_counter \gset
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery',
  'pickup_address_id', :'address_a', 'delivery_address_id', :'address_a'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as o_home \gset
reset role;

set role authenticated;
-- Counter order: in production from the start, nothing before the first phase.
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.assert((select status from public.orders where id = :'o_counter') = 'in_production', 'counter order starts in production');
select test.throws(format($$select public.undo_order_step(%L)$$, :'o_counter'), 'nothing to undo', 'nothing before the first phase');

-- A worker finishes a phase by mistake and takes it back; can't reopen someone else's.
select id as s1 from public.order_production_steps where order_id = :'o_counter' order by position limit 1 \gset
select set_config('request.jwt.claims', json_build_object('sub', :'prod')::text, false);
select public.assign_production_step(:'s1', :'prod');
select public.complete_production_step(:'s1');
select test.assert(public.undo_order_step(:'o_counter') = 'in_production', 'worker undoes own phase');
select test.assert((select status from public.order_production_steps where id = :'s1') = 'pending', 'phase reopened');
select test.assert((select current_step_id from public.orders where id = :'o_counter') = :'s1', 'current phase back');
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.complete_production_step(:'s1');
select set_config('request.jwt.claims', json_build_object('sub', :'prod')::text, false);
select test.throws(format($$select public.undo_order_step(%L)$$, :'o_counter'), '42501', 'worker cannot reopen the owner''s phase');

-- Delivered by mistake → back to ready; ready → last phase.
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.set_order_status(:'o_counter', 'ready');
select public.set_order_status(:'o_counter', 'delivered');
select test.assert(public.undo_order_step(:'o_counter') = 'ready', 'delivered → ready');
select test.assert((select delivered_at is null from public.orders where id = :'o_counter'), 'delivered_at cleared');
select test.assert(public.undo_order_step(:'o_counter') = 'in_production', 'ready → last phase');
select test.assert((select count(*) from public.order_production_steps where order_id = :'o_counter' and status = 'pending') = 4,
  'skipped phases reopened');

-- Home order: pickup completed by mistake → back to scheduled with its stop.
select public.schedule_delivery(:'o_home', 'pickup', current_date, null, null, null, :'address_a') as pickup \gset
select test.assert((select status from public.orders where id = :'o_home') = 'scheduled', 'pickup booked');
select public.update_delivery_status(:'pickup', 'completed');
select test.assert((select status from public.orders where id = :'o_home') = 'in_production', 'collected → production');
select test.assert(public.undo_order_step(:'o_home') = 'scheduled', 'undo the pickup');
select test.assert((select status from public.deliveries where id = :'pickup') in ('scheduled', 'assigned'), 'pickup stop reopened');
select public.update_delivery_status(:'pickup', 'completed');

-- On the way / delivered at home → ready, stop reopened.
select public.set_order_status(:'o_home', 'ready');
select id as dstop from public.deliveries where order_id = :'o_home' and type = 'delivery' \gset
select public.update_delivery_status(:'dstop', 'en_route');
select test.assert((select status from public.orders where id = :'o_home') = 'out_for_delivery', 'on the way');
select test.assert(public.undo_order_step(:'o_home') = 'ready', 'on the way → ready');
select test.assert((select status from public.deliveries where id = :'dstop') in ('scheduled', 'assigned'), 'stop back to scheduled');
select public.update_delivery_status(:'dstop', 'completed');
select test.assert((select status from public.orders where id = :'o_home') = 'delivered', 'delivered');
select test.assert(public.undo_order_step(:'o_home') = 'ready', 'delivered at home → ready');
select test.assert((select status from public.deliveries where id = :'dstop') in ('scheduled', 'assigned'), 'delivery stop reopened');

-- Audited.
reset role;
select test.assert(exists (select 1 from public.audit_log where entity_id = :'o_home' and context ->> 'event' = 'order.step_undone'),
  'undo audited');
