

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
  'Sidebar fan-in for /agents. v3: resolves tenant via profiles.active_tenant_id (deterministic for multi-tenant users) + membership check. Drops run_start/run_end from preview kinds.';

create or replace function get_agent_thread(
  p_agent_slug text,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit int default 200
)
returns table (
  id bigint,
  agent_run_id uuid,
  kind text,
  body jsonb,
  citations jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor must be both-set or both-null';
  end if;

  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
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
  select
    te.id,
    te.agent_run_id,
    te.kind,
    te.body,
    te.citations,
    te.created_at
  from thread_event te
  where te.tenant_id = v_tenant_id
    and te.agent_slug = p_agent_slug
    and (
      p_cursor_created_at is null
      or (te.created_at, te.id) < (p_cursor_created_at, p_cursor_id)
    )
  order by te.created_at desc, te.id desc
  limit v_limit;
end;
$$;

revoke all on function get_agent_thread(text, timestamptz, bigint, int) from public;
grant execute on function get_agent_thread(text, timestamptz, bigint, int) to authenticated;

create or replace function add_agent_rule(
  p_agent_slug text,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;
  if p_body is null or length(p_body) = 0 then
    raise exception 'body required';
  end if;
  if length(p_body) > 500 then
    raise exception 'rule body too long (≤500 chars)';
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

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug, rating, comment,
    created_by, kind, state, scope
  ) values (
    v_tenant_id, null, null, p_agent_slug, null, p_body,
    v_user_id, 'rule', 'open', null
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function add_agent_rule(text, text) from public;
grant execute on function add_agent_rule(text, text) to authenticated;

create or replace function add_agent_note(
  p_agent_slug text,
  p_body text,
  p_scope jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;
  if p_body is null or length(p_body) = 0 then
    raise exception 'body required';
  end if;
  if length(p_body) > 4000 then
    raise exception 'note body too long (≤4000 chars)';
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

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug, rating, comment,
    created_by, kind, state, scope
  ) values (
    v_tenant_id, null, null, p_agent_slug, null, p_body,
    v_user_id, 'note', 'open', p_scope
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function add_agent_note(text, text, jsonb) from public;
grant execute on function add_agent_note(text, text, jsonb) to authenticated;

create or replace function list_agent_feedback(
  p_agent_slug text
)
returns table (
  id uuid,
  kind text,
  state text,
  scope jsonb,
  rating smallint,
  comment text,
  target_type text,
  target_id uuid,
  created_by uuid,
  created_at timestamptz
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
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
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
  select
    af.id,
    af.kind,
    af.state,
    af.scope,
    af.rating,
    af.comment,
    af.target_type,
    af.target_id,
    af.created_by,
    af.created_at
  from agent_feedback af
  where af.tenant_id = v_tenant_id
    and af.agent_slug = p_agent_slug
  order by af.created_at desc;
end;
$$;

revoke all on function list_agent_feedback(text) from public;
grant execute on function list_agent_feedback(text) to authenticated;

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
