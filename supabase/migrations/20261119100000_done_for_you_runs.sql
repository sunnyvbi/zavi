
begin;

create or replace function _is_done_for_you_identity(
  p_tenant_id uuid, p_trigger text, p_enqueued_by uuid, p_cron_dedupe_key text
) returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_cron_dedupe_key is not null
     and p_enqueued_by is null
     and p_trigger is not distinct from 'channel_recipe'
     and p_tenant_id is not null
     and p_cron_dedupe_key in ('done-for-you:' || p_tenant_id::text || ':1',
                               'done-for-you:' || p_tenant_id::text || ':2',
                               'done-for-you:' || p_tenant_id::text || ':3')
$$;
revoke all on function _is_done_for_you_identity(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function _is_done_for_you_identity(uuid, text, uuid, text) to service_role;

create or replace function _is_done_for_you_run(
  p_tenant_id uuid, p_agent_slug text, p_trigger text, p_enqueued_by uuid, p_cron_dedupe_key text
) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_cron_dedupe_key is null
      or p_cron_dedupe_key not like 'done-for-you:%'
      or p_agent_slug is null then false
    else _is_done_for_you_identity(p_tenant_id, p_trigger, p_enqueued_by, p_cron_dedupe_key)
         and _tier_channel_gated(p_agent_slug)
         and _tier_required(p_agent_slug) = 'starter'
  end
$$;
revoke all on function _is_done_for_you_run(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function _is_done_for_you_run(uuid, text, text, uuid, text) to service_role;

create table if not exists public.done_for_you_settled (
  run_id     uuid primary key references public.agent_runs(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  outcome    text not null check (outcome in ('executed', 'cannot_do', 'failed')),
  settled_at timestamptz not null default now()
);
alter table public.done_for_you_settled enable row level security;
revoke all on table public.done_for_you_settled from anon, authenticated;

create or replace function claim_done_for_you_settle(
  p_tenant_id uuid, p_run_id uuid, p_outcome text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run uuid;
begin
  if p_tenant_id is null or p_run_id is null
     or p_outcome is null or p_outcome not in ('executed', 'cannot_do', 'failed') then
    return false;
  end if;
  if not exists (
    select 1 from agent_runs r
     where r.id = p_run_id and r.tenant_id = p_tenant_id
       and _is_done_for_you_identity(r.tenant_id, r.trigger, r.enqueued_by, r.cron_dedupe_key)
  ) then
    return false;
  end if;
  insert into done_for_you_settled (run_id, tenant_id, outcome)
  values (p_run_id, p_tenant_id, p_outcome)
  on conflict (run_id) do nothing
  returning run_id into v_run;
  return v_run is not null;
end $$;
revoke all on function claim_done_for_you_settle(uuid, uuid, text) from public, anon, authenticated;
grant execute on function claim_done_for_you_settle(uuid, uuid, text) to service_role;

create table if not exists public.done_for_you_dispatches (
  run_id        uuid primary key references public.agent_runs(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  dispatched_at timestamptz not null default now()
);
alter table public.done_for_you_dispatches enable row level security;
revoke all on table public.done_for_you_dispatches from anon, authenticated;

create or replace function claim_done_for_you_dispatch(
  p_tenant_id uuid, p_run_id uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run uuid;
begin
  if p_tenant_id is null or p_run_id is null then
    return false;
  end if;
  if not exists (
    select 1 from agent_runs r
     where r.id = p_run_id and r.tenant_id = p_tenant_id
       and _is_done_for_you_identity(r.tenant_id, r.trigger, r.enqueued_by, r.cron_dedupe_key)
  ) then
    return false;
  end if;
  insert into done_for_you_dispatches (run_id, tenant_id)
  values (p_run_id, p_tenant_id)
  on conflict (run_id) do nothing
  returning run_id into v_run;
  return v_run is not null;
end $$;
revoke all on function claim_done_for_you_dispatch(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_done_for_you_dispatch(uuid, uuid) to service_role;

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
                                        NEW.enqueued_by, NEW.cron_dedupe_key)
                 or _is_done_for_you_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
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
  if _is_done_for_you_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
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
                                        NEW.enqueued_by, NEW.cron_dedupe_key)
                 or _is_done_for_you_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
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
  if _is_done_for_you_run(NEW.tenant_id, NEW.agent_slug, NEW.trigger,
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
