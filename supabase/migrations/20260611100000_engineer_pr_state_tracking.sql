
create or replace function mark_pr_merged(
  p_tenant_id uuid,
  p_pr_url text,
  p_merged_at timestamptz
) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update agent_runs
     set parsed = coalesce(parsed, '{}'::jsonb)
                  || jsonb_build_object(
                       'merged', true,
                       'merged_at', p_merged_at,
                       'pr_state', 'merged'
                     )
   where tenant_id = p_tenant_id
     and parsed->>'pr_url' = p_pr_url
     and (parsed->>'merged' is null or parsed->>'merged' = 'false');
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function mark_pr_merged(uuid, text, timestamptz) from public;
grant execute on function mark_pr_merged(uuid, text, timestamptz) to service_role;

create or replace function mark_pr_closed_unmerged(
  p_tenant_id uuid,
  p_pr_url text,
  p_closed_at timestamptz
) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update agent_runs
     set parsed = coalesce(parsed, '{}'::jsonb)
                  || jsonb_build_object(
                       'pr_state', 'closed_unmerged',
                       'pr_closed_at', p_closed_at
                     )
   where tenant_id = p_tenant_id
     and parsed->>'pr_url' = p_pr_url
     and (parsed->>'merged' is null or parsed->>'merged' = 'false')
     and (parsed->>'pr_state' is distinct from 'closed_unmerged');
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function mark_pr_closed_unmerged(uuid, text, timestamptz) from public;
grant execute on function mark_pr_closed_unmerged(uuid, text, timestamptz) to service_role;

create or replace function agent_run_set_pr_state(
  p_run_id uuid,
  p_state text,
  p_detail text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_state not in ('failed_to_open') then
    raise exception 'agent_run_set_pr_state: invalid state %', p_state;
  end if;
  update agent_runs
     set parsed = coalesce(parsed, '{}'::jsonb)
                  || jsonb_build_object(
                       'pr_state', p_state,
                       'pr_state_detail', left(coalesce(p_detail, ''), 500)
                     )
   where id = p_run_id
     and (parsed->>'merged' is null or parsed->>'merged' = 'false');
end $$;
revoke all on function agent_run_set_pr_state(uuid, text, text) from public;
grant execute on function agent_run_set_pr_state(uuid, text, text) to service_role;
