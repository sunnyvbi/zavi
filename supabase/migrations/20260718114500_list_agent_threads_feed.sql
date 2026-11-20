
create or replace function list_agent_threads_feed(
  p_agent_slug text,
  p_limit int default 50,
  p_before timestamptz default null
)
returns table (
  id uuid,
  title text,
  last_message_at timestamptz,
  created_at timestamptz,
  last_message text,
  run_status text,
  pending boolean,
  run_outcome jsonb,
  reply_count int,
  first_user_message text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_lim int;
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

  v_lim := least(greatest(coalesce(p_limit, 50), 1), 200);

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
      lr.outcome as run_outcome,
      greatest(mc.total - case when fm.id is null then 0 else 1 end, 0)::int as reply_count,
      fm.body as first_user_message
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
    left join lateral (
      select m.id, m.body
      from agent_thread_messages m
      where m.thread_id = t.id
        and m.tenant_id = v_tenant_id
        and m.sender_role = 'user'
      order by m.created_at asc, m.id asc
      limit 1
    ) fm on true
    left join lateral (
      select count(*)::int as total
      from agent_thread_messages m
      where m.thread_id = t.id
        and m.tenant_id = v_tenant_id
    ) mc on true
    where t.agent_slug = p_agent_slug
      and t.user_id = v_user_id
      and t.tenant_id = v_tenant_id
      and t.deleted_at is null
      and (p_before is null or t.last_message_at < p_before)
    order by t.last_message_at desc, t.id desc
    limit v_lim;
end $$;

revoke all on function public.list_agent_threads_feed(text, int, timestamptz) from public;
grant execute on function public.list_agent_threads_feed(text, int, timestamptz) to authenticated;
