
update system_config
   set blob = jsonb_set(blob, '{tier_agent_min}', (blob->'tier_agent_min') || '{"generated_video": "starter"}'::jsonb)
 where id = 1
   and jsonb_typeof(blob->'tier_agent_min') = 'object';

create or replace function _tier_channel_gated(p_slug text)
returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_slug in ('meta_ads', 'google_ads', 'youtube_ads', 'tiktok_ads', 'linkedin_ads', 'reddit_ads', 'chatgpt_ads', 'seo', 'geo', 'blog', 'linkedin_organic', 'reddit_organic', 'x_organic', 'instagram_organic', 'pinterest_organic', 'tiktok_organic', 'ugc', 'generated_video', 'influencer', 'youtube_organic', 'email_marketing', 'sms');
$$;
revoke all on function _tier_channel_gated(text) from public, anon, authenticated;
grant execute on function _tier_channel_gated(text) to service_role;
