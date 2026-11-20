
begin;

alter table agent_threads
  add column if not exists deleted_at timestamptz;

create index if not exists agent_threads_user_alive
  on agent_threads (tenant_id, agent_slug, user_id, last_message_at desc)
  where deleted_at is null;

create or replace function list_agent_threads(p_agent_slug text)
returns table (id uuid, title text, last_message_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  if not exists (select 1 from tenant_users
                 where user_id = v_user_id and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  return query
    select t.id, t.title, t.last_message_at, t.created_at
    from agent_threads t
    where t.agent_slug = p_agent_slug
      and t.user_id = v_user_id
      and t.tenant_id = v_tenant_id
      and t.deleted_at is null
    order by t.last_message_at desc
    limit 50;
end $$;
revoke all on function list_agent_threads(text) from public;
grant execute on function list_agent_threads(text) to authenticated;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid default null
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public as $$
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

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
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
revoke all on function send_agent_chat_turn(text, text, text, uuid) from public;
grant execute on function send_agent_chat_turn(text, text, text, uuid) to authenticated;

create or replace function delete_agent_thread(p_thread_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_updated int;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
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
revoke all on function delete_agent_thread(uuid) from public;
grant execute on function delete_agent_thread(uuid) to authenticated;

commit;
