
begin;

alter table public.site_design_briefs
  add column if not exists journey_fix_conductor_run_id uuid,
  add column if not exists journey_fix_attempt integer,
  add column if not exists journey_fix_token uuid,
  add column if not exists journey_fix_agent_run_id uuid,
  add column if not exists journey_fix_claimed_at timestamptz;

create or replace function claim_brief_journey_fix(
  p_tenant_id uuid, p_site_id uuid, p_conductor_run_id uuid, p_attempt integer
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run uuid; v_attempt integer; v_token uuid;
begin
  if p_tenant_id is null or p_site_id is null or p_conductor_run_id is null or p_attempt is null or p_attempt < 1 then
    return null;
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
  select journey_fix_conductor_run_id, journey_fix_attempt, journey_fix_token into v_run, v_attempt, v_token
    from site_design_briefs
   where tenant_id = p_tenant_id and site_id = p_site_id;
  if v_run = p_conductor_run_id and v_attempt = p_attempt then
    return v_token;
  end if;
  return null;
end $$;

create or replace function release_brief_journey_fix(
  p_tenant_id uuid, p_site_id uuid, p_token uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_site uuid;
begin
  if p_token is null then
    return false;
  end if;
  update site_design_briefs
     set journey_fix_conductor_run_id = null,
         journey_fix_attempt = null,
         journey_fix_token = null,
         journey_fix_claimed_at = null,
         updated_at = now()
   where tenant_id = p_tenant_id
     and site_id = p_site_id
     and journey_fix_token = p_token
     and journey_fix_agent_run_id is null
  returning site_id into v_site;
  return v_site is not null;
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
  return v_site is not null;
end $$;

revoke all on function claim_brief_journey_fix(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function release_brief_journey_fix(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function _is_brief_journey_fix_run(uuid, uuid, text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function claim_brief_journey_fix(uuid, uuid, uuid, integer) to service_role;
grant execute on function release_brief_journey_fix(uuid, uuid, uuid) to service_role;

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
  v_gated boolean;
  v_build boolean;
  v_preview boolean;
begin
  if NEW.status not in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and not _is_engineer_backend_run(NEW.agent_slug, NEW.enqueued_by, NEW.trigger, NEW.payload) then
    v_build := NEW.enqueued_by is null
               and _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not v_build;
    end if;
    if not v_gated and _tier_channel_gated(NEW.agent_slug) then
      v_gated := true;
    end if;
    if not v_gated and _is_custom_agent_slug(NEW.agent_slug) then
      v_gated := true;
    end if;
    v_preview := _is_signup_preview_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                                        NEW.enqueued_by, NEW.cron_dedupe_key);
    if v_gated and not v_preview then
      v_required := case when v_build then _tier_required('product-builder')
                         else _tier_required_for_run(NEW.tenant_id, NEW.agent_slug,
                                                     NEW.id, NEW.cron_dedupe_key) end;
      if _tier_rank(_tenant_tier(NEW.tenant_id)) < _tier_rank(v_required) then
        raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = v_required;
      end if;
    end if;
  end if;
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if _is_brief_journey_fix_run(NEW.tenant_id, NEW.id, NEW.agent_slug, NEW.payload,
                               NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
  if _is_free_build_stage(NEW.tenant_id, NEW.payload, NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
  if _is_signup_preview_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                            NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
  if _is_first_goal_review(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                           NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
  if NEW.status in ('queued', 'running') then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

create or replace function _trg_rereserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
  v_gated boolean;
  v_build boolean;
  v_preview boolean;
begin
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued'
     and not _is_engineer_backend_run(NEW.agent_slug, NEW.enqueued_by, NEW.trigger, NEW.payload) then
    v_build := NEW.enqueued_by is null
               and _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not v_build;
    end if;
    if not v_gated and _tier_channel_gated(NEW.agent_slug) then
      v_gated := true;
    end if;
    if not v_gated and _is_custom_agent_slug(NEW.agent_slug) then
      v_gated := true;
    end if;
    v_preview := _is_signup_preview_identity(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                                        NEW.enqueued_by, NEW.cron_dedupe_key);
    if v_gated and not v_preview then
      v_required := case when v_build then _tier_required('product-builder')
                         else _tier_required_for_run(NEW.tenant_id, NEW.agent_slug,
                                                     NEW.id, NEW.cron_dedupe_key) end;
      if _tier_rank(_tenant_tier(NEW.tenant_id)) < _tier_rank(v_required) then
        raise exception 'plan_upgrade_required' using errcode = 'P0001', detail = v_required;
      end if;
    end if;
  end if;
  if not _credits_enforced(NEW.tenant_id) then
    return null;
  end if;
  if _is_brief_journey_fix_run(NEW.tenant_id, NEW.id, NEW.agent_slug, NEW.payload,
                               NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
  if _is_free_build_stage(NEW.tenant_id, NEW.payload, NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
  if _is_signup_preview_identity(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                            NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
  if _is_first_goal_review(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
                           NEW.enqueued_by, NEW.cron_dedupe_key) then
    return null;
  end if;
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

revoke all on function _trg_reserve_run_credits()   from public, anon, authenticated;
revoke all on function _trg_rereserve_run_credits() from public, anon, authenticated;

commit;
