
create or replace function admin_tenant_usage(p_window_days int default 7)
returns table (
  tenant_id uuid,
  runs bigint,
  errors bigint,
  ok_runs bigint,
  cost_usd numeric,
  active_agents bigint,
  user_messages bigint,
  last_active_at timestamptz,
  connectors bigint,
  pending_decisions bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with win as (
    select (now() - make_interval(days => greatest(1, coalesce(p_window_days, 7))))::timestamptz as since
  ),
  runs_agg as (
    select
      r.tenant_id,
      count(*) as runs,
      count(*) filter (
        where r.status in ('dispatch_error', 'parse_failed', 'failed')
      ) as errors,
      count(*) filter (
        where r.status = 'success' and coalesce(r.parse_ok, false)
      ) as ok_runs,
      coalesce(sum(r.cost_usd), 0) as cost_usd,
      count(distinct r.agent_slug) as active_agents,
      max(coalesce(r.finished_at, r.started_at, r.enqueued_at)) as last_run_at
    from agent_runs r, win
    where r.enqueued_at >= win.since
    group by r.tenant_id
  ),
  msg_agg as (
    select
      m.tenant_id,
      count(*) filter (where m.sender_role = 'user') as user_messages,
      max(m.created_at) as last_msg_at
    from agent_thread_messages m, win
    where m.created_at >= win.since
    group by m.tenant_id
  ),
  conn_agg as (
    select c.tenant_id, count(*) as connectors
    from tenant_mcp_servers c
    where c.enabled
    group by c.tenant_id
  ),
  dec_agg as (
    select d.tenant_id, count(*) as pending_decisions
    from decisions d
    where d.status = 'proposed'
    group by d.tenant_id
  )
  select
    t.id as tenant_id,
    coalesce(ra.runs, 0) as runs,
    coalesce(ra.errors, 0) as errors,
    coalesce(ra.ok_runs, 0) as ok_runs,
    coalesce(ra.cost_usd, 0) as cost_usd,
    coalesce(ra.active_agents, 0) as active_agents,
    coalesce(ma.user_messages, 0) as user_messages,
    greatest(ra.last_run_at, ma.last_msg_at) as last_active_at,
    coalesce(ca.connectors, 0) as connectors,
    coalesce(da.pending_decisions, 0) as pending_decisions
  from tenants t
  left join runs_agg ra on ra.tenant_id = t.id
  left join msg_agg ma on ma.tenant_id = t.id
  left join conn_agg ca on ca.tenant_id = t.id
  left join dec_agg da on da.tenant_id = t.id;
$$;

comment on function admin_tenant_usage(int) is
  'Admin-only per-tenant usage rollup for the tenants list. Windowed activity + all-time adoption/attention signals, one row per tenant.';

revoke execute on function admin_tenant_usage(int) from public, anon, authenticated;
grant execute on function admin_tenant_usage(int) to service_role;
