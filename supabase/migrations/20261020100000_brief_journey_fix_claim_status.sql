
begin;

create or replace function claim_brief_journey_fix_status(
  p_tenant_id uuid, p_site_id uuid, p_conductor_run_id uuid, p_attempt integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_found boolean; v_run uuid; v_attempt integer; v_token uuid; v_bound uuid;
begin
  if p_tenant_id is null or p_site_id is null or p_conductor_run_id is null or p_attempt is null or p_attempt < 1 then
    return jsonb_build_object('status', 'invalid');
  end if;
  update site_design_briefs
     set journey_fix_conductor_run_id = p_conductor_run_id,
         journey_fix_attempt = p_attempt,
         journey_fix_token = gen_random_uuid(),
         journey_fix_agent_run_id = null,
         journey_fix_claimed_at = now(),
         updated_at = now()
   where tenant_id = p_tenant_id
     and site_id = p_site_id
     and journey_fix_claimed_at is null;
  select true, journey_fix_conductor_run_id, journey_fix_attempt, journey_fix_token, journey_fix_agent_run_id
    into v_found, v_run, v_attempt, v_token, v_bound
    from site_design_briefs
   where tenant_id = p_tenant_id and site_id = p_site_id;
  if v_found is not true then
    return jsonb_build_object('status', 'no_design');
  end if;
  if v_run = p_conductor_run_id and v_attempt = p_attempt and v_token is not null then
    return jsonb_build_object('status', 'claimed', 'token', v_token);
  end if;
  if v_bound is not null then
    return jsonb_build_object('status', 'already_used');
  end if;
  return jsonb_build_object('status', 'reserved');
end $$;

create or replace function _is_brief_journey_fix_run(
  p_tenant_id uuid, p_run_id uuid, p_agent_slug text, p_payload jsonb, p_trigger text, p_enqueued_by uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_site uuid;
begin
  if p_run_id is null or p_enqueued_by is not null or p_trigger is distinct from 'a2a'
     or p_agent_slug is distinct from 'engineer'
     or jsonb_typeof(p_payload) is distinct from 'object'
     or p_payload->>'brief_journey_fix' is distinct from 'true'
     or coalesce(p_payload->>'brief_journey_fix_token', '') = '' then
    return false;
  end if;
  update site_design_briefs d
     set journey_fix_agent_run_id = p_run_id
   where d.tenant_id = p_tenant_id
     and d.journey_fix_token::text = lower(p_payload->>'brief_journey_fix_token')
     and d.site_id::text = lower(p_payload->>'site_id')
     and d.journey_fix_conductor_run_id::text = lower(p_payload->>'build_conductor_run_id')
     and d.journey_fix_attempt::text = p_payload->>'repair_attempt'
     and (d.journey_fix_agent_run_id is null or d.journey_fix_agent_run_id = p_run_id)
  returning d.site_id into v_site;
  if v_site is not null then
    return true;
  end if;
  if exists (select 1 from agent_runs r where r.id = p_run_id and r.status = 'queued') then
    raise exception 'brief_journey_fix_unbound' using errcode = 'P0001';
  end if;
  return false;
end $$;

revoke all on function claim_brief_journey_fix_status(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function claim_brief_journey_fix_status(uuid, uuid, uuid, integer) to service_role;
revoke all on function _is_brief_journey_fix_run(uuid, uuid, text, jsonb, text, uuid) from public, anon, authenticated;

commit;
