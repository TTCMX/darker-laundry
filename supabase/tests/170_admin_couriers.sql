-- No couriers: administrative staff can take the route.
select id as tenant_a from public.tenants where slug = 'lav-a' \gset
select id as tenant_b from public.tenants where slug = 'lav-b' \gset
\set owner '00000000-0000-0000-0000-00000000000a'
\set ownerb '00000000-0000-0000-0000-00000000000b'
\set driver '00000000-0000-0000-0000-0000000000d1'
\set front '00000000-0000-0000-0000-0000000000fa'

-- With a courier: the courier is the automatic one.
select test.assert(app.single_courier(:'tenant_a') = :'driver'::uuid, 'the only courier');
-- Owner working alone: assigned automatically.
select test.assert(app.single_courier(:'tenant_b') = :'ownerb'::uuid, 'no couriers → the only member who can deliver');

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'owner')::text, false);
select test.assert((select (x ->> 'can_deliver')::boolean from jsonb_array_elements(public.team_members(:'tenant_a')) x
  where x ->> 'user_id' = :'owner'), 'owner can deliver');
select test.assert((select (x ->> 'can_deliver')::boolean from jsonb_array_elements(public.team_members(:'tenant_a')) x
  where x ->> 'user_id' = :'driver'), 'courier can deliver');
select test.assert(not (select (x ->> 'can_deliver')::boolean from jsonb_array_elements(public.team_members(:'tenant_a')) x
  where x ->> 'user_id' = :'front'), 'front desk cannot');
reset role;
