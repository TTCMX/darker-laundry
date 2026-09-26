-- Minimal stand-in for the parts of Supabase the migrations rely on, so the
-- database tests run on plain Postgres (locally and in CI).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to current_user;

create schema auth;
create schema extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text unique
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase's default privileges: everything in public is granted to the API
-- roles unless the migrations say otherwise. Reproduced here so the tests
-- catch a table or function that forgot to lock itself down.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
