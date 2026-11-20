
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
                  || jsonb_build_object('merged', true, 'merged_at', p_merged_at)
   where tenant_id = p_tenant_id
     and parsed->>'pr_url' = p_pr_url
     and (parsed->>'merged' is null or parsed->>'merged' = 'false');
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function mark_pr_merged(uuid, text, timestamptz) from public;
grant execute on function mark_pr_merged(uuid, text, timestamptz) to service_role;

create or replace function agent_run_set_pr_meta(
  p_run_id uuid,
  p_pr_url text,
  p_pr_repo text,
  p_pr_number int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update agent_runs
     set parsed = coalesce(parsed, '{}'::jsonb)
                  || jsonb_build_object(
                       'pr_url', p_pr_url,
                       'pr_repo', p_pr_repo,
                       'pr_number', p_pr_number
                     )
   where id = p_run_id;
end $$;
revoke all on function agent_run_set_pr_meta(uuid, text, text, int) from public;
grant execute on function agent_run_set_pr_meta(uuid, text, text, int) to service_role;
