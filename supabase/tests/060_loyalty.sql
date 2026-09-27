-- Loyalty program: earn on delivered + paid, redeem inside orders, adjustments.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":10,"unit_price_cents":2500,"list_total_cents":25000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":25000,"discount_cents":0,"net_cents":25000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":25000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":25000,"applied_discounts":[],"steps":[]}'

-- Same cases as src/domain/domain.test.ts (pointsEarned).
select test.assert(app.loyalty_points_for(25000, '{"loyalty":{"enabled":true,"points_per_step":1,"step_cents":1000}}') = 25, 'amount mode');
select test.assert(app.loyalty_points_for(999, '{"loyalty":{"enabled":true,"points_per_step":1,"step_cents":1000}}') = 0, 'below one step');
select test.assert(app.loyalty_points_for(10000, '{"loyalty":{"enabled":true,"points_per_step":5,"step_cents":5000}}') = 10, 'custom steps');
select test.assert(app.loyalty_points_for(100, '{"loyalty":{"enabled":true,"earn_mode":"orders","points_per_order":10}}') = 10, 'orders mode');
select test.assert(app.loyalty_points_for(5000, '{"loyalty":{"enabled":true,"min_order_cents":10000}}') = 0, 'minimum order');
select test.assert(app.loyalty_points_for(50000, '{}') = 0, 'disabled by default');

-- Turn the program on: 1 point per $10, each point worth $1, min 10 to redeem.
update public.tenants set settings = settings || '{"loyalty":{"enabled":true,"earn_mode":"amount","points_per_step":1,"step_cents":1000,"point_value_cents":100,"min_redeem_points":10}}'
where id = :'tenant_a';

reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as order_l \gset
reset role;

select app.loyalty_balance(:'customer_a', null) as start_balance \gset
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.set_order_status(:'order_l', 'in_production');
reset role;
-- Owner marks ready (production.manage) and it gets delivered unpaid: no points yet.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.set_order_status(:'order_l', 'ready');
select public.set_order_status(:'order_l', 'delivered');
select test.assert(not exists (select 1 from public.loyalty_transactions where order_id = :'order_l'), 'unpaid orders earn nothing');
select public.record_payment(:'order_l', 25000, 'cash', 'loyalty-1');
select test.assert((select points from public.loyalty_transactions where order_id = :'order_l' and kind = 'earn') = 25, 'earned on delivered + paid');
select public.record_payment(:'order_l', 1, 'cash', 'loyalty-1');
select test.assert((select count(*) from public.loyalty_transactions where order_id = :'order_l') = 1, 'earned once');
select test.assert((select points_balance from public.customer_overview where id = :'customer_a') = :start_balance + 25, 'customer 360 shows the balance');
reset role;
select test.assert(app.loyalty_balance(:'customer_a', null) = :start_balance + 25, 'balance includes the earn');

-- Redeem 20 points ($20) on a new order.
reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(replace(replace(:'priced', 'PRODUCT', :'product_wf'), '"points_redeemed":0,"credit_cents":0', '"points_redeemed":20,"credit_cents":2000'), '"total_cents":25000', '"total_cents":23000')::jsonb) ->> 'id') as order_r \gset
select test.assert((select points from public.loyalty_transactions where order_id = :'order_r' and kind = 'redeem') = -20, 'redemption recorded');
select test.assert((select total_cents from public.orders where id = :'order_r') = 23000, 'total reduced by the points');
-- Wrong point value or more points than available are rejected.
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(replace(replace(:'priced', 'PRODUCT', :'product_wf'), '"points_redeemed":0,"credit_cents":0', '"points_redeemed":20,"credit_cents":5000'), '"total_cents":25000', '"total_cents":20000')),
  'inconsistent pricing', 'point value must match the settings');
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(replace(replace(:'priced', 'PRODUCT', :'product_wf'), '"points_redeemed":0,"credit_cents":0', '"points_redeemed":9000,"credit_cents":900000'), '"total_cents":25000', '"total_cents":-875000')),
  'inconsistent pricing', 'cannot redeem beyond the total');
-- Editing the same order keeps a single redemption row.
select public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('id', :'order_r', 'customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(replace(replace(:'priced', 'PRODUCT', :'product_wf'), '"points_redeemed":0,"credit_cents":0', '"points_redeemed":15,"credit_cents":1500'), '"total_cents":25000', '"total_cents":23500')::jsonb) is not null as ok;
select test.assert((select count(*) from public.loyalty_transactions where order_id = :'order_r') = 1, 'one redemption row per order');
select test.assert((select points from public.loyalty_transactions where order_id = :'order_r') = -15, 'redemption updated');
reset role;

-- Cancelling returns the points.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.set_order_status(:'order_r', 'cancelled', 'prueba');
select test.assert(not exists (select 1 from public.loyalty_transactions where order_id = :'order_r'), 'cancel returns redeemed points');

-- Adjustments need loyalty.manage and a reason.
select public.adjust_loyalty_points(:'customer_a', 50, 'Cortesía') is not null as ok;
select test.throws(format($$select public.adjust_loyalty_points(%L, 5, '')$$, :'customer_a'), 'reason', 'reason required');
select test.throws(format($$select public.adjust_loyalty_points(%L, -100000, 'x')$$, :'customer_a'), 'not enough', 'no negative balance');
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select test.throws(format($$select public.adjust_loyalty_points(%L, 5, 'x')$$, :'customer_a'), '42501', 'front desk cannot adjust');
select test.throws($$insert into public.loyalty_transactions (tenant_id, customer_id, kind, points) values (gen_random_uuid(), gen_random_uuid(), 'adjust', 5)$$,
  '42501', 'ledger is not directly writable');
select test.assert((select count(*) from public.loyalty_transactions where customer_id = :'customer_a') > 0, 'front desk sees the ledger');
reset role;

-- Public tracking shows points.
select public_token as tok from public.orders where id = :'order_l' \gset
set role anon;
reset request.jwt.claims;
select test.assert((public.get_public_order(:'tok') -> 'loyalty' ->> 'points_earned')::int = 25, 'tracking shows points earned');
reset role;

-- Turn the program off again for later tests.
update public.tenants set settings = settings - 'loyalty' where id = :'tenant_a';
