
begin;

alter table conductor_runs
  add column if not exists credits_waived boolean not null default false;

comment on column conductor_runs.credits_waived is
  'True on a tenant''s first Build only: its stage runs take no credit reserve, so they are never charged. Set only by claim_first_free_build.';

create or replace function _first_build_free_eligible(p_tenant_id uuid, p_exclude uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (
    select 1
      from conductor_runs c
     where c.tenant_id = p_tenant_id
       and c.kind = 'build_app'
       and c.id is distinct from p_exclude
       and exists (
         select 1 from agent_runs a
          where a.tenant_id = p_tenant_id
            and a.payload->>'build_conductor_run_id' = c.id::text
       )
  )
$$;
revoke all on function _first_build_free_eligible(uuid, uuid) from public, anon, authenticated;

create or replace function first_build_free_eligible(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select _first_build_free_eligible(p_tenant_id, null)
$$;
revoke all on function first_build_free_eligible(uuid) from public, anon, authenticated;
grant execute on function first_build_free_eligible(uuid) to service_role;

create or replace function claim_first_free_build(p_tenant_id uuid, p_conductor_run_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_conductor_run_id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));
  if not _first_build_free_eligible(p_tenant_id, p_conductor_run_id) then
    return false;
  end if;
  update conductor_runs
     set credits_waived = false, updated_at = now()
   where tenant_id = p_tenant_id and credits_waived and id <> p_conductor_run_id;
  update conductor_runs
     set credits_waived = true, updated_at = now()
   where id = p_conductor_run_id
     and tenant_id = p_tenant_id
     and kind = 'build_app'
     and status = 'provisioning'
  returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function claim_first_free_build(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_first_free_build(uuid, uuid) to service_role;

create or replace function _is_free_build_stage(
  p_tenant_id uuid, p_payload jsonb, p_trigger text, p_enqueued_by uuid
) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select exists (
       select 1
         from conductor_runs c
        where c.tenant_id = p_tenant_id
          and c.id::text = lower(p_payload->>'build_conductor_run_id')
          and c.kind = 'build_app'
          and c.credits_waived
          and c.status in ('provisioning', 'active'))
      where p_enqueued_by is null
        and p_trigger = 'a2a'
        and jsonb_typeof(p_payload) = 'object'),
    false
  )
$$;
revoke all on function _is_free_build_stage(uuid, jsonb, text, uuid) from public, anon, authenticated;

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
  v_gated boolean;
  v_build boolean;
begin
  if NEW.status not in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and not _is_engineer_backend_run(NEW.agent_slug, NEW.enqueued_by, NEW.trigger, NEW.payload) then
    v_build := NEW.enqueued_by is null
               and _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not v_build;
    end if;
    if v_gated then
      v_required := case when v_build then _tier_required('product-builder')
                         else _tier_required(NEW.agent_slug) end;
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
    if v_gated then
      v_required := case when v_build then _tier_required('product-builder')
                         else _tier_required(NEW.agent_slug) end;
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
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

commit;
