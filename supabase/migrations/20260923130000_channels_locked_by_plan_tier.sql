
begin;

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
    "tiktok_organic": "growth",
    "youtube_organic": "growth",
    "ugc": "growth",
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
revoke all on function _tier_agent_min_default() from public, anon, authenticated;
grant execute on function _tier_agent_min_default() to service_role;

update system_config
   set blob = jsonb_set(blob, '{tier_agent_min}', (blob->'tier_agent_min') || '{"meta_ads": "pro", "google_ads": "pro", "youtube_ads": "pro", "tiktok_ads": "pro", "linkedin_ads": "pro", "reddit_ads": "pro", "chatgpt_ads": "pro", "seo": "starter", "geo": "starter", "linkedin_organic": "starter", "reddit_organic": "starter", "x_organic": "starter", "instagram_organic": "starter", "tiktok_organic": "growth", "ugc": "growth", "influencer": "pro", "youtube_organic": "growth", "email_marketing": "pro", "sms": "pro"}'::jsonb)
 where id = 1
   and jsonb_typeof(blob->'tier_agent_min') = 'object';

create or replace function _tier_channel_gated(p_slug text)
returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_slug in ('meta_ads', 'google_ads', 'youtube_ads', 'tiktok_ads', 'linkedin_ads', 'reddit_ads', 'chatgpt_ads', 'seo', 'geo', 'linkedin_organic', 'reddit_organic', 'x_organic', 'instagram_organic', 'tiktok_organic', 'ugc', 'influencer', 'youtube_organic', 'email_marketing', 'sms');
$$;
revoke all on function _tier_channel_gated(text) from public, anon, authenticated;
grant execute on function _tier_channel_gated(text) to service_role;

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
    if not v_gated and _tier_channel_gated(NEW.agent_slug) then
      v_gated := true;
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
    if not v_gated and _tier_channel_gated(NEW.agent_slug) then
      v_gated := true;
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

update system_config
   set blob = jsonb_set(
         blob,
         '{locked_channel_slugs}',
         (select coalesce(jsonb_agg(distinct s), '[]'::jsonb)
            from (
              select jsonb_array_elements_text(
                       case when jsonb_typeof(blob->'locked_channel_slugs') = 'array'
                            then blob->'locked_channel_slugs' else '[]'::jsonb end) as s
              union
              select unnest(array['ugc', 'tiktok_organic', 'tiktok_ads', 'youtube_organic',
                                  'email_marketing', 'influencer'])
            ) x)
       )
 where id = 1;

commit;
