
create or replace function requeue_outage_retry(
  p_tenant_id             uuid,
  p_run_id                uuid,
  p_expected_status       text,
  p_expected_retry_count  int,
  p_expected_finished_at  timestamptz,
  p_marker                jsonb,
  p_slack_claim_ids       text[] default '{}',
  p_supersession          jsonb default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id   uuid;
  v_kind text := coalesce(p_supersession->>'kind', '');
begin
  if p_tenant_id is null or p_run_id is null or p_expected_status is null
     or p_expected_retry_count is null or p_expected_finished_at is null then
    raise exception 'requeue_outage_retry: missing argument' using errcode = '22023';
  end if;
  if p_expected_status not in ('dispatch_error', 'failed') then
    raise exception 'requeue_outage_retry: not a failed status' using errcode = '22023';
  end if;
  if p_marker is null or jsonb_typeof(p_marker) <> 'object' then
    raise exception 'requeue_outage_retry: marker must be an object' using errcode = '22023';
  end if;

  if public.is_tenant_disabled(p_tenant_id) then
    return 'tenant_disabled';
  end if;
  if exists (
    select 1 from agent_runs r
      join tenant_agent_kill_switch k
        on k.tenant_id = r.tenant_id and k.agent_slug = r.agent_slug and k.override_state = 'hidden'
     where r.id = p_run_id and r.tenant_id = p_tenant_id
  ) then
    return 'agent_hidden';
  end if;
  update agent_runs
     set status             = 'queued',
         infra_retry_count  = p_expected_retry_count + 1,
         enqueued_at        = now(),
         started_at         = null,
         finished_at        = null,
         error              = null,
         needs_run_end_emit = false,
         payload            = coalesce(payload, '{}'::jsonb) || jsonb_build_object('outage_retry', p_marker)
   where id = p_run_id
     and tenant_id = p_tenant_id
     and status = p_expected_status
     and infra_retry_count = p_expected_retry_count
     and finished_at = p_expected_finished_at
     and (payload is null or payload->'outage_retry' is null)
     and not (v_kind <> '' and exists (
       select 1 from agent_runs n
        where n.tenant_id = p_tenant_id
          and n.agent_slug = agent_runs.agent_slug
          and n.trigger is not distinct from agent_runs.trigger
          and n.enqueued_at > agent_runs.enqueued_at
          and n.id <> agent_runs.id
          and case v_kind
                when 'thread' then n.payload->>'thread_id' = p_supersession->>'thread_id'
                when 'slack' then n.payload->'slack'->>'channel_id' = p_supersession->>'channel_id'
                              and n.payload->'slack'->>'thread_ts' = p_supersession->>'thread_ts'
                when 'custom_trigger' then n.custom_trigger_id::text = p_supersession->>'trigger_id'
                when 'agent' then true
                else false
              end))
  returning id into v_id;
  if v_id is null then
    if exists (select 1 from agent_runs r
                where r.id = p_run_id and r.tenant_id = p_tenant_id
                  and r.status = p_expected_status
                  and r.infra_retry_count = p_expected_retry_count
                  and r.finished_at = p_expected_finished_at
                  and (r.payload is null or r.payload->'outage_retry' is null)) then
      return 'superseded';
    end if;
    return 'lost';
  end if;

  delete from agent_thread_messages
   where agent_run_id = p_run_id
     and tenant_id = p_tenant_id
     and sender_role = 'assistant'
     and coalesce(meta->>'is_error', '') = 'true';

  if coalesce(array_length(p_slack_claim_ids, 1), 0) > 0 then
    update slack_triage_claims
       set replied_at = null
     where tenant_id = p_tenant_id
       and event_id = any(p_slack_claim_ids);
  end if;

  return 'requeued';
end $$;

revoke all on function requeue_outage_retry(uuid, uuid, text, int, timestamptz, jsonb, text[], jsonb) from public, anon, authenticated;
grant execute on function requeue_outage_retry(uuid, uuid, text, int, timestamptz, jsonb, text[], jsonb) to service_role;

create or replace function mark_outage_retry_skipped(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_marker    jsonb
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_run_id is null or p_marker is null or jsonb_typeof(p_marker) <> 'object' then
    raise exception 'mark_outage_retry_skipped: bad argument' using errcode = '22023';
  end if;
  update agent_runs
     set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('outage_retry', p_marker)
   where id = p_run_id
     and tenant_id = p_tenant_id
     and status in ('dispatch_error', 'failed')
     and (payload is null or payload->'outage_retry' is null)
  returning id into v_id;
  return v_id is not null;
end $$;

revoke all on function mark_outage_retry_skipped(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function mark_outage_retry_skipped(uuid, uuid, jsonb) to service_role;
