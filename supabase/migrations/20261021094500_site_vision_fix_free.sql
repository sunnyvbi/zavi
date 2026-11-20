
begin;

create table if not exists public.site_vision_fix_claims (
  conductor_run_id uuid not null references public.conductor_runs(id) on delete cascade,
  site_id          uuid not null,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  attempt          integer not null check (attempt >= 1),
  token            uuid not null,
  agent_run_id     uuid,
  claimed_at       timestamptz not null default now(),
  primary key (conductor_run_id, site_id)
);
alter table public.site_vision_fix_claims enable row level security;
revoke all on table public.site_vision_fix_claims from anon, authenticated;

create or replace function claim_site_vision_fix_status(
  p_tenant_id uuid, p_site_id uuid, p_conductor_run_id uuid, p_attempt integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_found boolean; v_attempt integer; v_token uuid; v_bound uuid;
begin
  if p_tenant_id is null or p_site_id is null or p_conductor_run_id is null or p_attempt is null or p_attempt < 1 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not exists (select 1 from conductor_runs c where c.id = p_conductor_run_id and c.tenant_id = p_tenant_id) then
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into site_vision_fix_claims (conductor_run_id, site_id, tenant_id, attempt, token)
  values (p_conductor_run_id, p_site_id, p_tenant_id, p_attempt, gen_random_uuid())
  on conflict (conductor_run_id, site_id) do nothing;
  select true, attempt, token, agent_run_id into v_found, v_attempt, v_token, v_bound
    from site_vision_fix_claims
   where conductor_run_id = p_conductor_run_id and site_id = p_site_id and tenant_id = p_tenant_id;
  if v_found is not true then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_attempt = p_attempt then
    return jsonb_build_object('status', 'claimed', 'token', v_token);
  end if;
  if v_bound is not null then
    return jsonb_build_object('status', 'already_used');
  end if;
  return jsonb_build_object('status', 'reserved');
end $$;

create or replace function release_site_vision_fix(
  p_tenant_id uuid, p_site_id uuid, p_conductor_run_id uuid, p_token uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_site uuid;
begin
  if p_token is null then
    return false;
  end if;
  delete from site_vision_fix_claims
   where tenant_id = p_tenant_id
     and site_id = p_site_id
     and conductor_run_id = p_conductor_run_id
     and token = p_token
     and agent_run_id is null
  returning site_id into v_site;
  return v_site is not null;
end $$;

create or replace function _is_site_vision_fix_run(
  p_tenant_id uuid, p_run_id uuid, p_agent_slug text, p_payload jsonb, p_trigger text, p_enqueued_by uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_site uuid;
begin
  if p_run_id is null or p_enqueued_by is not null or p_trigger is distinct from 'a2a'
     or p_agent_slug is distinct from 'engineer'
     or jsonb_typeof(p_payload) is distinct from 'object'
     or p_payload->>'vision_fix' is distinct from 'true'
     or coalesce(p_payload->>'vision_fix_token', '') = '' then
    return false;
  end if;
  update site_vision_fix_claims v
     set agent_run_id = p_run_id
   where v.tenant_id = p_tenant_id
     and v.token::text = lower(p_payload->>'vision_fix_token')
     and v.site_id::text = lower(p_payload->>'site_id')
     and v.conductor_run_id::text = lower(p_payload->>'build_conductor_run_id')
     and v.attempt::text = p_payload->>'repair_attempt'
     and (v.agent_run_id is null or v.agent_run_id = p_run_id)
  returning v.site_id into v_site;
  if v_site is not null then
    return true;
  end if;
  if exists (select 1 from agent_runs r where r.id = p_run_id and r.status = 'queued') then
    raise exception 'site_vision_fix_unbound' using errcode = 'P0001';
  end if;
  return false;
end $$;

revoke all on function claim_site_vision_fix_status(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function release_site_vision_fix(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function _is_site_vision_fix_run(uuid, uuid, text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function claim_site_vision_fix_status(uuid, uuid, uuid, integer) to service_role;
grant execute on function release_site_vision_fix(uuid, uuid, uuid, uuid) to service_role;

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
  if _is_site_vision_fix_run(NEW.tenant_id, NEW.id, NEW.agent_slug, NEW.payload,
                             NEW.trigger, NEW.enqueued_by) then
    return null;
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
  if _is_site_vision_fix_run(NEW.tenant_id, NEW.id, NEW.agent_slug, NEW.payload,
                             NEW.trigger, NEW.enqueued_by) then
    return null;
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
