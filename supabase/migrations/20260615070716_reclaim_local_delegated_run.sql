create or replace function reclaim_local_delegated_run(
  p_run_id uuid,
  p_owner  text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update agent_runs r
     set status = 'running', error = null, finished_at = null
    from agent_work_items w
   where r.id = p_run_id
     and w.agent_run_id = p_run_id
     and w.lane = 'local'
     and w.status = 'leased'
     and w.lease_owner = p_owner
     and r.status = 'failed'
     and r.error like 'local_delegated%';
  get diagnostics v_n = row_count;
  return v_n = 1;
end
$$;

revoke all on function reclaim_local_delegated_run(uuid, text) from public, anon, authenticated;
grant execute on function reclaim_local_delegated_run(uuid, text) to service_role;
