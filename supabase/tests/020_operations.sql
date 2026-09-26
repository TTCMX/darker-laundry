-- A full operating day: order → production → delivery → payment → tracking.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as tenant_b from public.tenants where slug = 'lav-b' \gset
select id as product_wf from public.products where tenant_id = :'tenant_a' and sku = 'WF' \gset
select id as customer_a from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz' \gset
select id as customer_b from public.customers where tenant_id = :'tenant_b' limit 1 \gset

\set front '00000000-0000-0000-0000-0000000000fa'
\set prod1 '00000000-0000-0000-0000-0000000000a1'
\set prod2 '00000000-0000-0000-0000-0000000000a2'
\set driver '00000000-0000-0000-0000-0000000000d1'
\set owner '00000000-0000-0000-0000-00000000000a'

-- Address for the customer (front desk).
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
insert into public.customer_addresses (tenant_id, customer_id, label, line1, city, is_default)
values (:'tenant_a', :'customer_a', 'Casa', 'Av. Siempre Viva 742', 'CDMX', true);
reset role;
select id as address_a from public.customer_addresses where customer_id = :'customer_a' \gset

\set pricing '{"version":1,"lines":[{"index":0,"product_id":"PRODUCT","sku":"WF","name":"Wash & Fold","unit":"kg","category_id":null,"quantity":4,"unit_price_cents":3500,"list_total_cents":14000,"volume_rule_id":null,"volume_savings_cents":0,"gross_cents":14000,"discount_cents":0,"net_cents":14000,"taxable":true,"custom_price":false,"notes":null}],"subtotal_cents":14000,"discount_cents":0,"delivery_fee_cents":5000,"tax_cents":0,"total_cents":19000,"applied_discounts":[],"steps":[{"key":"list_subtotal","label":"Subtotal","amount_cents":14000},{"key":"delivery_fee","label":"Envío","amount_cents":5000},{"key":"total","label":"Total","amount_cents":19000}]}'

-- ── Orders are created by the server on behalf of a user ─────────────────
reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'delivery', 'pickup_address_id', :'address_a',
                     'delivery_address_id', :'address_a', 'promised_at', now() + interval '2 days'),
  replace(:'pricing', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as order_1 \gset
select (public.svc_save_order(:'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a', 'fulfillment', 'walk_in', 'promised_at', now() - interval '1 hour'),
  replace(:'pricing', 'PRODUCT', :'product_wf')::jsonb) ->> 'id') as order_2 \gset

select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'prod1', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a'), replace(:'pricing', 'PRODUCT', :'product_wf')),
  '42501', 'production cannot create orders');
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a'), replace(replace(:'pricing', 'PRODUCT', :'product_wf'), '"total_cents":19000', '"total_cents":100')),
  'inconsistent pricing', 'a breakdown that does not add up is rejected');
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_b',
  jsonb_build_object('customer_id', :'customer_b'), replace(:'pricing', 'PRODUCT', :'product_wf')),
  '42501', 'a user cannot create orders in a tenant it does not belong to');
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'owner', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_b'), replace(:'pricing', 'PRODUCT', :'product_wf')),
  'customer not found', 'customers of other tenants cannot be used');
-- Ad-hoc price lines need orders.price_override.
select test.throws(format($$select public.svc_save_order(%L, %L, %L::jsonb, %L::jsonb)$$, :'front', :'tenant_a',
  jsonb_build_object('customer_id', :'customer_a'), replace(:'pricing', '"PRODUCT"', 'null')),
  '42501', 'front desk cannot add ad-hoc price lines');
reset role;

select test.assert((select number from public.orders where id = :'order_1') = 1, 'first order is #1');
select test.assert((select number from public.orders where id = :'order_2') = 2, 'second order is #2');
select test.assert((select payment_status from public.orders where id = :'order_1') = 'pending', 'unpaid order is pending');
select test.assert((select balance_cents from public.orders where id = :'order_1') = 19000, 'balance = total');
select test.assert((select count(*) from public.order_items where order_id = :'order_1') = 1, 'items stored');
select test.assert((select count(*) from public.notifications where order_id = :'order_1' and event = 'order_created') = 2,
  'order_created queued for email and whatsapp');
select test.assert((select actor_id from public.audit_log where entity_type = 'orders' and entity_id = :'order_1' and action = 'insert')
  = :'front'::uuid, 'audit log records the acting user');

