
begin;

create or replace function _is_engineer_backend_run(
  p_slug text, p_enqueued_by uuid, p_trigger text, p_payload jsonb
) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_slug = 'engineer'
     and p_enqueued_by is null
     and (
       coalesce(p_trigger, '') not in ('chat','slack','teams','telegram','discord','whatsapp','email','manual')
       or coalesce(p_payload->>'kind', '') = 'engineer_pr_followup'
     )
$$;
revoke all on function _is_engineer_backend_run(text, uuid, text, jsonb) from public, anon, authenticated;

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
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    perform reserve_run_credits(NEW.tenant_id, NEW.id, NEW.agent_slug,
                                _reserve_estimate_for(NEW.agent_slug),
                                coalesce(NEW.infra_retry_count, 0));
  end if;
  return null;
end $$;

create table if not exists conductor_dispatch_claims (
  conductor_run_id uuid not null references conductor_runs(id) on delete cascade,
  dedup_key        text not null,
  claimed_at       timestamptz not null default now(),
  primary key (conductor_run_id, dedup_key)
);
alter table conductor_dispatch_claims enable row level security;
revoke all on conductor_dispatch_claims from anon, authenticated;

create table if not exists conductor_budget_refunds (
  conductor_run_id uuid not null references conductor_runs(id) on delete cascade,
  refund_key       text not null,
  amount_usd       numeric not null,
  refunded_at      timestamptz not null default now(),
  primary key (conductor_run_id, refund_key)
);
alter table conductor_budget_refunds enable row level security;
revoke all on conductor_budget_refunds from anon, authenticated;

create or replace function refund_conductor_budget(
  p_conductor_run_id uuid, p_amount_usd numeric, p_refund_key text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ins text;
begin
  if p_conductor_run_id is null or p_refund_key is null
     or p_amount_usd is null or p_amount_usd <= 0 then
    return false;
  end if;
  insert into conductor_budget_refunds (conductor_run_id, refund_key, amount_usd)
  values (p_conductor_run_id, p_refund_key, p_amount_usd)
  on conflict do nothing
  returning refund_key into v_ins;
  if v_ins is null then
    return false;
  end if;
  update conductor_runs
     set spend_usd = greatest(0, spend_usd - p_amount_usd), updated_at = now()
   where id = p_conductor_run_id;
  return true;
end $$;
revoke all on function refund_conductor_budget(uuid, numeric, text) from public, anon, authenticated;
grant execute on function refund_conductor_budget(uuid, numeric, text) to service_role;

commit;
