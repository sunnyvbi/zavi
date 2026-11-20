
create or replace function _tier_agent_min_default()
returns jsonb language sql immutable security definer set search_path = public, pg_temp as $$
  select '{
    "operator": "free",
    "research": "free",
    "advisor": "free",
    "cgo": "free",
    "growth-lead": "free",
    "pm": "free",
    "chief-of-staff": "free",
    "support-lead": "free",
    "qa": "free",
    "dispute-response": "free",
    "onboarding-discovery": "free",
    "seo-geo": "free",
    "browser-operator": "starter",
    "content-design": "starter",
    "content-seo": "starter",
    "product-builder": "starter",
    "performance-marketer": "starter",
    "generated_video": "starter",
    "seo": "starter",
    "geo": "starter",
    "linkedin_organic": "starter",
    "reddit_organic": "starter",
    "x_organic": "starter",
    "instagram_organic": "starter",
    "tiktok_organic": "starter",
    "youtube_organic": "starter",
    "ugc": "starter",
    "engineer": "pro",
    "fundraising": "pro",
    "supply-demand-balancer": "pro",
    "google_ads": "pro",
    "meta_ads": "pro",
    "tiktok_ads": "pro",
    "linkedin_ads": "pro",
    "reddit_ads": "pro",
    "youtube_ads": "pro",
    "chatgpt_ads": "pro",
    "influencer": "pro",
    "email_marketing": "pro",
    "sms": "pro"
  }'::jsonb;
$$;

update system_config
   set blob = jsonb_set(blob, '{tier_agent_min,supply-demand-balancer}', '"pro"'::jsonb)
 where id = 1
   and jsonb_typeof(blob->'tier_agent_min') = 'object';

create or replace function _tier_always_pro(p_slug text)
returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select coalesce(p_slug in ('engineer', 'fundraising', 'supply-demand-balancer'), false);
$$;

create or replace function _tier_required(p_slug text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when _tier_always_pro(p_slug) then 'pro'
    else coalesce(
      (select case
                when m->>p_slug in ('free', 'starter', 'growth', 'pro') then m->>p_slug
              end
         from (select case
                        when jsonb_typeof(sc.blob->'tier_agent_min') = 'object' then sc.blob->'tier_agent_min'
                        else _tier_agent_min_default()
                      end as m
                 from (select 1) one
                 left join system_config sc on sc.id = 1) cfg),
      'pro'
    )
  end;
$$;

create or replace function _is_live_build_stage(
  p_tenant_id uuid, p_slug text, p_payload jsonb, p_trigger text
)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select exists (
       select 1
         from conductor_runs c
        where c.tenant_id = p_tenant_id
          and c.id::text = lower(p_payload->>'build_conductor_run_id')
          and c.kind = 'build_app'
          and c.status in ('provisioning', 'active'))
      where p_slug = 'engineer'
        and p_trigger = 'a2a'
        and jsonb_typeof(p_payload) = 'object'),
    false
  );
$$;

drop function if exists _is_live_build_stage(uuid, text, jsonb);

create or replace function _trg_reserve_run_credits()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_required text;
  v_gated boolean;
begin
  if NEW.status not in ('success','parse_failed','error','failed','cancelled','dispatch_error') then
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    end if;
    if v_gated then
      v_required := _tier_required(NEW.agent_slug);
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
begin
  if OLD.status in ('success','parse_failed','error','failed','cancelled','dispatch_error')
     and NEW.status = 'queued' then
    v_gated := _tier_gate_enforced();
    if not v_gated and _tier_always_pro(NEW.agent_slug) then
      v_gated := not _is_live_build_stage(NEW.tenant_id, NEW.agent_slug, NEW.payload, NEW.trigger);
    end if;
    if v_gated then
      v_required := _tier_required(NEW.agent_slug);
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

revoke all on function _tier_agent_min_default()          from public, anon, authenticated;
revoke all on function _tier_always_pro(text)             from public, anon, authenticated;
revoke all on function _tier_required(text)               from public, anon, authenticated;
revoke all on function _is_live_build_stage(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function _tier_agent_min_default()          to service_role;
grant execute on function _tier_always_pro(text)             to service_role;
grant execute on function _tier_required(text)               to service_role;
grant execute on function _is_live_build_stage(uuid, text, jsonb, text) to service_role;