-- Order numbers are per tenant.
reset request.jwt.claims;
set role service_role;
select (public.svc_save_order(:'owner', :'tenant_a', jsonb_build_object('customer_id', :'customer_a'),
  replace(:'pricing', 'PRODUCT', :'product_wf')::jsonb) ->> 'number') as n3 \gset
reset role;
select test.assert(:'n3' = '3', 'numbering continues');

-- ── Pickup ───────────────────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.schedule_delivery(:'order_1', 'pickup', current_date, 'Mañana', '09:00', '13:00') as pickup_1 \gset
select test.assert((select status from public.orders where id = :'order_1') = 'scheduled', 'pickup scheduled the order');
select test.assert((select courier_id from public.deliveries where id = :'pickup_1') = :'driver'::uuid,
  'the only courier is auto-assigned');
select test.throws(format($$select public.schedule_delivery(%L, 'pickup', current_date)$$, :'order_1'), '23505',
  'only one live pickup per order');

select set_config('request.jwt.claims', json_build_object('sub', :'driver')::text, false);
select test.assert((select count(*) from public.orders) = 1, 'driver now sees the order of its stop');
select test.assert((select count(*) from public.customers) = 1, 'driver now sees the customer of its stop');
select test.throws(format($$select public.update_delivery_status(%L, 'failed')$$, :'pickup_1'), 'failure reason',
  'a failed stop needs a reason');
select public.update_delivery_status(:'pickup_1', 'en_route');
select test.throws(format($$select public.update_delivery_status(%L, 'scheduled')$$, :'pickup_1'), '22023',
  'stops cannot go back');
select public.update_delivery_status(:'pickup_1', 'completed', 'Bolsa grande', null, array['a/b.jpg']);
select test.assert((select status from public.orders where id = :'order_1') = 'picked_up', 'completed pickup receives the order');
select test.assert((select completed_by from public.deliveries where id = :'pickup_1') = :'driver'::uuid, 'pickup completed by driver');

-- ── Production ───────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', :'prod1')::text, false);
select test.throws(format($$select public.start_production(%L)$$, :'order_1'), '42501', 'production workers cannot start orders');
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.start_production(:'order_1');
select test.assert((select status from public.orders where id = :'order_1') = 'in_production', 'order in production');
select test.assert((select count(*) from public.order_production_steps where order_id = :'order_1') = 5, 'steps copied from workflow');

select id as step1 from public.order_production_steps where order_id = :'order_1' and position = 1 \gset
select id as step2 from public.order_production_steps where order_id = :'order_1' and position = 2 \gset
select id as step3 from public.order_production_steps where order_id = :'order_1' and position = 3 \gset
select test.assert((select current_step_id from public.orders where id = :'order_1') = :'step1'::uuid, 'current step is the first');

-- A free step can be taken and completed by any production worker.
select set_config('request.jwt.claims', json_build_object('sub', :'prod1')::text, false);
select test.throws(format($$select public.complete_production_step(%L)$$, :'step2'), 'previous steps', 'steps go in order');
select public.complete_production_step(:'step1');
select test.assert((select completed_by from public.order_production_steps where id = :'step1') = :'prod1'::uuid, 'completed_by recorded');
select test.assert((select assigned_to from public.order_production_steps where id = :'step1') = :'prod1'::uuid, 'free step claimed on completion');

-- Assigned to someone else: others cannot touch it; a manager can.
select public.assign_production_step(:'step2', :'prod1');
select set_config('request.jwt.claims', json_build_object('sub', :'prod2')::text, false);
select test.throws(format($$select public.complete_production_step(%L)$$, :'step2'), '42501', 'cannot complete someone else''s step');
select test.throws(format($$select public.assign_production_step(%L, %L)$$, :'step2', :'prod2'), '42501', 'cannot take someone else''s step');
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.assign_production_step(:'step2', :'prod2');
select test.throws(format($$select public.assign_production_step(%L, %L)$$, :'step3', :'driver'), 'cannot work production',
  'couriers cannot be assigned production steps');
select set_config('request.jwt.claims', json_build_object('sub', :'prod2')::text, false);
select public.complete_production_step(:'step2');
select test.assert((select assigned_by from public.order_production_steps where id = :'step2') = :'owner'::uuid, 'assigned_by recorded');
select test.assert((select completed_by from public.order_production_steps where id = :'step2') = :'prod2'::uuid,
  'responsible and executor are tracked separately');

