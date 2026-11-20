
begin;

alter table custom_agents
  add column paused_by uuid,
  add column paused_at timestamptz;

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
    paused_at            = case when v_pause then now() else paused_at end,
    paused_by            = case when v_pause then null else paused_by end,
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
    paused_at     = case when p_status = 'paused' then now() else null end,
    paused_by     = case when p_status = 'paused' then auth.uid() else null end,
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

create or replace function unarchive_custom_agent(
  p_tenant_id uuid, p_agent_id uuid, p_reserved_names text[]
) returns custom_agents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row custom_agents;
  v_norm text;
begin
  perform _custom_agent_authorize(p_tenant_id);
  select name_norm into v_norm from custom_agents
   where id = p_agent_id and tenant_id = p_tenant_id and status = 'archived';
  if not found then
    raise exception 'custom_agent_not_found' using errcode = 'P0002';
  end if;
  perform _custom_agent_check_name(p_tenant_id, v_norm, p_reserved_names, p_agent_id);
  begin
    update custom_agents set
      status        = 'paused',
      paused_reason = 'Unarchived. Resume it to start running again.',
      paused_at     = now(),
      paused_by     = null,
      updated_at    = now()
    where id = p_agent_id and tenant_id = p_tenant_id and status = 'archived'
    returning * into v_row;
  exception when unique_violation then
    raise exception 'custom_agent_name_taken' using errcode = '23505';
  end;
  if not found then
    raise exception 'custom_agent_not_found' using errcode = 'P0002';
  end if;
  update custom_agent_triggers set enabled = true, updated_at = now()
   where agent_id = p_agent_id and tenant_id = p_tenant_id;
  return v_row;
end $$;

revoke all on function record_custom_agent_outcome(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function record_custom_agent_outcome(uuid, uuid, uuid, text, text, text) to service_role;
revoke all on function set_custom_agent_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function set_custom_agent_status(uuid, uuid, text) to authenticated, service_role;
revoke all on function unarchive_custom_agent(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function unarchive_custom_agent(uuid, uuid, text[]) to authenticated, service_role;

commit;
