
create or replace function clear_social_connection(
  p_tenant_id uuid,
  p_platform text,
  p_handle text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_user_key text := 'social.' || p_platform || '.' || p_handle || '.username';
  v_pass_key text := 'social.' || p_platform || '.' || p_handle || '.password';
  v_old uuid;
begin
  if p_platform not in ('instagram', 'linkedin', 'tiktok') then
    raise exception 'clear_social_connection: unsupported platform %', p_platform
      using errcode = 'check_violation';
  end if;

  select vault_secret_id into v_old from secrets
    where tenant_id = p_tenant_id and key = v_user_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_user_key;
  end if;

  select vault_secret_id into v_old from secrets
    where tenant_id = p_tenant_id and key = v_pass_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_pass_key;
  end if;

  update social_connected_accounts
    set status = 'disconnected',
        anchor_profile_id = null,
        updated_at = now()
  where tenant_id = p_tenant_id
    and platform = p_platform
    and handle = p_handle;
end $$;

revoke all on function clear_social_connection(uuid, text, text) from public;