-- Steps that require assignment must be taken first.
reset role;
update public.order_production_steps set requires_assignment = true where id = :'step3';
set role authenticated;
select test.throws(format($$select public.complete_production_step(%L)$$, :'step3'), 'take the step', 'requires assignment');
select public.assign_production_step(:'step3', :'prod2');
select public.complete_production_step(:'step3');

-- Quality issue, reported during production.
insert into public.quality_issues (tenant_id, order_id, production_step_id, type, severity, description, reported_by, status)
values (:'tenant_a', :'order_1', :'step2', 'damage', 'medium', 'Camisa blanca dañada', '00000000-0000-0000-0000-00000000000a', 'resolved');
select test.assert((select reported_by from public.quality_issues where order_id = :'order_1') = :'prod2'::uuid, 'reporter is forced to the actor');
select test.assert((select status from public.quality_issues where order_id = :'order_1') = 'open', 'new issues start open');
select test.assert((select phase_name from public.quality_issues where order_id = :'order_1') = 'Secado', 'phase name captured');
update public.quality_issues set status = 'resolved' where order_id = :'order_1';
select test.assert((select status from public.quality_issues where order_id = :'order_1') = 'open', 'workers cannot resolve issues');

-- Manager reverts a step (rework), then the line finishes.
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.revert_production_step(:'step2', 'Mancha');
select test.assert((select status from public.order_production_steps where id = :'step3') = 'pending', 'later steps reopened');
select test.assert((select current_step_id from public.orders where id = :'order_1') = :'step2'::uuid, 'current step moved back');
select public.complete_production_step(id) from public.order_production_steps where order_id = :'order_1' and position = 2;
select public.complete_production_step(id) from public.order_production_steps where order_id = :'order_1' and position = 3;
select public.complete_production_step(id) from public.order_production_steps where order_id = :'order_1' and position = 4;
select public.complete_production_step(id) from public.order_production_steps where order_id = :'order_1' and position = 5;
select test.assert((select status from public.orders where id = :'order_1') = 'ready', 'last step makes the order ready');
select test.assert((select current_step_id from public.orders where id = :'order_1') is null, 'no current step when ready');
select test.assert((select count(*) from public.notifications where order_id = :'order_1' and event = 'order_ready') = 2, 'ready notified');

-- ── Payments ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.record_payment(:'order_1', 5000, 'cash', 'k-1') as pay_1 \gset
select test.assert(public.record_payment(:'order_1', 5000, 'cash', 'k-1') = :'pay_1'::uuid, 'same key returns the same payment');
select test.assert((select amount_paid_cents from public.orders where id = :'order_1') = 5000, 'retry did not add money');
select test.assert((select payment_status from public.orders where id = :'order_1') = 'partially_paid', 'partial payment');
select test.throws(format($$select public.record_payment(%L, 999999, 'cash', 'k-2')$$, :'order_1'), 'exceeds', 'cannot overpay');
select test.throws(format($$select public.record_payment(%L, 0, 'cash', 'k-3')$$, :'order_1'), 'positive', 'amount must be positive');
select test.throws(format($$select public.record_refund(%L, 100, 'x', 'r-1')$$, :'pay_1'), '42501', 'front desk cannot refund');

-- The driver can only collect on orders of its own stops.
select set_config('request.jwt.claims', json_build_object('sub', :'driver')::text, false);
select test.throws(format($$select public.record_payment(%L, 100, 'cash', 'k-4')$$, :'order_2'), '42501', 'driver cannot collect other orders');

-- Delivery run.
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select public.schedule_delivery(:'order_1', 'delivery', current_date, 'Tarde', '13:00', '18:00') as delivery_1 \gset
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.save_route(:'tenant_a', null, current_date, 'Ruta 1', :'driver', array[:'delivery_1']::uuid[]) as route_1 \gset
select test.assert((select stop_position from public.deliveries where id = :'delivery_1') = 1, 'stop ordered in route');

