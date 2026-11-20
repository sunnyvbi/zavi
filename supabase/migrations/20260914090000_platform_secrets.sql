
create table if not exists public.platform_secrets (
  key             text primary key,
  vault_secret_id uuid not null,
  meta            jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

comment on table public.platform_secrets is
  'Zavi-owned (non-tenant) credentials. Pointer only; plaintext lives in vault.secrets. Reach exclusively via get_platform_secret / set_platform_secret.';

alter table public.platform_secrets enable row level security;

create or replace function public.set_platform_secret(
  p_key   text,
  p_value text,
  p_meta  jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_old_id uuid;
  v_new_id uuid;
begin
  if p_key is null or length(p_key) = 0 or p_value is null or length(p_value) = 0 then
    raise exception 'set_platform_secret: null/empty argument' using errcode = '22023';
  end if;

  select ps.vault_secret_id into v_old_id
  from public.platform_secrets ps
  where ps.key = p_key;

  v_new_id := vault.create_secret(p_value, 'platform:' || p_key || ':' || gen_random_uuid()::text);

  insert into public.platform_secrets (key, vault_secret_id, meta, updated_at)
  values (p_key, v_new_id, coalesce(p_meta, '{}'::jsonb), now())
  on conflict (key) do update
    set vault_secret_id = excluded.vault_secret_id,
        meta            = excluded.meta,
        updated_at      = now();

  if v_old_id is not null then
    delete from vault.secrets vs where vs.id = v_old_id;
  end if;
end $$;

create or replace function public.get_platform_secret(p_key text)
returns text
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_id uuid;
  v_plaintext text;
begin
  select ps.vault_secret_id into v_id
  from public.platform_secrets ps
  where ps.key = p_key;

  if v_id is null then return null; end if;

  select ds.decrypted_secret into v_plaintext
  from vault.decrypted_secrets ds
  where ds.id = v_id;

  return v_plaintext;
end $$;

create or replace function public.rotate_platform_secret_cas(
  p_key      text,
  p_expected text,
  p_new      text,
  p_meta     jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_current text;
begin
  if p_key is null or p_new is null or length(p_new) = 0 then
    raise exception 'rotate_platform_secret_cas: null/empty argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('platform_secret:' || p_key));

  v_current := public.get_platform_secret(p_key);

  if v_current is not null and v_current is distinct from p_expected then
    return false;
  end if;

  perform public.set_platform_secret(p_key, p_new, p_meta);
  return true;
end $$;

revoke all on function public.set_platform_secret(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.get_platform_secret(text) from public, anon, authenticated;
revoke all on function public.rotate_platform_secret_cas(text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.set_platform_secret(text, text, jsonb) to service_role;
grant execute on function public.get_platform_secret(text) to service_role;
grant execute on function public.rotate_platform_secret_cas(text, text, text, jsonb) to service_role;

revoke all on table public.platform_secrets from public, anon, authenticated;
