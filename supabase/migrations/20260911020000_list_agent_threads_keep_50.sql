
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
    and ranked.rn > 50;

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

revoke all on function list_agent_threads(text) from public;
grant execute on function list_agent_threads(text) to authenticated;
