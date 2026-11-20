
alter table public.social_connected_accounts
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

comment on column public.social_connected_accounts.owner_user_id is
  'Gap3/D1: the tenant member who connected this account. Only that member''s '
  'agent runs may resume its profile / read its Vault creds. NULL = unclaimed '
  '(multi-member backfill / owner offboarded) -> not resolvable until reconnect.';

update public.social_connected_accounts sca
   set owner_user_id = tu.user_id
  from public.tenant_users tu
 where tu.tenant_id = sca.tenant_id
   and sca.owner_user_id is null
   and (
     select count(*) from public.tenant_users tu2
      where tu2.tenant_id = sca.tenant_id
   ) = 1;

drop function if exists public.set_social_connection(uuid, text, text, text, text, text);

create or replace function set_social_connection(
  p_tenant_id uuid,
  p_platform text,
  p_handle text,
  p_username text,
  p_password text,
  p_owner_user_id uuid,
  p_anchor_profile_id text default null
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_user_key text := 'social.' || p_platform || '.' || p_handle || '.username';
  v_pass_key text := 'social.' || p_platform || '.' || p_handle || '.password';
  v_old uuid;
  v_new uuid;
  v_existing_owner uuid;
begin
  if p_platform not in ('instagram', 'linkedin', 'tiktok') then
    raise exception 'set_social_connection: unsupported platform %', p_platform
      using errcode = 'check_violation';
  end if;

  if auth.uid() is not null and p_owner_user_id is distinct from auth.uid() then
    raise exception 'set_social_connection: owner must be the caller'
      using errcode = '42501';
  end if;

  if p_owner_user_id is null then
    raise exception 'set_social_connection: owner_user_id required'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = p_owner_user_id and tenant_id = p_tenant_id
  ) then
    raise exception 'set_social_connection: owner not a member of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || '|' || p_platform || '|' || p_handle, 0)
  );

  select owner_user_id into v_existing_owner
    from social_connected_accounts
    where tenant_id = p_tenant_id and platform = p_platform and handle = p_handle;
  if v_existing_owner is not null and v_existing_owner is distinct from p_owner_user_id then
    raise exception 'set_social_connection: handle already connected by another member'
      using errcode = '42501';
  end if;

  select vault_secret_id into v_old from secrets
    where tenant_id = p_tenant_id and key = v_user_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_user_key;
  end if;
  v_new := vault.create_secret(p_username);
  insert into secrets (tenant_id, key, vault_secret_id)
    values (p_tenant_id, v_user_key, v_new);

  select vault_secret_id into v_old from secrets
    where tenant_id = p_tenant_id and key = v_pass_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_pass_key;
  end if;
  v_new := vault.create_secret(p_password);
  insert into secrets (tenant_id, key, vault_secret_id)
    values (p_tenant_id, v_pass_key, v_new);

  insert into social_connected_accounts
    (tenant_id, platform, handle, status, owner_user_id, anchor_profile_id, connected_at, updated_at)
  values
    (p_tenant_id, p_platform, p_handle, 'connected', p_owner_user_id, p_anchor_profile_id, now(), now())
  on conflict (tenant_id, platform, handle)
  do update set
    status = 'connected',
    owner_user_id = excluded.owner_user_id,
    anchor_profile_id = coalesce(excluded.anchor_profile_id, social_connected_accounts.anchor_profile_id),
    updated_at = now()
  where social_connected_accounts.owner_user_id is null
     or social_connected_accounts.owner_user_id = excluded.owner_user_id;
end $$;

revoke all on function set_social_connection(uuid, text, text, text, text, uuid, text) from public;

do $$
begin
  raise notice '20260705010000: social_connected_accounts.owner_user_id added; set_social_connection now owner-scoped (Gap3/D1)';
end $$;
