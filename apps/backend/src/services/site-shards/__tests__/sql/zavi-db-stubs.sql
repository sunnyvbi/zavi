create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table public.tenants (id uuid primary key);
create table public.tenant_users (user_id uuid, tenant_id uuid);
create table public.conductor_runs (id uuid primary key, tenant_id uuid not null);
create table public.tenant_resources (resource_kind text, external_ref jsonb);
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null);
create function vault.create_secret(p_secret text) returns uuid language sql as $$
  insert into vault.secrets (secret) values (p_secret) returning id $$;
create view vault.decrypted_secrets as select id, secret as decrypted_secret from vault.secrets;
