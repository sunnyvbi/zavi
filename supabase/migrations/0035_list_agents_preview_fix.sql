
create or replace function list_agents_for_tenant()
returns table (
  slug text,
  latest_run_started_at timestamptz,
  latest_run_status text,
  latest_event_preview text,
  pending_decisions_count int
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

  select tu.tenant_id into v_tenant_id
  from tenant_users tu
  where tu.user_id = v_user_id
  limit 1;
  if v_tenant_id is null then
    raise exception 'unauthorized';
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
    select ar.agent_slug, count(*)::int as pending_count
    from decisions d
    join agent_runs ar on ar.id = d.agent_run_id
    where d.tenant_id = v_tenant_id
      and d.status = 'proposed'
    group by ar.agent_slug
  )
  select
    pt.agent_slug                        as slug,
    pt.started_at                        as latest_run_started_at,
    pt.status::text                      as latest_run_status,
    coalesce(pt.preview_text, '')::text  as latest_event_preview,
    coalesce(dp.pending_count, 0)        as pending_decisions_count
  from preview_text pt
  left join decisions_pending dp on dp.agent_slug = pt.agent_slug
  order by pt.started_at desc nulls last;
end;
$$;

revoke all on function list_agents_for_tenant() from public;
grant execute on function list_agents_for_tenant() to authenticated;

comment on function list_agents_for_tenant() is
  'Sidebar fan-in for /agents. v2: skips lifecycle-marker kinds (run_start/run_end) when picking preview text since those bodies have no human-readable field. Recency-sorted, includes pending-decision count. Tenant scoped via tenant_users membership of auth.uid().';
