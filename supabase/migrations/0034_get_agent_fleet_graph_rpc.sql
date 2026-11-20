
create or replace function get_agent_fleet_graph()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_nodes jsonb;
  v_edges jsonb;
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

  with run_summary as (
    select
      ar.agent_slug,
      max(ar.started_at) as last_run_at,
      count(*)::int      as runs_total
    from agent_runs ar
    where ar.tenant_id = v_tenant_id
      and ar.started_at is not null
    group by ar.agent_slug
  ),
  decisions_pending as (
    select ar.agent_slug, count(*)::int as pending_decisions
    from decisions d
    join agent_runs ar on ar.id = d.agent_run_id
    where d.tenant_id = v_tenant_id
      and d.status = 'proposed'
    group by ar.agent_slug
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug',              rs.agent_slug,
        'last_run_at',       rs.last_run_at,
        'runs_total',        rs.runs_total,
        'pending_decisions', coalesce(dp.pending_decisions, 0)
      )
      order by rs.last_run_at desc nulls last
    ),
    '[]'::jsonb
  )
  into v_nodes
  from run_summary rs
  left join decisions_pending dp on dp.agent_slug = rs.agent_slug;

  with edge_aggregate as (
    select
      dh.source_agent_slug,
      dh.target_agent_slug,
      count(*)::int    as dispatch_count,
      max(dh.created_at) as last_dispatch_at
    from dispatch_history dh
    where dh.tenant_id = v_tenant_id
    group by dh.source_agent_slug, dh.target_agent_slug
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source_slug',      ea.source_agent_slug,
        'target_slug',      ea.target_agent_slug,
        'dispatch_count',   ea.dispatch_count,
        'last_dispatch_at', ea.last_dispatch_at
      )
      order by ea.dispatch_count desc
    ),
    '[]'::jsonb
  )
  into v_edges
  from edge_aggregate ea;

  return jsonb_build_object(
    'nodes', v_nodes,
    'edges', v_edges
  );
end;
$$;

revoke all on function get_agent_fleet_graph() from public;
grant execute on function get_agent_fleet_graph() to authenticated;

comment on function get_agent_fleet_graph() is
  'Fleet org-chart data for /map. Returns {nodes, edges} jsonb. Edges aggregated from dispatch_history. Web layer enriches node slugs with agent registry metadata from /api/agents. Tenant scoped via tenant_users membership.';
