
alter table agent_runs
  add column if not exists blocked_by_run_id uuid references agent_runs(id) on delete set null;

comment on column agent_runs.blocked_by_run_id is
  'Slice 2: when status=blocked, the in-flight run on the same thread this one waits behind. Cleared on promotion to queued.';

create index if not exists agent_runs_blocked_thread_idx
  on agent_runs (tenant_id, (payload->>'thread_id'), enqueued_at)
  where status = 'blocked';

create or replace function promote_next_blocked_run(
  p_tenant_id uuid,
  p_thread_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  select id into v_run_id
  from agent_runs
  where tenant_id = p_tenant_id
    and status = 'blocked'
    and payload->>'thread_id' = p_thread_id
  order by enqueued_at asc
  limit 1
  for update skip locked;

  if v_run_id is null then
    return null;
  end if;

  update agent_runs
     set status = 'queued',
         blocked_by_run_id = null
   where id = v_run_id
     and status = 'blocked';

  return v_run_id;
end;
$$;

revoke all on function promote_next_blocked_run(uuid, text) from public;
