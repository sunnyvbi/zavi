
create or replace function set_social_disconnected(
  p_tenant_id uuid,
  p_platform text,
  p_handle text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_platform not in ('instagram', 'linkedin', 'tiktok') then
    raise exception 'set_social_disconnected: unsupported platform %', p_platform
      using errcode = 'check_violation';
  end if;

  update social_connected_accounts
    set status = 'disconnected',
        updated_at = now()
  where tenant_id = p_tenant_id
    and platform = p_platform
    and handle = p_handle;
end $$;

revoke all on function set_social_disconnected(uuid, text, text) from public;
