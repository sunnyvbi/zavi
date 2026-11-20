
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
    "blog": "starter",
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
   set blob = jsonb_set(blob, '{tier_agent_min}', (blob->'tier_agent_min') || '{"blog": "starter"}'::jsonb)
 where id = 1
   and jsonb_typeof(blob->'tier_agent_min') = 'object'
   and not (blob->'tier_agent_min') ? 'blog';

create or replace function _tier_channel_gated(p_slug text)
returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_slug in ('meta_ads', 'google_ads', 'youtube_ads', 'tiktok_ads', 'linkedin_ads', 'reddit_ads', 'chatgpt_ads', 'seo', 'geo', 'blog', 'linkedin_organic', 'reddit_organic', 'x_organic', 'instagram_organic', 'tiktok_organic', 'ugc', 'influencer', 'youtube_organic', 'email_marketing', 'sms');
$$;
revoke all on function _tier_channel_gated(text) from public, anon, authenticated;
grant execute on function _tier_channel_gated(text) to service_role;
