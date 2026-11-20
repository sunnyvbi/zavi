
begin;

create or replace view public.customer_visible_open_channel_actions
with (security_invoker = true) as
  select a.*
  from public.channel_actions a
  where (
    a.status = 'pending'
    or (a.status = 'snoozed' and (a.snoozed_until is null or a.snoozed_until <= now()))
  );

comment on view public.customer_visible_open_channel_actions is
  'Single source of truth for "a channel action the founder still needs to see": pending, or snoozed past its date. Every customer-facing count reads THIS, never a hand-rolled status filter. Mirrors isOpenAction in services/channels/rank-actions.ts.';

grant select on public.customer_visible_open_channel_actions to authenticated, service_role;

drop function if exists list_agents_for_tenant();

create function list_agents_for_tenant()
returns table (
  slug text,
  latest_run_started_at timestamptz,
  latest_run_status text,
  latest_event_preview text,
  pending_decisions_count int,
  has_unseen_pending boolean,
  unseen_thread_count int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  select active_tenant_id into v_tenant_id
  from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;

  return query
  with run_recency as (
    select distinct on (ar.agent_slug)
      ar.agent_slug,
      ar.id        as run_id,
      ar.started_at,
      ar.status
    from agent_runs ar
    where ar.tenant_id = v_tenant_id
      and ar.started_at is not null
    order by ar.agent_slug, ar.started_at desc
  ),
  preview_text as (
    select
      rr.agent_slug,
      rr.run_id,
      rr.started_at,
      rr.status,
      lat.preview_text
    from run_recency rr
    left join lateral (
      select coalesce(
        te.body->>'text',
        te.body->>'tool_name',
        te.body->>'title',
        te.body->>'path',
        ''
      ) as preview_text
      from thread_event te
      where te.agent_run_id = rr.run_id
        and te.kind in (
          'reasoning',
          'tool_call',
          'decision',
          'file_read',
          'file_edit',
          'file_create'
        )
      order by te.created_at desc, te.id desc
      limit 1
    ) lat on true
  ),
  decisions_pending as (
    select
      p.agent_slug,
      count(*)::int as pending_count,
      bool_or(p.unseen) as has_unseen
    from (
      select
        ar.agent_slug,
        (
          d.emitted_at is null
          or d.emitted_at > coalesce(sm.seen_at, '-infinity'::timestamptz)
        ) as unseen
      from customer_visible_pending_decisions d
      join agent_runs ar on ar.id = d.agent_run_id
      left join agent_seen_marker sm
        on sm.user_id = v_user_id
       and sm.tenant_id = v_tenant_id
       and sm.agent_slug = ar.agent_slug
      where d.tenant_id = v_tenant_id

      union all

      select
        ar.agent_slug,
        (a.proposed_at > coalesce(sm.seen_at, '-infinity'::timestamptz)) as unseen
      from customer_visible_open_channel_actions a
      join agent_runs ar on ar.id = a.run_id
      left join agent_seen_marker sm
        on sm.user_id = v_user_id
       and sm.tenant_id = v_tenant_id
       and sm.agent_slug = ar.agent_slug
      where a.tenant_id = v_tenant_id
    ) p
    group by p.agent_slug
  ),
  unseen_threads as (
    select t.agent_slug, count(*)::int as unseen_thread_count
    from agent_threads t
    where t.tenant_id = v_tenant_id
      and t.user_id = v_user_id
      and t.deleted_at is null
      and exists (
        select 1
        from agent_thread_messages m
        left join agent_thread_seen_marker tsm
          on tsm.user_id = v_user_id
         and tsm.thread_id = t.id
        where m.thread_id = t.id
          and m.tenant_id = v_tenant_id
          and m.sender_role = 'assistant'
          and m.created_at > coalesce(tsm.seen_at, '-infinity'::timestamptz)
      )
    group by t.agent_slug
  )
  select
    pt.agent_slug                        as slug,
    pt.started_at                        as latest_run_started_at,
    pt.status::text                      as latest_run_status,
    coalesce(pt.preview_text, '')::text  as latest_event_preview,
    coalesce(dp.pending_count, 0)        as pending_decisions_count,
    coalesce(dp.has_unseen, false)       as has_unseen_pending,
    coalesce(ut.unseen_thread_count, 0)  as unseen_thread_count
  from preview_text pt
  left join decisions_pending dp on dp.agent_slug = pt.agent_slug
  left join unseen_threads ut on ut.agent_slug = pt.agent_slug
  order by pt.started_at desc nulls last;
end;
$$;

revoke all on function list_agents_for_tenant() from public;
grant execute on function list_agents_for_tenant() to authenticated;

comment on function list_agents_for_tenant() is
  'Sidebar fan-in for /agents. v8: pending_decisions_count and has_unseen_pending count BOTH stores — customer_visible_pending_decisions and customer_visible_open_channel_actions — so a channel switched to channel_actions keeps its badge; v7 snooze-awareness, v6 approval-gating and v5 unseen_thread_count unchanged.';

commit;
