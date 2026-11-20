
create table if not exists social_connected_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'linkedin', 'tiktok')),
  handle text not null,
  status text not null default 'connected'
    check (status in ('connected', 'challenged', 'locked', 'disconnected')),
  anchor_profile_id text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, platform, handle)
);

alter table social_connected_accounts enable row level security;

create policy social_accounts_member_select on social_connected_accounts
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = social_connected_accounts.tenant_id
    )
  );

create or replace function set_social_connection(
  p_tenant_id uuid,
  p_platform text,
  p_handle text,
  p_username text,
  p_password text,
  p_anchor_profile_id text default null
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_user_key text := 'social.' || p_platform || '.' || p_handle || '.username';
  v_pass_key text := 'social.' || p_platform || '.' || p_handle || '.password';
  v_old uuid;
  v_new uuid;
begin
  if p_platform not in ('instagram', 'linkedin', 'tiktok') then
    raise exception 'set_social_connection: unsupported platform %', p_platform
      using errcode = 'check_violation';
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
    (tenant_id, platform, handle, status, anchor_profile_id, connected_at, updated_at)
  values
    (p_tenant_id, p_platform, p_handle, 'connected', p_anchor_profile_id, now(), now())
  on conflict (tenant_id, platform, handle)
  do update set
    status = 'connected',
    anchor_profile_id = coalesce(excluded.anchor_profile_id, social_connected_accounts.anchor_profile_id),
    updated_at = now();
end $$;

revoke all on function set_social_connection(uuid, text, text, text, text, text) from public;
