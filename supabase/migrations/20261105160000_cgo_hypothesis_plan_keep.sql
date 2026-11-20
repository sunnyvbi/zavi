
alter table cgo_hypotheses
  add column if not exists plan_kept_at timestamptz,
  add column if not exists plan_kept_by uuid;

create or replace function set_hypothesis_plan_kept(
  p_tenant_id     uuid,
  p_hypothesis_id uuid,
  p_actor         uuid,
  p_kept          boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_at timestamptz;
begin
  if p_tenant_id is null or p_hypothesis_id is null or p_kept is null then
    raise exception 'set_hypothesis_plan_kept: tenant, hypothesis and kept are required'
      using errcode = '22023';
  end if;

  update cgo_hypotheses
     set plan_kept_at = case when p_kept then now() else null end,
         plan_kept_by = case when p_kept then p_actor else null end
   where tenant_id = p_tenant_id
     and id = p_hypothesis_id
     and status = 'ruled_out'
     and restates_plan_constraint
  returning plan_kept_at into v_at;

  if not found then
    raise exception 'set_hypothesis_plan_kept: no ruled-out plan conflict %', p_hypothesis_id
      using errcode = 'P0002';
  end if;

  return jsonb_build_object('kept_at', v_at);
end;
$$;

revoke all on function set_hypothesis_plan_kept(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function set_hypothesis_plan_kept(uuid, uuid, uuid, boolean) to service_role;
