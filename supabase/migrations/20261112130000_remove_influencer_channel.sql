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
    "blog": "starter",
    "linkedin_organic": "starter",
    "reddit_organic": "starter",
    "x_organic": "starter",
    "instagram_organic": "starter",
    "pinterest_organic": "starter",
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
    "x_ads": "pro",
    "email_marketing": "pro",
    "sms": "pro"
  }'::jsonb;
$$;
revoke all on function _tier_agent_min_default() from public, anon, authenticated;
grant execute on function _tier_agent_min_default() to service_role;

update system_config
   set blob = jsonb_set(blob, '{tier_agent_min}', (blob->'tier_agent_min') - 'influencer')
 where id = 1
   and jsonb_typeof(blob->'tier_agent_min') = 'object'
   and blob->'tier_agent_min' ? 'influencer';

create or replace function _tier_channel_gated(p_slug text)
returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select p_slug in ('meta_ads', 'google_ads', 'youtube_ads', 'tiktok_ads', 'linkedin_ads', 'reddit_ads', 'x_ads', 'chatgpt_ads', 'seo', 'geo', 'blog', 'linkedin_organic', 'reddit_organic', 'x_organic', 'instagram_organic', 'pinterest_organic', 'tiktok_organic', 'ugc', 'generated_video', 'youtube_organic', 'email_marketing', 'sms');
$$;
revoke all on function _tier_channel_gated(text) from public, anon, authenticated;
grant execute on function _tier_channel_gated(text) to service_role;

update system_config
   set blob = (
         select jsonb_object_agg(
                  key,
                  case
                    when key in ('locked_channel_slugs', 'disabled_agent_slugs', 'enabled_agent_slugs',
                                 'marketplace_visible_slugs', 'disabled_voice_agent_slugs')
                     and jsonb_typeof(value) = 'array'
                    then value - 'influencer'
                    else value
                  end)
           from jsonb_each(blob)
       ),
       updated_at = now()
 where id = 1
   and jsonb_typeof(blob) = 'object'
   and exists (
     select 1 from jsonb_each(blob) e
      where e.key in ('locked_channel_slugs', 'disabled_agent_slugs', 'enabled_agent_slugs',
                      'marketplace_visible_slugs', 'disabled_voice_agent_slugs')
        and jsonb_typeof(e.value) = 'array'
        and e.value ? 'influencer'
   );

update decisions d
   set status = 'archived', archived_at = now()
 where d.status = 'proposed'
   and exists (
     select 1 from agent_runs r
      where r.id = d.agent_run_id
        and r.tenant_id = d.tenant_id
        and (r.channel_slug = 'influencer' or r.agent_slug = 'influencer')
   );

with closed as (
  update channel_actions
     set status = 'stale',
         status_at = now(),
         note = coalesce(note, 'Influencers removed: UGC Videos covers creator work.')
   where channel_slug = 'influencer'
     and status in ('pending', 'snoozed')
     and exec_status is distinct from 'queued'
     and exec_status is distinct from 'dispatching'
  returning id, tenant_id
)
insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
select tenant_id, id, 'stale_flagged', 'system',
       'Influencers removed: UGC Videos covers creator work.',
       'influencer_removed_20261022:' || id
from closed
on conflict (action_id, event_key) do nothing;

update growth_plan_bets
   set status = 'superseded', updated_at = now()
 where channel_slug = 'influencer'
   and status in ('proposed', 'accepted');

delete from tenant_channels where channel_slug = 'influencer';

delete from tenant_agent_schedules where agent_slug = 'influencer';

delete from tenant_agent_kill_switch where agent_slug = 'influencer';

update agent_reminders
   set status = 'cancelled'
 where agent_slug = 'influencer'
   and status = 'pending';

update agent_runs
   set status = 'cancelled', finished_at = now(), needs_run_end_emit = true
 where status = 'queued'
   and (agent_slug = 'influencer' or channel_slug = 'influencer');

update agent_runs
   set stop_requested = true
 where status = 'running'
   and (agent_slug = 'influencer' or channel_slug = 'influencer')
   and stop_requested is distinct from true;

delete from custom_agent_reserved_names where name_norm in ('influencer', 'influencers');

commit;
