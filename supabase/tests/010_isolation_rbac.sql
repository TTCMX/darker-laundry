-- Tenant isolation and privilege escalation.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as tenant_b from public.tenants where slug = 'lav-b' \gset
select id as front_role_a from public.roles where tenant_id = :'tenant_a' and key = 'front_desk' \gset
select id as owner_role_a from public.roles where tenant_id = :'tenant_a' and key = 'owner' \gset
select id as owner_member_a from public.tenant_members where tenant_id = :'tenant_a' and user_id = '00000000-0000-0000-0000-00000000000a' \gset

-- Seed some data in A as its owner.
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
insert into public.product_categories (tenant_id, name) values (:'tenant_a', 'Lavandería');
insert into public.products (tenant_id, sku, name, unit, base_price_cents) values (:'tenant_a', 'WF', 'Wash & Fold', 'kg', 3500);
insert into public.customers (tenant_id, name, phone, email) values (:'tenant_a', 'Carla Díaz', '55 1234 5678', 'Carla@Example.com');

-- ── Isolation: owner B sees nothing of A and cannot write into A ──────────
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select test.assert((select count(*) from public.customers where tenant_id = :'tenant_a') = 0, 'B cannot read A customers');
select test.assert((select count(*) from public.products where tenant_id = :'tenant_a') = 0, 'B cannot read A products');
select test.assert((select count(*) from public.tenants) = 1, 'B only sees its own tenant');
select test.assert((select count(*) from public.tenant_members) = 1, 'B only sees its own members');
select test.throws(format($$insert into public.customers (tenant_id, name) values (%L, 'Intruso')$$, :'tenant_a'),
  '42501', 'B cannot insert customers into A');
select test.throws(format($$select public.dashboard_summary(%L)$$, :'tenant_a'), '42501', 'B cannot read A dashboard');
select test.throws(format($$select public.create_invitation(%L, %L)$$, :'tenant_a', :'owner_role_a'), '42501',
  'B cannot invite into A');
update public.products set base_price_cents = 1 where tenant_id = :'tenant_a';
reset role;
select test.assert((select base_price_cents from public.products where tenant_id = :'tenant_a' and sku = 'WF') = 3500,
  'B update on A products is a no-op');
set role authenticated;

-- ── Privilege escalation ─────────────────────────────────────────────────
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ee"}';
select test.throws(format($$insert into public.tenant_members (tenant_id, user_id, role_id, display_name)
  values (%L, '00000000-0000-0000-0000-0000000000ee', %L, 'Hacker')$$, :'tenant_a', :'owner_role_a'),
  '42501', 'outsider cannot add itself as a member');
select test.assert((select count(*) from public.tenants) = 0, 'outsider sees no tenants');
select test.assert(public.my_memberships() = '[]'::jsonb, 'outsider has no memberships');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000fa"}';
select test.throws(format($$update public.tenant_members set role_id = %L where user_id = '00000000-0000-0000-0000-0000000000fa'$$, :'owner_role_a'),
  '42501', 'front desk cannot change its own role');
select test.throws(format($$insert into public.role_permissions (tenant_id, role_id, permission) values (%L, %L, 'team.manage')$$, :'tenant_a', :'front_role_a'),
  '42501', 'front desk cannot grant itself permissions');
select test.throws(format($$select public.save_role(%L, %L, 'Mostrador', null, null, array['team.manage'])$$, :'tenant_a', :'front_role_a'),
  '42501', 'front desk cannot edit roles');
select test.throws(format($$update public.tenants set plan_status = 'active', plan = 'enterprise' where id = %L$$, :'tenant_a'),
  '42501', 'plan columns are not writable');
select test.throws($$update public.orders set total_cents = 0$$, '42501', 'orders are not directly writable');
select test.throws($$insert into public.payments (tenant_id, order_id, method, amount_cents, idempotency_key) values (gen_random_uuid(), gen_random_uuid(), 'cash', 1, 'x')$$,
  '42501', 'payments are not directly writable');
