
alter table agent_threads
  alter column user_id drop not null;

alter table agent_threads
  add column if not exists synthetic boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_threads_synthetic_user_xor'
      and conrelid = 'agent_threads'::regclass
  ) then
    alter table agent_threads
      add constraint agent_threads_synthetic_user_xor
      check ((synthetic and user_id is null) or (not synthetic and user_id is not null));
  end if;
end $$;

create unique index if not exists agent_threads_synthetic_per_agent
  on agent_threads (tenant_id, agent_slug)
  where synthetic = true;

create index if not exists agent_threads_synthetic_age
  on agent_threads (last_message_at)
  where synthetic = true;

drop policy if exists agent_threads_synthetic_tenant_select on agent_threads;
create policy agent_threads_synthetic_tenant_select on agent_threads
  for select using (
    synthetic = true
    and exists (select 1 from tenant_users tu
                where tu.user_id = auth.uid()
                  and tu.tenant_id = agent_threads.tenant_id)
  );

drop policy if exists agent_thread_messages_synthetic_tenant_select on agent_thread_messages;
create policy agent_thread_messages_synthetic_tenant_select on agent_thread_messages
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid()
              and tu.tenant_id = agent_thread_messages.tenant_id)
    and exists (select 1 from agent_threads t
                where t.id = agent_thread_messages.thread_id
                  and t.synthetic = true)
  );

comment on column agent_threads.synthetic is
  'R9: true for the single per-(tenant, agent_slug) cron-summary thread '
  'created on first cron-run write. Client-side-merged into per-user threads.';

create or replace function get_or_create_synthetic_cron_thread(
  p_tenant_id uuid,
  p_agent_slug text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from agent_threads
  where tenant_id = p_tenant_id
    and agent_slug = p_agent_slug
    and synthetic = true;

  if v_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, synthetic, title)
    values (p_tenant_id, p_agent_slug, null, true,
            'Cron runs: ' || p_agent_slug)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from agent_threads
      where tenant_id = p_tenant_id
        and agent_slug = p_agent_slug
        and synthetic = true;
    end if;
  end if;

  return v_id;
end $$;

revoke all on function get_or_create_synthetic_cron_thread(uuid, text) from public;
grant execute on function get_or_create_synthetic_cron_thread(uuid, text) to service_role;
