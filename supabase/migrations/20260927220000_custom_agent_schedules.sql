
begin;

create table custom_agent_whatsapp_pending (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null,
  trigger_id uuid,
  run_id uuid unique references agent_runs(id) on delete set null,
  wa_id text not null check (length(wa_id) between 1 and 64),
  phone_number_id text not null check (length(phone_number_id) between 1 and 64),
  text text not null check (length(text) between 1 and 32000),
  summary text check (summary is null or length(summary) <= 2048),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  nudged_at timestamptz,
  foreign key (agent_id, tenant_id) references custom_agents(id, tenant_id) on delete cascade
);
alter table custom_agent_whatsapp_pending enable row level security;
revoke all on custom_agent_whatsapp_pending from public, anon, authenticated;

alter table custom_agents
  add column credits_notice_at timestamptz,
  add column last_outcome_key text check (last_outcome_key is null or length(last_outcome_key) <= 200);

create or replace function record_custom_agent_outcome(
  p_tenant_id uuid,
  p_agent_id uuid,
  p_trigger_id uuid,
  p_outcome text,
  p_key text,
  p_summary text default null
) returns table (o_failures int, o_just_paused boolean, o_applied boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent custom_agents;
  v_new int;
  v_pause boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role only' using errcode = '42501';
  end if;
  if p_outcome not in ('delivered', 'failed') then
    raise exception 'custom_agent_outcome_invalid' using errcode = '22023';
  end if;
  select * into v_agent from custom_agents
   where id = p_agent_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return;
  end if;
  if p_key is not null and v_agent.last_outcome_key is not distinct from p_key then
    return query select v_agent.consecutive_failures, false, false;
    return;
  end if;

  if p_outcome = 'delivered' then
    update custom_agents set
      consecutive_failures = 0,
      credits_notice_at    = null,
      last_outcome_key     = p_key,
      updated_at           = now()
    where id = v_agent.id and tenant_id = p_tenant_id;
    if p_trigger_id is not null and p_summary is not null then
      update custom_agent_triggers set
        last_result_summary = left(p_summary, 2048),
        updated_at          = now()
      where id = p_trigger_id and agent_id = v_agent.id and tenant_id = p_tenant_id;
    end if;
    return query select 0, false, true;
    return;
  end if;

  v_new := v_agent.consecutive_failures + 1;
  v_pause := v_new >= 3 and v_agent.status = 'active';
  update custom_agents set
    consecutive_failures = v_new,
    credits_notice_at    = null,
    status               = case when v_pause then 'paused' else status end,
    paused_reason        = case when v_pause then 'Paused after 3 runs in a row did not finish.'
                                else paused_reason end,
    last_outcome_key     = p_key,
    updated_at           = now()
  where id = v_agent.id and tenant_id = p_tenant_id;
  return query select v_new, v_pause, true;
end $$;

create or replace function set_custom_agent_status(
  p_tenant_id uuid, p_agent_id uuid, p_status text
) returns custom_agents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row custom_agents;
begin
  perform _custom_agent_authorize(p_tenant_id);
  if p_status not in ('active', 'paused', 'archived') then
    raise exception 'custom_agent_status_invalid' using errcode = '22023';
  end if;
  if p_status = 'active' then
    perform _custom_agent_require_paid(p_tenant_id);
  end if;
  update custom_agents set
    status        = p_status,
    paused_reason = case when p_status = 'paused' then 'Paused by a teammate' else null end,
    consecutive_failures = case when p_status = 'active' then 0 else consecutive_failures end,
    updated_at    = now()
  where id = p_agent_id and tenant_id = p_tenant_id and status <> 'archived'
  returning * into v_row;
  if not found then
    raise exception 'custom_agent_not_found' using errcode = 'P0002';
  end if;
  if p_status = 'archived' then
    update custom_agent_triggers set enabled = false, updated_at = now()
     where agent_id = p_agent_id and tenant_id = p_tenant_id;
  end if;
  return v_row;
end $$;

revoke all on function record_custom_agent_outcome(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function record_custom_agent_outcome(uuid, uuid, uuid, text, text, text) to service_role;
revoke all on function set_custom_agent_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function set_custom_agent_status(uuid, uuid, text) to authenticated, service_role;

commit;
