
create table agent_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create unique index agent_threads_one_per_user
  on agent_threads (tenant_id, agent_slug, user_id);

create index agent_threads_tenant_agent
  on agent_threads (tenant_id, agent_slug, last_message_at desc);

create table agent_thread_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references agent_threads(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  sender_role text not null check (sender_role in ('user', 'assistant', 'system')),
  body text not null check (length(body) between 1 and 32000),
  agent_run_id uuid references agent_runs(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index agent_thread_messages_thread
  on agent_thread_messages (thread_id, created_at);

create index agent_thread_messages_run
  on agent_thread_messages (agent_run_id) where agent_run_id is not null;

alter table agent_threads enable row level security;
alter table agent_thread_messages enable row level security;

create policy agent_threads_member_select on agent_threads
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = agent_threads.tenant_id)
    and agent_threads.user_id = auth.uid()
  );

create policy agent_thread_messages_member_select on agent_thread_messages
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = agent_thread_messages.tenant_id)
    and exists (select 1 from agent_threads t
                where t.id = agent_thread_messages.thread_id
                  and t.user_id = auth.uid())
  );

alter publication supabase_realtime add table agent_thread_messages;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text
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

  insert into agent_threads (tenant_id, agent_slug, user_id, title)
  values (v_tenant_id, p_agent_slug, v_user_id, left(p_message, 80))
  on conflict (tenant_id, agent_slug, user_id) do update
    set last_message_at = now()
  returning id into v_thread_id;

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
revoke all on function send_agent_chat_turn(text, text, text) from public;
grant execute on function send_agent_chat_turn(text, text, text) to authenticated;

create or replace function record_agent_chat_reply(
  p_thread_id uuid,
  p_tenant_id uuid,
  p_expected_agent_slug text,
  p_run_id uuid,
  p_body text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from agent_threads
                 where id = p_thread_id
                   and tenant_id = p_tenant_id
                   and agent_slug = p_expected_agent_slug) then
    raise exception 'thread/tenant/slug mismatch' using errcode = '42501';
  end if;

  if length(coalesce(p_body, '')) = 0 or length(p_body) > 32000 then
    raise exception 'reply length out of bounds' using errcode = '22023';
  end if;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id)
  values
    (p_thread_id, p_tenant_id, 'assistant', p_body, p_run_id)
  returning id into v_id;

  update agent_threads set last_message_at = now() where id = p_thread_id;
  return v_id;
end $$;
revoke all on function record_agent_chat_reply(uuid, uuid, text, uuid, text) from public;
grant execute on function record_agent_chat_reply(uuid, uuid, text, uuid, text) to service_role;
