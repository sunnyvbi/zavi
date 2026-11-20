
create table if not exists agent_seen_marker (
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  seen_at    timestamptz not null default now(),
  primary key (user_id, tenant_id, agent_slug)
);
alter table agent_seen_marker enable row level security;
drop policy if exists agent_seen_marker_owner on agent_seen_marker;
create policy agent_seen_marker_owner on agent_seen_marker
  for select using (user_id = auth.uid());

create or replace function mark_agent_seen(p_agent_slug text)
returns void
language plpgsql
security definer
set search_path = public
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

  insert into agent_seen_marker (user_id, tenant_id, agent_slug, seen_at)
  values (v_user_id, v_tenant_id, p_agent_slug, now())
  on conflict (user_id, tenant_id, agent_slug)
  do update set seen_at = now();
end;
$$;

revoke all on function mark_agent_seen(text) from public;
grant execute on function mark_agent_seen(text) to authenticated;

comment on function mark_agent_seen(text) is
  'Marks an agent chat as seen for the calling user in their active tenant. Upsert (user,tenant,slug)->now(). Powers the Claude-style sidebar pill clear.';

drop function if exists list_agents_for_tenant();

create function list_agents_for_tenant()
returns table (
  slug text,
  latest_run_started_at timestamptz,
  latest_run_status text,
  latest_event_preview text,
  pending_decisions_count int,
  has_unseen_pending boolean
)
language plpgsql
security definer
set search_path = public
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
      ar.agent_slug,
      count(*)::int as pending_count,
      bool_or(
        d.emitted_at is null
        or d.emitted_at > coalesce(sm.seen_at, '-infinity'::timestamptz)
      ) as has_unseen
    from decisions d
    join agent_runs ar on ar.id = d.agent_run_id
    left join agent_seen_marker sm
      on sm.user_id = v_user_id
     and sm.tenant_id = v_tenant_id
     and sm.agent_slug = ar.agent_slug
    where d.tenant_id = v_tenant_id
      and d.status = 'proposed'
    group by ar.agent_slug
  )
  select
    pt.agent_slug                        as slug,
    pt.started_at                        as latest_run_started_at,
    pt.status::text                      as latest_run_status,
    coalesce(pt.preview_text, '')::text  as latest_event_preview,
    coalesce(dp.pending_count, 0)        as pending_decisions_count,
    coalesce(dp.has_unseen, false)       as has_unseen_pending
  from preview_text pt
  left join decisions_pending dp on dp.agent_slug = pt.agent_slug
  order by pt.started_at desc nulls last;
end;
$$;

revoke all on function list_agents_for_tenant() from public;
grant execute on function list_agents_for_tenant() to authenticated;

comment on function list_agents_for_tenant() is
  'Sidebar fan-in for /agents. v4: adds has_unseen_pending (proposed decision newer than the caller agent_seen_marker, NULL emitted_at = unseen). v3 tenant resolution + membership check unchanged.';
