-- Photos at any point of the process.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as tenant_b from public.tenants where slug = 'lav-b' \gset
select id as order_1 from public.orders where tenant_id = :'tenant_a' and number = 1 \gset
select id as order_x from public.orders where tenant_id = :'tenant_a' and status = 'in_production' order by number desc limit 1 \gset
\set front '00000000-0000-0000-0000-0000000000fa'
\set prod1 '00000000-0000-0000-0000-0000000000a1'
\set prod2 '00000000-0000-0000-0000-0000000000a2'
\set ownerb '00000000-0000-0000-0000-00000000000b'

set role authenticated;
-- Production worker photographs the order at its current step.
select set_config('request.jwt.claims', json_build_object('sub', :'prod1')::text, false);
select test.throws(format($$insert into public.order_photos (tenant_id, order_id, path, taken_by) values (%L, %L, %L, %L)$$,
  :'tenant_a', :'order_x', :'tenant_a' || '/orders/x/0.jpg', :'front'), '42501', 'clients cannot set the author');
insert into public.order_photos (tenant_id, order_id, path, caption)
values (:'tenant_a', :'order_x', :'tenant_a' || '/orders/x/1.jpg', 'Mancha en cuello');
select test.assert((select taken_by from public.order_photos where caption = 'Mancha en cuello') = :'prod1'::uuid, 'author is the actor');
select test.assert((select order_status from public.order_photos where caption = 'Mancha en cuello') = 'in_production', 'order status stamped');
select test.assert((select step_name from public.order_photos where caption = 'Mancha en cuello') is not null, 'current step stamped');
select test.throws(format($$insert into public.order_photos (tenant_id, order_id, path) values (%L, %L, %L)$$,
  :'tenant_a', :'order_x', :'tenant_b' || '/x.jpg'), 'invalid photo path', 'files must live in the tenant folder');

-- Another worker cannot delete it; the front desk (orders.edit) can.
select set_config('request.jwt.claims', json_build_object('sub', :'prod2')::text, false);
select test.assert((select count(*) from public.order_photos where order_id = :'order_x') = 1, 'coworkers see the photo');
delete from public.order_photos where caption = 'Mancha en cuello';
select test.assert((select count(*) from public.order_photos where order_id = :'order_x') = 1, 'coworker cannot delete it');

-- Another tenant sees nothing and cannot attach photos.
select set_config('request.jwt.claims', json_build_object('sub', :'ownerb')::text, false);
select test.assert((select count(*) from public.order_photos) = 0, 'other tenants see no photos');
select test.throws(format($$insert into public.order_photos (tenant_id, order_id, path) values (%L, %L, %L)$$,
  :'tenant_a', :'order_1', :'tenant_a' || '/y.jpg'), '42501', 'other tenants cannot add photos');

select set_config('request.jwt.claims', json_build_object('sub', :'front')::text, false);
delete from public.order_photos where caption = 'Mancha en cuello';
select test.assert((select count(*) from public.order_photos where order_id = :'order_x') = 0, 'order editors can delete');
reset role;
