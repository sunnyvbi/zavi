
begin;

create or replace function set_channel_autorun(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_autorun      boolean
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_exists boolean;
begin
  if p_tenant_id is null
     or nullif(trim(p_channel_slug), '') is null
     or p_autorun is null then
    return false;
  end if;

  insert into tenant_channels (tenant_id, channel_slug, autorun, autorun_set_by)
  values (p_tenant_id, p_channel_slug, p_autorun, 'founder')
  on conflict (tenant_id, channel_slug) do update
    set autorun        = p_autorun,
        autorun_set_by = 'founder';

  select true into v_exists
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and autorun_set_by = 'founder'
     and autorun is not distinct from p_autorun;

  return coalesce(v_exists, false);
end $$;

revoke all on function set_channel_autorun(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function set_channel_autorun(uuid, text, boolean)
  to service_role;

commit;
