
create or replace function public.app_active_tenant()
returns uuid
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'active_tenant_id')::uuid,
    (select p.active_tenant_id from public.profiles p where p.user_id = auth.uid())
  );
$$;

revoke all on function public.app_active_tenant() from public;
grant execute on function public.app_active_tenant() to authenticated;

create or replace function _owned_clarify_request(p_request_id uuid)
returns table (thread_id uuid, tenant_id uuid, agent_slug text, envelope jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users
                 where user_id = v_user_id and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  return query
    select t.id, t.tenant_id, t.agent_slug,
           (m.meta->'envelope')
    from agent_thread_messages m
    join agent_threads t on t.id = m.thread_id
    where m.sender_role = 'assistant'
      and m.meta->'envelope'->>'request_id' = p_request_id::text
      and m.meta->'envelope'->>'envelope_kind' = 'clarifying_questions'
      and t.tenant_id = v_tenant_id
      and t.user_id = v_user_id
    limit 1;

  if not found then
    raise exception 'clarification request not found or not owned' using errcode = '42501';
  end if;
end $$;

create or replace function add_agent_note(
  p_agent_slug text,
  p_body text,
  p_scope jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
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

  select app_active_tenant() into v_tenant_id;
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

create or replace function add_agent_rule(
  p_agent_slug text,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
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

  select app_active_tenant() into v_tenant_id;
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

create or replace function delete_agent_thread(p_thread_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_updated int;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users
                 where user_id = v_user_id and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  update agent_threads
    set deleted_at = now()
    where id = p_thread_id
      and user_id = v_user_id
      and tenant_id = v_tenant_id
      and deleted_at is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

create or replace function delete_tenant_command(p_slug text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);
  delete from tenant_commands
   where tenant_id = v_tenant and slug = lower(p_slug);
end $$;

create or replace function demote_admin_to_member(
  p_user_id uuid,
  p_agent_slugs text[]
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role <> 'owner' then
    raise exception 'only owner can demote admins' using errcode = '42501';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member' using errcode = '42704';
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot demote owner' using errcode = '22023';
  end if;
  if v_target_role = 'member' then
    return;
  end if;

  update tenant_users
     set role = 'member'
   where tenant_id = v_tenant and user_id = p_user_id;

  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;

  if p_agent_slugs is not null then
    foreach v_slug in array p_agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_tenant, p_user_id, v_slug, auth.uid())
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;
end $$;

create or replace function get_agent_fleet_graph()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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

  select app_active_tenant() into v_tenant_id;
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

create or replace function get_agent_thread(
  p_agent_slug text,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit int default 200,
  p_thread_id uuid default null
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
set search_path = public, pg_temp
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

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;

  if p_thread_id is not null then
    if not exists (
      select 1 from agent_threads t
      where t.id = p_thread_id
        and t.tenant_id = v_tenant_id
        and t.user_id = v_user_id
        and t.agent_slug = p_agent_slug
    ) then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
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
    and (
      (p_thread_id is not null and te.thread_id = p_thread_id)
      or
      (
        te.thread_id is null
        and exists (
          select 1 from agent_runs r
          where r.id = te.agent_run_id
            and r.tenant_id = v_tenant_id
            and r.trigger in ('cron', 'manual', 'scheduled')
        )
      )
    )
  order by te.created_at desc, te.id desc
  limit v_limit;
end;
$$;

create or replace function get_diagnosis_provenance(
  p_run_id uuid,
  p_query_id text
) returns table (
  run_id       uuid,
  query_id     text,
  source       text,
  window_start timestamptz,
  window_end   timestamptz,
  numerator    numeric,
  denominator  numeric,
  row_count    bigint,
  truncated    boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_member(v_tenant);

  return query
    select p.run_id, p.query_id, p.source, p.window_start, p.window_end,
           p.numerator, p.denominator, p.row_count, p.truncated
      from growth_diagnosis_provenance p
     where p.tenant_id = v_tenant
       and p.run_id = p_run_id
       and p.query_id = p_query_id;
end $$;

create or replace function get_team_member_detail(p_member_id uuid)
returns table (
  id uuid,
  display_name text,
  primary_email text,
  kind text,
  status text,
  identities jsonb
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  return query
  select tm.id, tm.display_name, tm.primary_email, tm.kind, tm.status,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'provider', i.provider,
             'external_id', i.external_id,
             'external_email', i.external_email,
             'external_display_name', i.external_display_name,
             'confidence', i.confidence,
             'source', i.source
           ) order by i.provider)
           from team_member_identities i
           where i.member_id = tm.id
         ), '[]'::jsonb)
    from team_members tm
    where tm.tenant_id = v_tenant and tm.id = p_member_id and tm.status = 'active';
end $$;

create or replace function get_tenant_notification_settings()
returns table (
  notification_email text,
  timezone text,
  digest_frequency text,
  last_sent_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;

  return query
    select t.notification_email,
           t.timezone,
           t.digest_frequency,
           (select max(updated_at) from tenant_brief_dispatches
              where tenant_id = v_tenant
                and surface = 'email'
                and outcome = 'sent') as last_sent_at
      from tenants t
      where t.id = v_tenant;
end $$;

create or replace function invite_member(
  p_email text,
  p_role text,
  p_agent_slugs text[]
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_email_normalized text;
  v_existing_seats int;
  v_open_invites int;
  v_max int;
  v_tier text;
  v_invite_id uuid;
  v_slugs text[];
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  if p_role is null or p_role not in ('admin','member') then
    raise exception 'invalid role %; must be admin or member', p_role using errcode = '22023';
  end if;

  v_email_normalized := lower(trim(coalesce(p_email, '')));
  if v_email_normalized = '' then
    raise exception 'email required' using errcode = '22023';
  end if;

  if p_role = 'admin' then
    v_slugs := array[]::text[];
  else
    v_slugs := coalesce(p_agent_slugs, array[]::text[]);
  end if;

  select tier into v_tier from tenants where id = v_tenant;
  select max_seats into v_max from tenant_seat_limits where tier = coalesce(v_tier, 'pilot');
  if v_max is null then
    raise exception 'no seat limit defined for tier %', v_tier using errcode = '22023';
  end if;
  if v_max >= 0 then
    select count(*) into v_existing_seats from tenant_users where tenant_id = v_tenant;
    select count(*) into v_open_invites from tenant_member_invites
      where tenant_id = v_tenant
        and accepted_at is null
        and revoked_at is null;
    if (v_existing_seats + v_open_invites) >= v_max then
      raise exception 'seat_cap_exceeded — tier % allows % seats (%/% used)',
        v_tier, v_max, v_existing_seats + v_open_invites, v_max
        using errcode = '42501';
    end if;
  end if;

  insert into tenant_member_invites (tenant_id, email, role, invited_by, agent_slugs)
  values (v_tenant, v_email_normalized, p_role, auth.uid(), v_slugs)
  on conflict (tenant_id, lower(email))
    where accepted_at is null and revoked_at is null
  do update set
    role         = excluded.role,
    invited_by   = excluded.invited_by,
    agent_slugs  = excluded.agent_slugs,
    invited_at   = now()
  returning id into v_invite_id;

  return v_invite_id;
end $$;

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
set search_path = public, pg_temp
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

  select app_active_tenant() into v_tenant_id;
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

create or replace function list_agent_threads(p_agent_slug text)
returns table (
  id uuid,
  title text,
  last_message_at timestamptz,
  created_at timestamptz,
  last_message text,
  run_status text,
  pending boolean,
  run_outcome jsonb
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  if not exists (select 1 from tenant_users
                 where user_id = v_user_id and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  with ranked as (
    select t.id,
           row_number() over (order by t.last_message_at desc) as rn
    from agent_threads t
    where t.agent_slug = p_agent_slug
      and t.user_id = v_user_id
      and t.tenant_id = v_tenant_id
      and t.deleted_at is null
  )
  update agent_threads a
  set deleted_at = now()
  from ranked
  where a.id = ranked.id
    and ranked.rn > 12;

  return query
    select
      t.id,
      t.title,
      t.last_message_at,
      t.created_at,
      (
        select left(m.body, 120)
        from agent_thread_messages m
        where m.thread_id = t.id
          and m.tenant_id = v_tenant_id
        order by m.created_at desc
        limit 1
      ) as last_message,
      lr.status as run_status,
      exists (
        select 1
        from agent_thread_messages m
        join decisions d
          on d.agent_run_id = m.agent_run_id
         and d.tenant_id = v_tenant_id
        where m.thread_id = t.id
          and m.tenant_id = v_tenant_id
          and m.agent_run_id is not null
          and d.status = 'proposed'
      ) as pending,
      lr.outcome as run_outcome
    from agent_threads t
    left join lateral (
      select r.status, r.outcome
      from agent_thread_messages m
      join agent_runs r
        on r.id = m.agent_run_id
       and r.tenant_id = v_tenant_id
      where m.thread_id = t.id
        and m.tenant_id = v_tenant_id
        and m.agent_run_id is not null
      order by m.created_at desc, m.id desc
      limit 1
    ) lr on true
    where t.agent_slug = p_agent_slug
      and t.user_id = v_user_id
      and t.tenant_id = v_tenant_id
      and t.deleted_at is null
    order by t.last_message_at desc
    limit 50;
end $$;

create or replace function list_agents_for_tenant()
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

  select app_active_tenant() into v_tenant_id;
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
      and d.autonomy_at_emit = 'approval'
    group by ar.agent_slug
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

create or replace function list_team_members()
returns table (
  id uuid,
  display_name text,
  primary_email text,
  kind text,
  status text,
  identities jsonb,
  ambiguous_count int
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_is_admin boolean;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  select exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
      and role in ('owner','admin')
  ) into v_is_admin;

  return query
  select tm.id, tm.display_name, tm.primary_email, tm.kind, tm.status,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'provider', i.provider,
             'external_id', i.external_id,
             'external_email', case when v_is_admin then i.external_email else null end,
             'external_display_name', i.external_display_name,
             'recent_issue_keys', i.recent_issue_keys,
             'avatar_url', i.avatar_url,
             'confidence', i.confidence,
             'source', i.source
           ) order by i.provider)
           from team_member_identities i
           where i.member_id = tm.id
         ), '[]'::jsonb),
         coalesce((
           select count(*)::int from team_member_identities i
           where i.member_id = tm.id and i.confidence < 1.00 and i.source = 'auto'
         ), 0)
    from team_members tm
    where tm.tenant_id = v_tenant and tm.status = 'active'
    order by tm.display_name;
end $$;

create or replace function list_tenant_commands()
returns setof tenant_commands
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then return; end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    return;
  end if;
  return query
    select * from tenant_commands
    where tenant_id = v_tenant
    order by slug;
end $$;

create or replace function mark_agent_seen(p_agent_slug text)
returns void
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

  select app_active_tenant() into v_tenant_id;
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

create or replace function mark_thread_seen(p_thread_id uuid)
returns void
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

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;

  if not exists (
    select 1 from agent_threads t
    where t.id = p_thread_id
      and t.user_id = v_user_id
      and t.tenant_id = v_tenant_id
  ) then
    raise exception 'thread not owned by caller';
  end if;

  insert into agent_thread_seen_marker (user_id, tenant_id, thread_id, seen_at)
  values (v_user_id, v_tenant_id, p_thread_id, now())
  on conflict (user_id, thread_id)
  do update set seen_at = now();
end;
$$;

create or replace function merge_team_members(p_keep_id uuid, p_drop_id uuid)
returns team_members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_keep team_members;
  v_drop team_members;
begin
  if p_keep_id = p_drop_id then raise exception 'cannot merge member with itself' using errcode = '22023'; end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  perform _assert_tenant_admin(v_tenant);

  select * into v_keep from team_members
   where id = p_keep_id and tenant_id = v_tenant for update;
  if not found or v_keep.status <> 'active' then
    raise exception 'keep member not found or not active' using errcode = '42704';
  end if;
  select * into v_drop from team_members
   where id = p_drop_id and tenant_id = v_tenant for update;
  if not found or v_drop.status <> 'active' then
    raise exception 'drop member not found or not active' using errcode = '42704';
  end if;

  delete from team_member_identities
   where member_id = p_drop_id and tenant_id = v_tenant
     and (provider, external_id) in (
       select provider, external_id from team_member_identities
       where member_id = p_keep_id and tenant_id = v_tenant
     );

  update team_member_identities
     set member_id = p_keep_id, source = 'admin'
   where member_id = p_drop_id and tenant_id = v_tenant;

  update team_members
     set status = 'merged_into', merged_into_id = p_keep_id, updated_at = now()
   where id = p_drop_id and tenant_id = v_tenant;

  update team_members set updated_at = now()
   where id = p_keep_id and tenant_id = v_tenant
   returning * into v_keep;
  return v_keep;
end $$;

create or replace function promote_member_to_admin(p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role <> 'owner' then
    raise exception 'only owner can promote members' using errcode = '42501';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member' using errcode = '42704';
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot promote owner' using errcode = '22023';
  end if;
  if v_target_role = 'admin' then
    return;
  end if;

  update tenant_users
     set role = 'admin'
   where tenant_id = v_tenant and user_id = p_user_id;

  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;
end $$;

create or replace function revoke_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_active_tenant uuid;
  v_invite_tenant uuid;
  v_accepted_at timestamptz;
  v_revoked_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_active_tenant;
  if v_active_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_active_tenant);

  select tenant_id, accepted_at, revoked_at
    into v_invite_tenant, v_accepted_at, v_revoked_at
    from tenant_member_invites where id = p_invite_id;
  if v_invite_tenant is null then
    raise exception 'invite % not found', p_invite_id using errcode = '42704';
  end if;
  if v_invite_tenant <> v_active_tenant then
    raise exception 'invite belongs to a different tenant' using errcode = '42501';
  end if;
  if v_accepted_at is not null then
    raise exception 'invite already accepted; revoke the resulting member via revoke_member' using errcode = '22023';
  end if;
  if v_revoked_at is not null then
    return;
  end if;

  update tenant_member_invites
     set revoked_at = now()
   where id = p_invite_id;
end $$;

create or replace function revoke_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role not in ('owner','admin') then
    raise exception 'forbidden — role % cannot revoke members', v_caller_role using errcode = '42501';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    return;
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot revoke owner' using errcode = '22023';
  end if;
  if v_caller_role = 'admin' and v_target_role = 'admin' then
    raise exception 'admins cannot revoke other admins; only owner can' using errcode = '42501';
  end if;

  delete from tenant_users
   where tenant_id = v_tenant and user_id = p_user_id;
  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;
end $$;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid default null
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if length(coalesce(p_message, '')) = 0 or length(p_message) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id, left(p_message, 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id)
  values
    (v_thread_id, v_tenant_id, 'user', p_message, v_run_id)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_tenant_id uuid
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if p_tenant_id is not null then
    v_tenant_id := p_tenant_id;
  end if;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  if not exists (select 1 from tenant_users
                 where user_id = v_user_id and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if length(coalesce(p_message, '')) = 0 or length(p_message) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id, left(p_message, 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id)
  values
    (v_thread_id, v_tenant_id, 'user', p_message, v_run_id)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

create or replace function send_agent_chat_turn_v2(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_attachments jsonb;
  v_path_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = '' and coalesce(array_length(p_image_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;

  v_path_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_path_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'image attached'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p))
      into v_attachments
      from unnest(p_image_paths) as p;
  else
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[],
  p_tenant_id uuid
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if p_tenant_id is not null then
    v_tenant_id := p_tenant_id;
  end if;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id
       and user_id = v_user_id
       and agent_slug = p_agent_slug
  ) then
    raise exception 'agent % not in member allowlist', p_agent_slug using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;

create or replace function set_member_agents(
  p_user_id uuid,
  p_agent_slugs text[]
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_target_role text;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member of tenant' using errcode = '42704';
  end if;
  if v_target_role <> 'member' then
    raise exception 'cannot set agents for role %; only members have allowlists', v_target_role using errcode = '22023';
  end if;

  delete from tenant_member_agents
   where tenant_id = v_tenant and user_id = p_user_id;

  if p_agent_slugs is not null then
    foreach v_slug in array p_agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_tenant, p_user_id, v_slug, auth.uid())
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;
end $$;

create or replace function submit_ad_snapshot(
  p_provider text,
  p_period_start date,
  p_period_end date,
  p_payload jsonb,
  p_source text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant_id uuid; v_id uuid;
begin
  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant for user' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users where user_id = auth.uid() and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant %', v_tenant_id using errcode = '42501';
  end if;
  if p_provider not in ('google_ads', 'meta_ads', 'tiktok_ads', 'linkedin_ads') then
    raise exception 'unsupported provider %', p_provider using errcode = '22023';
  end if;
  if p_period_start > p_period_end then
    raise exception 'period_start > period_end' using errcode = '22023';
  end if;

  insert into tenant_ad_snapshots (tenant_id, provider, period_start, period_end, payload, source, created_by)
  values (v_tenant_id, p_provider, p_period_start, p_period_end, p_payload, coalesce(p_source, 'manual_paste'), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function trigger_team_discover(
  p_providers text[] default array['github','slack','jira']
)
returns table (job_id uuid, created boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_existing_id uuid;
  v_new_id uuid;
begin
  if p_providers is null or array_length(p_providers, 1) is null then
    raise exception 'providers must be non-empty' using errcode = '22023';
  end if;
  if not (p_providers <@ array['github','slack','jira']::text[]) then
    raise exception 'invalid provider in array' using errcode = '22023';
  end if;

  select app_active_tenant() into v_tenant;
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  perform _assert_tenant_admin(v_tenant);

  select id into v_existing_id from team_discover_jobs
   where tenant_id = v_tenant and status in ('queued','running')
   order by created_at desc limit 1;
  if v_existing_id is not null then
    return query select v_existing_id, false;
    return;
  end if;

  insert into team_discover_jobs (tenant_id, triggered_by, providers)
  values (v_tenant, auth.uid(), p_providers)
  returning id into v_new_id;
  return query select v_new_id, true;
end $$;

create or replace function update_team_member(
  p_member_id uuid,
  p_display_name text default null,
  p_primary_email text default null,
  p_kind text default null
) returns team_members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_row team_members;
  v_email_normalized text;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  perform _assert_tenant_admin(v_tenant);
  if p_kind is not null and p_kind not in ('human','bot','service_account') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  v_email_normalized := nullif(lower(trim(p_primary_email)), '');

  update team_members
     set display_name  = coalesce(nullif(trim(p_display_name), ''), display_name),
         primary_email = coalesce(v_email_normalized, primary_email),
         kind          = coalesce(p_kind, kind),
         updated_at    = now()
   where id = p_member_id and tenant_id = v_tenant
   returning * into v_row;
  if not found then raise exception 'member not found' using errcode = '42704'; end if;
  return v_row;
end $$;

create or replace function update_tenant_notification_settings(
  p_notification_email text,
  p_timezone text,
  p_digest_frequency text
) returns tenants
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_row tenants;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  if p_digest_frequency not in ('off', 'daily') then
    raise exception 'invalid digest_frequency: %, must be off|daily', p_digest_frequency
      using errcode = '22023';
  end if;

  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'invalid timezone: %', p_timezone using errcode = '22023';
  end if;

  update tenants
     set notification_email = nullif(trim(p_notification_email), ''),
         timezone           = p_timezone,
         digest_frequency   = p_digest_frequency
   where id = v_tenant
   returning * into v_row;

  return v_row;
end $$;

create or replace function upsert_device(
  p_expo_push_token text,
  p_platform        text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_id        uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_expo_push_token is null or char_length(p_expo_push_token) < 1
     or char_length(p_expo_push_token) > 512 then
    raise exception 'invalid expo_push_token' using errcode = '22023';
  end if;
  if p_platform not in ('ios', 'android') then
    raise exception 'invalid platform' using errcode = '22023';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  insert into devices (tenant_id, user_id, expo_push_token, platform)
  values (v_tenant_id, v_user_id, p_expo_push_token, p_platform)
  on conflict (user_id, expo_push_token) do update
    set tenant_id = excluded.tenant_id,
        platform  = excluded.platform
  returning id into v_id;

  return v_id;
end $$;

create or replace function upsert_notification_settings(
  p_agent_replies boolean,
  p_approvals     boolean,
  p_daily_brief   boolean
) returns table (agent_replies boolean, approvals boolean, daily_brief boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  insert into notification_settings (
    tenant_id, user_id, agent_replies, approvals, daily_brief
  ) values (
    v_tenant_id, v_user_id,
    coalesce(p_agent_replies, true),
    coalesce(p_approvals, true),
    coalesce(p_daily_brief, false)
  )
  on conflict (tenant_id, user_id) do update set
    agent_replies = coalesce(p_agent_replies, notification_settings.agent_replies),
    approvals     = coalesce(p_approvals,     notification_settings.approvals),
    daily_brief   = coalesce(p_daily_brief,   notification_settings.daily_brief);

  return query
    select ns.agent_replies, ns.approvals, ns.daily_brief
    from notification_settings ns
    where ns.tenant_id = v_tenant_id and ns.user_id = v_user_id;
end $$;

create or replace function upsert_tenant_command(
  p_slug text,
  p_name text,
  p_description text,
  p_instructions_md text
) returns tenant_commands
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_row tenant_commands;
begin
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  insert into tenant_commands (
    tenant_id, slug, name, description, instructions_md, created_by
  )
  values (
    v_tenant,
    lower(p_slug),
    p_name,
    coalesce(p_description, ''),
    coalesce(p_instructions_md, ''),
    auth.uid()
  )
  on conflict (tenant_id, slug) do update
    set name = excluded.name,
        description = excluded.description,
        instructions_md = excluded.instructions_md,
        updated_at = now()
  returning * into v_row;

  return v_row;
end $$;

