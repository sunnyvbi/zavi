
create or replace function start_local_agent_run(
  p_work_item_id uuid,
  p_tenant_id    uuid,
  p_owner        text,
  p_trigger      text default 'cron'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_item   agent_work_items;
  v_run_id uuid;
begin
  select * into v_item from agent_work_items
   where id = p_work_item_id
     and tenant_id = p_tenant_id
     and lane = 'local'
     and status = 'leased'
     and lease_owner = p_owner
   for update;
  if not found then
    raise exception
      'work item % not claimable by owner % (must be leased-local for tenant %)',
      p_work_item_id, p_owner, p_tenant_id
      using errcode = '42501';
  end if;

  if v_item.agent_run_id is not null then
    return v_item.agent_run_id;
  end if;

  insert into agent_runs (
    tenant_id, agent_slug, agent_definition_hash, trigger, status,
    enqueued_at, started_at, parse_ok, cost_tokens, cost_usd, tool_calls,
    payload
  ) values (
    p_tenant_id, v_item.agent_slug, 'local', coalesce(p_trigger, 'cron'), 'running',
    now(), now(), false, 0, 0, '[]'::jsonb,
    v_item.payload
  ) returning id into v_run_id;

  update agent_work_items
     set agent_run_id = v_run_id, updated_at = now()
   where id = p_work_item_id;

  return v_run_id;
end $$;
revoke all on function start_local_agent_run(uuid, uuid, text, text) from public;
grant execute on function start_local_agent_run(uuid, uuid, text, text) to service_role;
