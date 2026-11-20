
drop function if exists get_agent_thread(text, timestamptz, bigint, int);

create or replace function get_agent_thread(
  p_agent_slug text,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null,
  p_limit int default 200,
  p_broadcasts_only boolean default false
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
    and (
      not coalesce(p_broadcasts_only, false)
      or te.kind <> 'chat_assistant'
      or not exists (
        select 1 from agent_runs r
        where r.id = te.agent_run_id
          and r.tenant_id = v_tenant_id
          and r.trigger = 'chat'
      )
    )
  order by te.created_at desc, te.id desc
  limit v_limit;
end;
$$;

revoke all on function get_agent_thread(text, timestamptz, bigint, int, boolean) from public;
grant execute on function get_agent_thread(text, timestamptz, bigint, int, boolean) to authenticated;

comment on function get_agent_thread(text, timestamptz, bigint, int, boolean) is
  'Reverse-chronological thread_event scan for an agent (tenant-scoped). 0072: adds opt-in p_broadcasts_only (default false). When true, excludes chat-trigger chat_assistant rows so per-thread/per-user chat history cannot leak into another thread via the tenant-wide event stream; cron/manual broadcasts, decisions, and tool/file rows still pass. 4-arg signature dropped to avoid PostgREST overload ambiguity.';
