
create or replace function public.admin_action_counts(
  p_scope text default 'real',
  p_days  int  default 30
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scope_tenants as (
    select t.id
    from public.tenants t
    where case coalesce(p_scope, 'real')
      when 'all'  then true
      when 'test' then not (coalesce(t.kind, 'real') = 'real'
                            and t.slug not in ('upcar-ai', 'upcar-private', 'apna-tutor-dogfood'))
      else              coalesce(t.kind, 'real') = 'real'
                            and t.slug not in ('upcar-ai', 'upcar-private', 'apna-tutor-dogfood')
    end
  ),
  videos as (
    select distinct on (case when v.kind = 'launch_video' then v.run_id::text else v.id::text end)
           v.tenant_id, v.created_at, v.kind
    from (
      select f.id, f.run_id, f.tenant_id, f.created_at,
             case
               when f.filename ~ '^(talking_head|cinematic|social)-[0-9a-f]{8}\.mp4$'
                 then split_part(f.filename, '-', 1)
               when f.agent_slug = 'launch-video-public'
                 or f.filename ~ '^video(-[A-Za-z0-9_]+)*-[0-9]+x[0-9]+\.mp4$'
                 then 'launch_video'
               else 'other'
             end as kind
      from public.run_artifacts f
      where f.mime like 'video/%'
        and (f.agent_slug is distinct from 'launch-video-public' or f.filename = 'hd.mp4')
    ) v
    order by case when v.kind = 'launch_video' then v.run_id::text else v.id::text end, v.created_at
  ),
  ev as (
    select r.tenant_id, r.enqueued_at as occurred_at, 'channels' as grp, 'channel.run' as action,
           r.channel_slug as dim
    from public.agent_runs r
    where r.channel_slug is not null
      and r.agent_definition_hash is distinct from 'seed-synthetic'

    union all
    select r.tenant_id, r.enqueued_at, 'agents',
           case when r.trigger in ('chat', 'slack', 'teams', 'email', 'mcp', 'manual', 'telegram',
                                   'discord', 'whatsapp', 'playbook')
                then 'agent.run_person' else 'agent.run_auto' end,
           r.agent_slug
    from public.agent_runs r
    where r.channel_slug is null
      and r.agent_definition_hash is distinct from 'seed-synthetic'

    union all
    select a.tenant_id, a.proposed_at, 'channel_actions', 'channel_action.proposed', a.action_type
    from public.channel_actions a

    union all
    select d.tenant_id, d.emitted_at, 'channel_actions', 'channel_action.proposed', 'legacy'
    from public.decisions d
    where d.decision_class = 'channel.recipe_step'

    union all
    select e.tenant_id, e.at, 'founder', 'founder.' || e.event, a.channel_slug
    from public.channel_action_events e
    join public.channel_actions a on a.id = e.action_id
    where e.actor_kind = 'founder'
      and e.event in ('acted', 'approved', 'rejected', 'snoozed', 'redo_requested')

    union all
    select d.tenant_id, coalesce(d.approved_at, d.emitted_at), 'founder', 'decision.approved',
           split_part(d.decision_class, '.', 1)
    from public.decisions d
    where d.status in ('approved', 'acted')
      and d.decision_class <> 'channel.recipe_step'
    union all
    select d.tenant_id, coalesce(d.rejected_at, d.emitted_at), 'founder', 'decision.rejected',
           split_part(d.decision_class, '.', 1)
    from public.decisions d
    where d.status = 'rejected'
      and d.decision_class <> 'channel.recipe_step'

    union all
    select p.tenant_id,
           coalesce((select min(a.created_at)
                     from public.social_publish_attempts a
                     where a.post_id = p.id and a.status = 'succeeded'),
                    p.created_at),
           'published', 'published.social_post', p.channel
    from public.social_posts p
    where p.status = 'published'
    union all
    select a.tenant_id, a.executed_at, 'published', 'published.action_executed', a.channel_slug
    from public.channel_actions a
    where a.exec_status = 'executed'

    union all
    select f.tenant_id, f.created_at, 'media', 'media.image',
           case when f.render_input ->> 'prompt' is not null then 'ai_image' else 'text_panel' end
    from public.run_artifacts f
    where f.mime like 'image/%'
      and f.render_input ? 'prompt'

    union all
    select v.tenant_id, v.created_at, 'media', 'media.video', v.kind
    from videos v

    union all
    select f.tenant_id, f.created_at, 'documents',
           case
             when f.mime = 'application/pdf' then 'doc.pdf'
             when f.mime = 'text/html' then 'doc.html'
             when f.mime = 'application/vnd.zavi.ui+json' then 'doc.dashboard'
             else 'doc.spreadsheet'
           end,
           case
             when f.mime <> 'application/pdf' then null
             when f.render_input ? 'sections' then 'report'
             when exists (
               select 1 from public.agent_run_events e
               where e.agent_run_id = f.run_id
                 and e.stage = 'tool_use_completed'
                 and e.meta ->> 'tool_name' like '%render\_deck'
             ) then 'deck'
             else 'other'
           end
    from public.run_artifacts f
    where f.mime in ('application/pdf', 'text/html', 'application/vnd.zavi.ui+json', 'text/csv',
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      and exists (select 1 from public.agent_runs r where r.id = f.run_id)

    union all
    select e.tenant_id, e.created_at, 'prototypes', 'proto.wireframe', null
    from (select distinct l.run_id from public.engineer_prototype_links l) l
    join public.agent_run_events e on e.agent_run_id = l.run_id
    where e.stage = 'tool_use_completed'
      and e.meta ->> 'tool_name' like '%render\_wireframe'

    union all
    select h.tenant_id, h.created_at, 'prototypes', 'proto.html_preview', null
    from public.engineer_html_preview_artifacts h
    where h.status = 'html_preview_ready'

    union all
    select s.tenant_id, s.created_at, 'prototypes', 'proto.shared_page', null
    from public.shared_pages s

    union all
    select m.tenant_id, m.created_at, 'chat', 'chat.message', null
    from public.agent_thread_messages m
    where m.sender_role = 'user'
  ),
  scoped as (
    select ev.*
    from ev
    join scope_tenants s on s.id = ev.tenant_id
    where ev.occurred_at is not null
  ),
  agg as (
    select
      case when grouping(action) = 1 then 'group'
           when grouping(dim) = 1    then 'action'
           else 'dim' end                                                as level,
      grp, action, dim,
      count(*)                                                           as total,
      count(*) filter (where occurred_at >= now() - interval '30 days') as d30,
      count(*) filter (where occurred_at >= now() - interval '7 days')  as d7,
      count(*) filter (where occurred_at >= now() - interval '1 day')   as d1,
      count(distinct tenant_id)                                          as tenants
    from scoped
    group by grouping sets ((grp), (grp, action), (grp, action, dim))
  ),
  daily as (
    select (occurred_at at time zone 'utc')::date as day, grp, count(*) as n
    from scoped
    where occurred_at >= (((now() at time zone 'utc')::date
                           - (greatest(1, least(coalesce(p_days, 30), 365)) - 1))::timestamp
                          at time zone 'utc')
    group by 1, 2
  )
  select jsonb_build_object(
    'tenants_in_scope', (select count(*) from scope_tenants),
    'counts', coalesce((select jsonb_agg(to_jsonb(agg)) from agg
                        where not (level = 'dim' and dim is null)), '[]'::jsonb),
    'daily',  coalesce((select jsonb_agg(to_jsonb(daily) order by day, grp) from daily), '[]'::jsonb)
  );
$$;

comment on function public.admin_action_counts(text, int) is
  'Admin-only aggregate action counts across tenants (Action tracker). Derived at read time from source tables; emits machine keys only. Cross-tenant staff read; service_role only.';

revoke execute on function public.admin_action_counts(text, int) from public, anon, authenticated;
grant execute on function public.admin_action_counts(text, int) to service_role;
