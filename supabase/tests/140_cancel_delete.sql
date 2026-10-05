-- Cancel at any point before delivery; delete orders without payments.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as o_ready \gset
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as o_mistake \gset
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as o_paid \gset
reset role;
select number as mistake_number from public.orders where id = :'o_mistake' \gset

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
-- A ready order can be cancelled (was: invalid status change).
select public.set_order_status(:'o_ready', 'ready');
select public.set_order_status(:'o_ready', 'cancelled', 'El cliente ya no la quiso');
select test.assert((select status from public.orders where id = :'o_ready') = 'cancelled', 'ready → cancelled');

-- Front desk can't delete; a reason is required; orders with payments can't be deleted.
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select test.throws(format($$select public.delete_order(%L, 'x')$$, :'o_mistake'), '42501', 'front desk cannot delete');
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.throws(format($$select public.delete_order(%L, '  ')$$, :'o_mistake'), 'a reason is required', 'reason required');
select public.record_payment(:'o_paid', 1000, 'cash', 'del-1');
select test.throws(format($$select public.delete_order(%L, 'error')$$, :'o_paid'), 'the order has payments', 'paid orders are cancelled, not deleted');

-- Deleted with everything that hangs from it; the audit log keeps the record.
select public.delete_order(:'o_mistake', 'Creada por error');
reset role;
select test.assert(not exists (select 1 from public.orders where id = :'o_mistake'), 'order deleted');
select test.assert(not exists (select 1 from public.order_production_steps where order_id = :'o_mistake'), 'steps deleted');
select test.assert(exists (select 1 from public.audit_log where entity_id = :'o_mistake' and action = 'delete'
  and context ->> 'note' = 'Creada por error'), 'deletion audited with its reason');
select test.assert(:mistake_number > 0, 'had a number');
