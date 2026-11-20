begin;
set lock_timeout = '5s';

alter table public.decisions
  add column if not exists home text check (home in ('channel', 'growth', 'needs_you')),
  add column if not exists home_channel text;

comment on column public.decisions.home is
  'Where this decision lives: its channel tile, the Growth page or the Needs you tab. Stamped by trigger (decisions_stamp_home) from decision_home_of; never written by a client.';
comment on column public.decisions.home_channel is
  'The registry channel slug when home = ''channel'', else null. Stamped by trigger.';

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
    select case when ch = any (array['meta_ads', 'google_ads', 'youtube_ads', 'tiktok_ads', 'linkedin_ads', 'reddit_ads', 'x_ads', 'chatgpt_ads', 'seo', 'geo', 'blog', 'linkedin_organic', 'reddit_organic', 'x_organic', 'instagram_organic', 'tiktok_organic', 'pinterest_organic', 'ugc', 'generated_video', 'influencer', 'youtube_organic', 'email_marketing', 'sms']::text[]) then ch end as ch from resolved
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

create or replace function public.decisions_stamp_home() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_channel text;
  v_enqueued_by uuid;
  v_site_pr_class text;
begin
  if new.agent_run_id is not null then
    select ar.channel_slug, ar.enqueued_by, ar.payload->'site_pr_card'->>'exec_class'
      into v_channel, v_enqueued_by, v_site_pr_class
      from public.agent_runs ar
     where ar.id = new.agent_run_id and ar.tenant_id = new.tenant_id;
  end if;
  select h.home, h.home_channel into new.home, new.home_channel
    from public.decision_home_of(new.decision_class, v_channel, v_enqueued_by, v_site_pr_class,
                                 new.body->>'brief_kind', new.body->>'channel') h;
  return new;
end $$;
revoke all on function public.decisions_stamp_home() from public, anon, authenticated;

drop trigger if exists decisions_stamp_home_ins on public.decisions;
create trigger decisions_stamp_home_ins before insert on public.decisions
  for each row execute function public.decisions_stamp_home();
drop trigger if exists decisions_stamp_home_upd on public.decisions;
create trigger decisions_stamp_home_upd
  before update of decision_class, agent_run_id, body, home, home_channel on public.decisions
  for each row execute function public.decisions_stamp_home();

create or replace function public.agent_runs_restamp_decision_home() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.decisions d
     set home = null
   where d.agent_run_id = new.id and d.tenant_id = new.tenant_id and d.status = 'proposed';
  return new;
end $$;
revoke all on function public.agent_runs_restamp_decision_home() from public, anon, authenticated;
drop trigger if exists agent_runs_restamp_decision_home on public.agent_runs;
create trigger agent_runs_restamp_decision_home after update of channel_slug on public.agent_runs
  for each row when (old.channel_slug is distinct from new.channel_slug)
  execute function public.agent_runs_restamp_decision_home();

update public.decisions set home = null where home is null;

create index if not exists decisions_tenant_home_recency
  on public.decisions (tenant_id, home, emitted_at desc, id desc)
  where status = 'proposed' and autonomy_at_emit = 'approval';

create or replace view public.customer_visible_pending_decisions
with (security_invoker = true) as
  select d.*
  from public.decisions d
  where d.status = 'proposed'
    and d.autonomy_at_emit = 'approval'
    and (d.snoozed_until is null or d.snoozed_until <= now())
    and d.decision_class <> all (array['cgo.dispatch-specialist']);

commit;
