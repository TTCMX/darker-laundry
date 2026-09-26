-- Test helpers and fixtures shared by the following test files.
create schema test;
grant usage on schema test to public;

create function test.assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
end $$;

-- Runs p_sql as the current role and asserts it fails with p_errcode
-- (a SQLSTATE, or a fragment of the error message).
create function test.throws(p_sql text, p_expected text, p_message text) returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = p_expected or position(p_expected in v_msg) > 0 then
      return;
    end if;
    raise exception 'ASSERTION FAILED: % (expected %, got % %)', p_message, p_expected, v_state, v_msg;
  end;
  raise exception 'ASSERTION FAILED: % (expected error %, but it succeeded)', p_message, p_expected;
end $$;

grant execute on all functions in schema test to public;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner.a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'owner.b@example.com'),
  ('00000000-0000-0000-0000-0000000000fa', 'front.a@example.com'),
  ('00000000-0000-0000-0000-0000000000a1', 'prod1.a@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'prod2.a@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'driver.a@example.com'),
  ('00000000-0000-0000-0000-0000000000ee', 'outsider@example.com');

-- Tenant A (owner A) and tenant B (owner B), created through the public RPC.
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select public.create_tenant('Lavandería A', 'lav-a', 'Ana') is not null as ok;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select public.create_tenant('Lavandería B', 'lav-b', 'Beto') is not null as ok;
reset role;
reset request.jwt.claims;

-- Team of tenant A joins through invitations.
do $$
declare
  v_tenant uuid := (select id from public.tenants where slug = 'lav-a');
  v_inv jsonb;
  r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0000000000fa', 'front_desk', 'front.a@example.com', 'Fer'),
    ('00000000-0000-0000-0000-0000000000a1', 'production', null, 'Pablo'),
    ('00000000-0000-0000-0000-0000000000a2', 'production', null, 'Paula'),
    ('00000000-0000-0000-0000-0000000000d1', 'driver', null, 'Diego')
  ) as x(user_id, role_key, email, name) loop
    perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a"}', true);
    v_inv := public.create_invitation(v_tenant, (select id from public.roles where tenant_id = v_tenant and key = r.role_key), r.email, r.name);
    perform set_config('request.jwt.claims', json_build_object('sub', r.user_id)::text, true);
    perform public.accept_invitation(v_inv ->> 'token', null);
  end loop;
end $$;

select test.assert((select count(*) from public.tenant_members m join public.tenants t on t.id = m.tenant_id where t.slug = 'lav-a') = 5,
  'tenant A has 5 members');
select test.assert((select count(*) from public.roles r join public.tenants t on t.id = r.tenant_id where t.slug = 'lav-b') = 5,
  'tenant B got its own seeded roles');
select test.assert((select count(*) from public.workflow_steps s join public.tenants t on t.id = s.tenant_id where t.slug = 'lav-a') = 5,
  'default workflow seeded');
