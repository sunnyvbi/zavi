drop function if exists agent_run_set_pr_meta(uuid, text, text, int);

create or replace function agent_run_set_pr_meta(
  p_run_id uuid,
  p_pr_url text,
  p_pr_repo text,
  p_pr_number int,
  p_pr_head_branch text default null
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
                  || case
                       when p_pr_head_branch is not null
                       then jsonb_build_object('pr_head_branch', p_pr_head_branch)
                       else '{}'::jsonb
                     end
   where id = p_run_id;
end $$;
revoke all on function agent_run_set_pr_meta(uuid, text, text, int, text) from public;
grant execute on function agent_run_set_pr_meta(uuid, text, text, int, text) to service_role;
