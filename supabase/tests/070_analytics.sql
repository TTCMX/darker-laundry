-- Analytics back office: permissions, ranges and numbers that match the data.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select app.tenant_today(:'tenant_a') as today \gset
select (app.tenant_today(:'tenant_a') - 1) as yesterday \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set owner '00000000-0000-0000-0000-00000000000a'
\set owner_b '00000000-0000-0000-0000-00000000000b'
\set priced '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","quantity":4,"unit_price_cents":2500,"list_total_cents":10000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":10000,"discount_cents":0,"net_cents":10000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":10000,"discount_cents":0,"points_redeemed":0,"credit_cents":0,"delivery_fee_cents":0,"tax_cents":0,"total_cents":10000,"applied_discounts":[],"steps":[]}'

-- Two orders today and one moved to yesterday (previous period).
reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as an_1 \gset
select (public.svc_save_order(:'owner', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as an_2 \gset
select (public.svc_save_order(:'owner', :'tenant_a', jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in'),
  replace(:'priced', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as an_old \gset
reset role;
update public.orders set created_at = created_at - interval '1 day' where id = :'an_old';

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.record_payment(:'an_1', 4000, 'cash', 'analytics-1');
select public.record_payment(:'an_2', 10000, 'card', 'analytics-2');
reset role;

-- Expected values, computed directly.
select count(*) as exp_orders, sum(total_cents) as exp_sales, sum(balance_cents) as exp_balance
from public.orders where tenant_id = :'tenant_a' and status <> 'cancelled'
  and (created_at at time zone (select timezone from public.tenants where id = :'tenant_a'))::date = :'today' \gset
select count(*) as exp_prev_orders from public.orders where tenant_id = :'tenant_a' and status <> 'cancelled'
  and (created_at at time zone (select timezone from public.tenants where id = :'tenant_a'))::date = :'yesterday' \gset
select coalesce(sum(case when kind = 'payment' then amount_cents else -amount_cents end), 0) as exp_collected
from public.payments where tenant_id = :'tenant_a' and status = 'succeeded'
  and (created_at at time zone (select timezone from public.tenants where id = :'tenant_a'))::date = :'today' \gset
select coalesce(sum(amount_cents), 0) as exp_owner_collected from public.payments
where tenant_id = :'tenant_a' and status = 'succeeded' and kind = 'payment' and recorded_by = :'owner'
  and (created_at at time zone (select timezone from public.tenants where id = :'tenant_a'))::date = :'today' \gset

-- Permissions: front desk and other tenants can't read reports.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select test.throws(format('select public.analytics_sales(%L, %L, %L)', :'tenant_a', :'today', :'today'), '42501', 'front desk has no reports.view');
select set_config('request.jwt.claims', json_build_object('sub', :'owner_b')::text, false);
select test.throws(format('select public.analytics_customers(%L, %L, %L)', :'tenant_a', :'today', :'today'), '42501', 'other tenants are isolated');
select test.throws(format('select app.sales_kpis(%L, now(), now())', :'tenant_a'), '42501', 'helpers are private');

-- Owner.
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.throws(format('select public.analytics_sales(%L, %L, %L)', :'tenant_a', :'today', :'yesterday'), 'invalid date range', 'from after to');
select test.throws(format('select public.analytics_sales(%L, %L, %L)', :'tenant_a', '2020-01-01', :'today'), 'too long', 'range limit');

select public.analytics_sales(:'tenant_a', :'today', :'today') as s \gset
select test.assert((:'s'::jsonb #>> '{current,orders}')::int = :exp_orders, 'orders today');
select test.assert((:'s'::jsonb #>> '{current,sales_cents}')::bigint = :exp_sales, 'sales today');
select test.assert((:'s'::jsonb #>> '{current,outstanding_cents}')::bigint = :exp_balance, 'outstanding today');
select test.assert((:'s'::jsonb #>> '{current,collected_cents}')::bigint = :exp_collected, 'collected today');
select test.assert((:'s'::jsonb #>> '{previous,orders}')::int = :exp_prev_orders, 'previous period is yesterday');
select test.assert(:'s'::jsonb ->> 'bucket' = 'day', 'daily buckets for short ranges');
select test.assert(jsonb_array_length(:'s'::jsonb -> 'series') = 1, 'one bucket for one day');
select test.assert((select sum((x ->> 'orders')::int) from jsonb_array_elements(:'s'::jsonb -> 'heatmap') x) = :exp_orders, 'heatmap adds up');
select test.assert((select sum((x ->> 'payments_cents')::bigint) from jsonb_array_elements(:'s'::jsonb -> 'by_method') x) >= 14000, 'payments by method');

select public.analytics_sales(:'tenant_a', (:'today'::date - 6), :'today') as s7 \gset
select test.assert(jsonb_array_length(:'s7'::jsonb -> 'series') = 7, 'seven daily buckets');
select test.assert((select sum((x ->> 'orders')::int) from jsonb_array_elements(:'s7'::jsonb -> 'series') x) = (:'s7'::jsonb #>> '{current,orders}')::int, 'series adds up to the total');
select test.assert(public.analytics_sales(:'tenant_a', (:'today'::date - 89), :'today') ->> 'bucket' = 'week', 'weekly buckets for 90 days');

select public.analytics_services(:'tenant_a', :'today', :'today') as sv \gset
select test.assert((:'sv'::jsonb ->> 'revenue_cents')::bigint = (
  select sum(i.net_cents) from public.order_items i join public.orders o on o.id = i.order_id
  where o.tenant_id = :'tenant_a' and o.status <> 'cancelled'
    and (o.created_at at time zone (select timezone from public.tenants where id = :'tenant_a'))::date = :'today'), 'service revenue');
select test.assert(exists (select 1 from jsonb_array_elements(:'sv'::jsonb -> 'products') p where p ->> 'name' = 'Wash & Fold'), 'products listed');

select public.analytics_employees(:'tenant_a', :'today', :'today') as em \gset
select test.assert((select (m ->> 'collected_cents')::bigint from jsonb_array_elements(:'em'::jsonb -> 'members') m where m ->> 'user_id' = :'owner') = :exp_owner_collected,
  'collected per employee');
select test.assert((select (m ->> 'orders')::int from jsonb_array_elements(:'em'::jsonb -> 'members') m where m ->> 'user_id' = :'front') >= 1,
  'orders per employee');

select public.analytics_customers(:'tenant_a', :'today', :'today') as cu \gset
select test.assert((:'cu'::jsonb ->> 'buyers')::int >= 1, 'buyers');
select test.assert((:'cu'::jsonb ->> 'new_buyers')::int + (:'cu'::jsonb ->> 'returning_buyers')::int = (:'cu'::jsonb ->> 'buyers')::int, 'new + returning = buyers');
select test.assert(exists (select 1 from jsonb_array_elements(:'cu'::jsonb -> 'top') t where t ->> 'id' = :'customer_a'), 'top customers');

select test.assert(public.analytics_operations(:'tenant_a', (:'today'::date - 30), :'today') ? 'delivered_orders', 'operations report');
select public.analytics_quality(:'tenant_a', (:'today'::date - 30), :'today') as qu \gset
select test.assert((:'qu'::jsonb ->> 'total')::int = jsonb_array_length(:'qu'::jsonb -> 'items'), 'quality items match the total');
reset role;

-- Managers of existing tenants got the new permission.
select test.assert(exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
  where r.tenant_id = :'tenant_a' and r.key = 'manager' and rp.permission = 'reports.view'), 'manager has reports.view');
