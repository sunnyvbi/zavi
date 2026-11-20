
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
    "supply-demand-balancer": "free",
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
   set blob = jsonb_set(blob, '{tier_agent_min,chatgpt_ads}', '"pro"'::jsonb)
 where id = 1
   and jsonb_typeof(blob->'tier_agent_min') = 'object'
   and not (blob->'tier_agent_min' ? 'chatgpt_ads');
