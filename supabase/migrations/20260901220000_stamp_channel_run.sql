
begin;

create or replace function stamp_channel_run(
  p_tenant_id uuid,
  p_run_id uuid,
  p_channel_slug text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid; v_existing text;
begin
  if p_channel_slug is null or length(trim(p_channel_slug)) = 0 then
    raise exception 'stamp_channel_run: channel_slug required' using errcode = 'P0001';
  end if;

  select tenant_id, channel_slug into v_tenant, v_existing
  from agent_runs where id = p_run_id;

  if v_tenant is null then
    return false;
  end if;
  if p_tenant_id is distinct from v_tenant then
    raise exception 'stamp_channel_run: run % belongs to tenant %, not %',
      p_run_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;
  if v_existing is not null then
    return v_existing = p_channel_slug;
  end if;

  update agent_runs set channel_slug = p_channel_slug where id = p_run_id;
  return true;
end $$;

revoke all on function stamp_channel_run(uuid, uuid, text) from public, anon, authenticated;
grant execute on function stamp_channel_run(uuid, uuid, text) to service_role;

commit;

do $$
begin
  raise notice '20260901220000: stamp_channel_run (write-once, tenant-verified)';
end $$;
