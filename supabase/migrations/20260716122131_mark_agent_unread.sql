
create or replace function mark_agent_unread(p_agent_slug text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_thread_id uuid;
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

  select t.id into v_thread_id
  from agent_threads t
  join lateral (
    select max(m.created_at) as last_assistant_at
    from agent_thread_messages m
    where m.thread_id = t.id
      and m.tenant_id = v_tenant_id
      and m.sender_role = 'assistant'
  ) lm on lm.last_assistant_at is not null
  where t.tenant_id = v_tenant_id
    and t.user_id = v_user_id
    and t.agent_slug = p_agent_slug
    and t.deleted_at is null
  order by lm.last_assistant_at desc
  limit 1;

  if v_thread_id is null then
    return false;
  end if;

  delete from agent_thread_seen_marker
  where user_id = v_user_id and thread_id = v_thread_id;

  return true;
end;
$$;

revoke all on function mark_agent_unread(text) from public;
grant execute on function mark_agent_unread(text) to authenticated;

comment on function mark_agent_unread(text) is
  'Marks the calling user''s most recent assistant-replied thread of an agent as unread (deletes its agent_thread_seen_marker). Inverse of mark_thread_seen; powers the sidebar "Mark as unread" menu item. Returns false when no eligible thread exists.';
