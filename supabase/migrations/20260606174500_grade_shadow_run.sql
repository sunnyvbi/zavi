
create or replace function grade_shadow_run(
  p_shadow_run_id    uuid,
  p_comparison_score integer,
  p_comparison_notes text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_status text;
  v_rows   integer;
begin
  if p_comparison_score is null or p_comparison_score < 0 or p_comparison_score > 4 then
    raise exception 'comparison_score must be 0..4 (got %)', p_comparison_score
      using errcode = '22023';
  end if;

  select ar.tenant_id, asr.status into v_tenant, v_status
    from agent_shadow_runs asr
    join agent_runs ar on ar.id = asr.source_agent_run_id
   where asr.id = p_shadow_run_id;

  if v_tenant is null then
    raise exception 'shadow run % not found', p_shadow_run_id using errcode = '22023';
  end if;

  if v_tenant <> '73db45ff-457e-4541-bc8f-bdb625390204'::uuid then
    raise exception 'shadow grading restricted to the dogfood tenant in P0 (got %)', v_tenant
      using errcode = '22023';
  end if;

  if v_status is distinct from 'success' then
    raise exception 'cannot grade shadow run with status % (only success)', v_status
      using errcode = '22023';
  end if;

  update agent_shadow_runs
     set comparison_score = p_comparison_score,
         comparison_notes = p_comparison_notes
   where id = p_shadow_run_id
     and comparison_score is null;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

revoke all on function grade_shadow_run(uuid, integer, text) from public, authenticated, anon;
grant execute on function grade_shadow_run(uuid, integer, text) to service_role;
