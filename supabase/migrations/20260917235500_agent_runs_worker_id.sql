
alter table agent_runs
  add column if not exists worker_id text;

comment on column agent_runs.worker_id is
  'Which worker claimed this run: canonical (the prod container), dev:<host> (a developer stack against prod data), local-lane (the Mac pull worker). Read by the deploy guard so it only waits for its own runs. NULL = claimed before this column existed.';

create or replace function claim_agent_run(p_run_id uuid, p_worker_id text)
returns agent_runs
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row agent_runs;
  v_tenant_id uuid;
  v_agent_slug text;
  v_trigger text;
  v_killed boolean;
begin
  select tenant_id, agent_slug, trigger
    into v_tenant_id, v_agent_slug, v_trigger
    from agent_runs
   where id = p_run_id;

  if v_tenant_id is null then
    return null;
  end if;

  select exists(
    select 1 from tenant_agent_kill_switch
     where tenant_id = v_tenant_id
       and agent_slug = v_agent_slug
       and override_state = 'hidden'
  ) into v_killed;

  if v_killed then
    insert into enqueue_rejections (
      tenant_id, agent_slug, rejection_reason, body_fingerprint, trigger
    ) values (
      v_tenant_id,
      v_agent_slug,
      'kill_switch_at_claim',
      md5(p_run_id::text),
      coalesce(v_trigger, 'unknown')
    );
    return null;
  end if;

  update agent_runs
     set status = 'running', started_at = now(),
         worker_id = coalesce(p_worker_id, worker_id)
   where id = p_run_id and status = 'queued'
   returning * into v_row;
  return v_row;
end $$;

revoke all on function claim_agent_run(uuid, text) from public, anon, authenticated;
grant execute on function claim_agent_run(uuid, text) to service_role;

create or replace function start_local_agent_run(
  p_work_item_id uuid,
  p_tenant_id    uuid,
  p_owner        text,
  p_trigger      text default 'cron'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
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
    payload, worker_id
  ) values (
    p_tenant_id, v_item.agent_slug, 'local', coalesce(p_trigger, 'cron'), 'running',
    now(), now(), false, 0, 0, '[]'::jsonb,
    v_item.payload, 'local-lane'
  ) returning id into v_run_id;

  update agent_work_items
     set agent_run_id = v_run_id, updated_at = now()
   where id = p_work_item_id;

  return v_run_id;
end $$;
revoke all on function start_local_agent_run(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function start_local_agent_run(uuid, uuid, text, text) to service_role;

do $$
begin
  raise notice '20260917235500: agent_runs.worker_id added; claim_agent_run(uuid,text) stamps it';
end $$;
