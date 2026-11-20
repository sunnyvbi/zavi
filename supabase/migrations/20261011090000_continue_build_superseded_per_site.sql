
begin;

create or replace function _build_graph_site_id(p_graph jsonb)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select lower(e.node->'payload'->>'site_id')
    from jsonb_array_elements(case when jsonb_typeof(p_graph) = 'array' then p_graph else '[]'::jsonb end)
         with ordinality as e(node, ord)
   where jsonb_typeof(e.node) = 'object'
     and jsonb_typeof(e.node->'payload') = 'object'
     and jsonb_typeof(e.node->'payload'->'site_id') = 'string'
     and (e.node->'payload'->>'site_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   order by e.ord
   limit 1
$$;
revoke all on function _build_graph_site_id(jsonb) from public, anon, authenticated;

create or replace function continue_paused_build(
  p_tenant_id           uuid,
  p_run_id              uuid,
  p_expected_updated_at timestamptz,
  p_goal_graph          jsonb
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id         uuid;
  v_created_at timestamptz;
  v_site_id    text;
begin
  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));
  select me.created_at, _build_graph_site_id(me.goal_graph)
    into v_created_at, v_site_id
    from conductor_runs me
   where me.id = p_run_id
     and me.tenant_id = p_tenant_id;
  if exists (
    select 1 from conductor_runs n
     where n.tenant_id = p_tenant_id
       and n.kind = 'build_app'
       and n.id <> p_run_id
       and n.created_at > v_created_at
       and coalesce(n.goal_graph->0->'payload'->>'refine_mode', '') <> 'true'
       and coalesce(n.objective, '') not like '[refine]%'
       and _build_graph_site_id(n.goal_graph) is not distinct from v_site_id
  ) then
    return 'superseded';
  end if;
  if exists (
    select 1 from conductor_runs
     where tenant_id = p_tenant_id
       and kind = 'build_app'
       and id <> p_run_id
       and status in ('provisioning', 'active')
  ) then
    return 'another_build_running';
  end if;
  update conductor_runs
     set status = 'active', paused_at = null, failure_class = null,
         failure_reason = null, goal_graph = p_goal_graph, updated_at = now()
   where id = p_run_id
     and tenant_id = p_tenant_id
     and kind = 'build_app'
     and (status = 'paused' or (status = 'failed' and paused_at is null
          and coalesce(failure_class, '') not in ('user_cancelled', 'provision_failed', 'coach_precedence')))
     and updated_at = p_expected_updated_at
  returning id into v_id;
  if v_id is null then
    return 'changed_concurrently';
  end if;
  return 'resumed';
end $$;
revoke all on function continue_paused_build(uuid, uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function continue_paused_build(uuid, uuid, timestamptz, jsonb) to service_role;

commit;
