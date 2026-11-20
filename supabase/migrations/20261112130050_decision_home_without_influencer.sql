begin;

create or replace function public.decision_home_of(
  p_class text,
  p_run_channel text,
  p_run_enqueued_by uuid,
  p_site_pr_class text,
  p_brief_kind text,
  p_social_channel text
) returns table (home text, home_channel text)
language sql immutable
set search_path = public, pg_temp
as $fn$
  with resolved as (
    select case
      when nullif(p_run_channel, '') is not null then p_run_channel
      when p_run_enqueued_by is null and p_site_pr_class = any (array['geo.create_pr.v1', 'seo.create_pr.v1']::text[]) then case p_site_pr_class
        when 'geo.create_pr.v1' then 'geo'
        when 'seo.create_pr.v1' then 'seo'
      end
      when p_class = 'human.application_review' then case p_brief_kind
        when 'creative' then 'ugc'
      end
      when p_class = 'social.publish.v2' then case p_social_channel
        when 'instagram_image' then 'instagram_organic'
        when 'linkedin' then 'linkedin_organic'
        when 'linkedin_image' then 'linkedin_organic'
        when 'pinterest_pin' then 'pinterest_organic'
        when 'reddit' then 'reddit_organic'
        when 'reddit_comment' then 'reddit_organic'
        when 'tiktok_video' then 'tiktok_organic'
        when 'x' then 'x_organic'
        when 'x_image' then 'x_organic'
        when 'x_video' then 'x_organic'
        when 'youtube_video' then 'youtube_organic'
      end
    end as ch
  ),
  known as (
    select case when ch = any (array['meta_ads', 'google_ads', 'youtube_ads', 'tiktok_ads', 'linkedin_ads', 'reddit_ads', 'x_ads', 'chatgpt_ads', 'seo', 'geo', 'blog', 'linkedin_organic', 'reddit_organic', 'x_organic', 'instagram_organic', 'tiktok_organic', 'pinterest_organic', 'ugc', 'generated_video', 'youtube_organic', 'email_marketing', 'sms']::text[]) then ch end as ch from resolved
  )
  select
    case
      when known.ch is not null then 'channel'
      when coalesce(p_class = any (array['channel.recipe_step']::text[])
        or starts_with(p_class, 'social.publish')
        or starts_with(p_class, 'meta_ads.')
        or starts_with(p_class, 'google_ads.')
        or starts_with(p_class, 'x_ads.')
        or starts_with(p_class, 'linkedin_ads.')
        or starts_with(p_class, 'reddit_ads.')
        or starts_with(p_class, 'chatgpt_ads.')
        or starts_with(p_class, 'growth-lead.'), false) then 'growth'
      else 'needs_you'
    end,
    known.ch
  from known
$fn$;

revoke all on function public.decision_home_of(text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.decision_home_of(text, text, uuid, text, text, text) to service_role;

update decisions set home = null where home_channel = 'influencer';

commit;