select set_config('request.jwt.claims', json_build_object('sub', :'driver')::text, false);
select public.start_route(:'route_1');
select public.update_delivery_status(:'delivery_1', 'en_route');
select test.assert((select status from public.orders where id = :'order_1') = 'out_for_delivery', 'en route → out for delivery');
select public.record_payment(:'order_1', 14000, 'card', 'k-5', 'Terminal', :'delivery_1');
select test.assert((select payment_status from public.orders where id = :'order_1') = 'paid', 'fully paid');
select test.assert((select balance_cents from public.orders where id = :'order_1') = 0, 'no balance');
select public.update_delivery_status(:'delivery_1', 'completed');
select test.assert((select status from public.orders where id = :'order_1') = 'delivered', 'delivered');
select test.assert((select status from public.routes where id = :'route_1') = 'completed', 'route completed with its last stop');

-- Online payments from a provider are idempotent.
reset role;
reset request.jwt.claims;
set role service_role;
select public.svc_record_provider_payment(:'tenant_a', :'order_2', 'mercadopago', 'mp-1', 'pending', 19000);
select public.svc_record_provider_payment(:'tenant_a', :'order_2', 'mercadopago', 'mp-1', 'succeeded', 19000);
select public.svc_record_provider_payment(:'tenant_a', :'order_2', 'mercadopago', 'mp-1', 'succeeded', 19000);
select public.svc_record_provider_payment(:'tenant_a', :'order_2', 'mercadopago', 'mp-1', 'failed', 19000);
select test.throws(format($$select public.svc_record_provider_payment(%L, %L, 'mercadopago', 'mp-2', 'succeeded', 100)$$, :'tenant_b', :'order_2'),
  'order not found', 'provider payments are scoped to the tenant');
reset role;
select test.assert((select count(*) from public.payments where order_id = :'order_2') = 1, 'webhook replays add no rows');
select test.assert((select status from public.payments where order_id = :'order_2') = 'succeeded', 'succeeded is final');
select test.assert((select payment_status from public.orders where id = :'order_2') = 'paid', 'order 2 paid online');

-- Refund by the owner.
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select public.record_refund(:'pay_1', 5000, 'Prenda dañada', 'r-2');
select test.throws(format($$select public.record_refund(%L, 1, 'otra', 'r-3')$$, :'pay_1'), 'invalid refund', 'cannot refund more than paid');
select test.assert((select payment_status from public.orders where id = :'order_1') = 'partially_paid', 'refund reopens the balance');

-- ── Status rules ─────────────────────────────────────────────────────────
select test.throws(format($$select public.set_order_status(%L, 'created')$$, :'order_1'), 'invalid status change',
  'delivered orders are final');
select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select test.throws(format($$select public.set_order_status(%L, 'cancelled')$$, :'order_2'), '42501',
  'front desk has no orders.cancel');

-- ── Tracking, dashboard, customers ───────────────────────────────────────
reset role;
select public_token as token_1 from public.orders where id = :'order_1' \gset
set role anon;
reset request.jwt.claims;
select test.assert((public.get_public_order(:'token_1') ->> 'number')::int = 1, 'tracking by token');
select test.assert((public.get_public_order(:'token_1') ->> 'status') = 'delivered', 'tracking shows status');
select test.assert(jsonb_array_length(public.get_public_order(:'token_1') -> 'production') = 5, 'tracking shows production');
select test.assert(not (public.get_public_order(:'token_1') ? 'internal_notes'), 'no internal notes in tracking');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.assert((public.dashboard_summary(:'tenant_a') ->> 'orders_today')::int = 3, 'dashboard counts today');
select test.assert((public.dashboard_summary(:'tenant_a') ->> 'overdue')::int >= 1, 'dashboard finds overdue orders');
select test.assert((select total_orders from public.customer_overview where id = :'customer_a') = 3, 'customer 360 totals');
select test.assert((select status from public.customer_overview where id = :'customer_a') = 'active', 'customer status');
select test.assert((select count(*) from public.audit_log where order_id = :'order_1') > 10, 'order history is recorded');
select test.assert(exists (select 1 from public.audit_log where order_id = :'order_1'
  and context ->> 'event' = 'order.status_changed' and after ->> 'status' = 'delivered'), 'status change event logged');

select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
select test.assert((select count(*) from public.audit_log where order_id = :'order_1') > 0, 'front desk sees order history');
select test.assert((select count(*) from public.audit_log where order_id is null) = 0, 'but not the rest of the log');
select test.assert(public.queue_payment_reminder(:'order_1') = 2, 'payment reminder queued');
reset role;
