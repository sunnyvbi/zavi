
begin;

create or replace function _free_edits_apply(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select _tenant_tier(p_tenant_id) = 'free'
     and _credits_enforced(p_tenant_id)
     and not _credits_unlimited(p_tenant_id)
$$;

create or replace function _is_waived_refine(p_tenant_id uuid, p_run_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_run_id is not null and exists (
    select 1 from conductor_runs c
     where c.id = p_run_id
       and c.tenant_id = p_tenant_id
       and c.kind = 'build_app'
       and c.credits_waived
       and coalesce((c.goal_graph #>> '{0,payload,refine_mode}')::boolean, false))
$$;

create or replace function _free_edits_used(p_tenant_id uuid, p_exclude uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int
    from conductor_runs c
   where c.tenant_id = p_tenant_id
     and c.kind = 'build_app'
     and c.credits_waived
     and c.id is distinct from p_exclude
     and coalesce((c.goal_graph #>> '{0,payload,refine_mode}')::boolean, false)
     and not _is_waived_refine(
           p_tenant_id,
           case when (c.goal_graph #>> '{0,payload,retry_of}')
                     ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (c.goal_graph #>> '{0,payload,retry_of}')::uuid end)
     and (c.status in ('provisioning', 'active')
          or exists (
            select 1 from agent_runs a
             where a.tenant_id = p_tenant_id
               and a.payload->>'build_conductor_run_id' = c.id::text))
$$;

create or replace function free_edit_state(p_tenant_id uuid, p_retry_of uuid default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'applies', _free_edits_apply(p_tenant_id),
    'used', _free_edits_used(p_tenant_id, null),
    'limit', 2,
    'retry_waived', _is_waived_refine(p_tenant_id, p_retry_of))
$$;

create or replace function claim_free_edit(
  p_tenant_id uuid, p_conductor_run_id uuid, p_retry_of uuid default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_conductor_run_id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));
  if not _free_edits_apply(p_tenant_id) then
    return false;
  end if;
  if not _is_waived_refine(p_tenant_id, p_retry_of)
     and _free_edits_used(p_tenant_id, p_conductor_run_id) >= 2 then
    return false;
  end if;
  update conductor_runs
     set credits_waived = true, updated_at = now()
   where id = p_conductor_run_id
     and tenant_id = p_tenant_id
     and kind = 'build_app'
     and status = 'provisioning'
     and objective like '[refine]%'
  returning id into v_id;
  return v_id is not null;
end $$;

revoke all on function _free_edits_apply(uuid)             from public, anon, authenticated;
revoke all on function _free_edits_used(uuid, uuid)        from public, anon, authenticated;
revoke all on function _is_waived_refine(uuid, uuid)       from public, anon, authenticated;
revoke all on function free_edit_state(uuid, uuid)         from public, anon, authenticated;
revoke all on function claim_free_edit(uuid, uuid, uuid)   from public, anon, authenticated;
grant execute on function free_edit_state(uuid, uuid)       to service_role;
grant execute on function claim_free_edit(uuid, uuid, uuid) to service_role;

create or replace function _is_first_goal_review(
  p_tenant_id uuid, p_agent_slug text, p_trigger text, p_enqueued_by uuid, p_cron_dedupe_key text
) returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_cron_dedupe_key is not null
     and p_enqueued_by is null
     and p_trigger is not distinct from 'a2a'
     and p_agent_slug is not distinct from 'cgo'
     and p_tenant_id is not null
     and p_cron_dedupe_key = p_tenant_id::text || ':cgo-first-review'
$$;
revoke all on function _is_first_goal_review(uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function _is_first_goal_review(uuid, text, text, uuid, text) to service_role;

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