select test.throws($$select * from public.tenant_secrets$$, '42501', 'secrets are never readable by clients');
select test.throws($$select * from public.webhook_events$$, '42501', 'webhook log is not readable by clients');
select test.throws($$select public.svc_save_order(null, null, null, null)$$, '42501', 'service functions are not callable by users');
select test.throws($$select app.act_as('00000000-0000-0000-0000-00000000000a')$$, '42501', 'users cannot impersonate');
select test.assert((select count(*) from public.audit_log) = 0, 'front desk has no audit.view');
select test.assert(
  (select (m -> 'permissions') ? 'orders.create' and not (m -> 'permissions') ? 'team.manage'
   from jsonb_array_elements(public.my_memberships()) m),
  'front desk permissions resolved');

-- Production staff cannot see customers' full list? They can (production.view) but not edit.
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';
select test.throws(format($$insert into public.customers (tenant_id, name) values (%L, 'X')$$, :'tenant_a'), '42501',
  'production cannot create customers');
select test.throws(format($$select public.dashboard_summary(%L)$$, :'tenant_a'), '42501', 'production has no dashboard');

-- The driver sees no customers until it has a stop for them.
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select test.assert((select count(*) from public.customers) = 0, 'driver sees no customers without stops');
select test.assert((select count(*) from public.orders) = 0, 'driver sees no orders without stops');

-- ── Owner safety ─────────────────────────────────────────────────────────
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select test.throws(format($$select public.update_member(%L, %L)$$, :'owner_member_a', :'front_role_a'),
  'owner', 'the last owner cannot be demoted');
select test.throws(format($$select public.delete_role(%L)$$, :'owner_role_a'), '42501', 'owner role cannot be deleted');

-- ── Anonymous ────────────────────────────────────────────────────────────
set role anon;
reset request.jwt.claims;
select test.throws($$select * from public.orders$$, '42501', 'anon cannot read orders');
select test.throws($$select * from public.customers$$, '42501', 'anon cannot read customers');
select test.throws($$select public.create_tenant('x', 'xx-x', 'x')$$, '42501', 'anon cannot create tenants');
select test.assert(public.get_public_order('nope') is null, 'unknown token returns nothing');
reset role;

-- ── Phone normalization (same cases as src/domain/domain.test.ts) ─────────
select test.assert(app.normalize_phone('55 1234 5678') = '+525512345678', 'phone national');
select test.assert(app.normalize_phone('(55) 1234-5678') = '+525512345678', 'phone formatted');
select test.assert(app.normalize_phone('+52 55 1234 5678') = '+525512345678', 'phone intl');
select test.assert(app.normalize_phone('+52 1 55 1234 5678') = '+525512345678', 'phone legacy mobile');
select test.assert(app.normalize_phone('525512345678') = '+525512345678', 'phone cc no plus');
select test.assert(app.normalize_phone('0052 55 1234 5678') = '+525512345678', 'phone 00 prefix');
select test.assert(app.normalize_phone('+1 415 555 0100') = '+14155550100', 'phone US');
select test.assert(app.normalize_phone('12345') is null, 'phone too short');
select test.assert(app.normalize_phone('') is null, 'phone empty');
select test.assert(app.normalize_phone('415 555 0100', 'US') = '+14155550100', 'phone US default');
select test.assert(app.normalize_phone('612 345 678', 'ES') = '+34612345678', 'phone ES default');

-- One customer per phone, whatever the format.
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000fa"}';
select test.throws(format($$insert into public.customers (tenant_id, name, phone) values (%L, 'Otra', '+52 1 55 1234 5678')$$, :'tenant_a'),
  '23505', 'duplicate phone in another format is rejected');
select test.throws(format($$insert into public.customers (tenant_id, name, phone) values (%L, 'Otra', '123')$$, :'tenant_a'),
  'invalid phone', 'invalid phone is rejected');
select test.assert((select email from public.customers where tenant_id = :'tenant_a' and name = 'Carla Díaz') = 'carla@example.com',
  'email normalized');
reset role;
-- Same phone is fine in a different tenant.
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
insert into public.customers (tenant_id, name, phone) values (:'tenant_b', 'Carla en B', '5512345678');
reset role;
