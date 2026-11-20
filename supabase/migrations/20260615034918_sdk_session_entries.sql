
create table if not exists public.sdk_session_entries (
  id           bigint generated always as identity primary key,
  tenant_id    uuid        not null,
  thread_id    uuid        not null,
  project_key  text        not null,
  session_key  text        not null,
  position     bigint      not null,
  entry_uuid   text,
  entry        jsonb       not null,
  created_at   timestamptz not null default now()
);

alter table public.sdk_session_entries
  drop constraint if exists sdk_session_entries_thread_fk;
alter table public.sdk_session_entries
  add constraint sdk_session_entries_thread_fk
  foreign key (thread_id) references public.agent_threads(id) on delete cascade;

create unique index if not exists sdk_session_entries_uuid_uq
  on public.sdk_session_entries (tenant_id, thread_id, session_key, entry_uuid)
  where entry_uuid is not null;

create index if not exists sdk_session_entries_load_idx
  on public.sdk_session_entries (tenant_id, thread_id, session_key, position);

alter table public.sdk_session_entries enable row level security;
revoke all on public.sdk_session_entries from anon, authenticated;

create or replace function public.sdk_session_append(
  p_tenant      uuid,
  p_thread      uuid,
  p_project_key text,
  p_session_key text,
  p_entries     jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lock_key bigint;
  v_pos      bigint;
  v_entry    jsonb;
  v_uuid     text;
begin
  if p_tenant is null or p_thread is null or p_session_key is null then
    raise exception 'sdk_session_append: tenant/thread/session_key required';
  end if;
  v_lock_key := hashtextextended(p_tenant::text || '|' || p_thread::text || '|' || p_session_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select coalesce(max(position), 0) into v_pos
    from public.sdk_session_entries
   where tenant_id = p_tenant and thread_id = p_thread and session_key = p_session_key;

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb))
  loop
    v_uuid := nullif(v_entry->>'uuid', '');
    if v_uuid is not null then
      insert into public.sdk_session_entries
        (tenant_id, thread_id, project_key, session_key, position, entry_uuid, entry)
      values (p_tenant, p_thread, p_project_key, p_session_key, v_pos + 1, v_uuid, v_entry)
      on conflict (tenant_id, thread_id, session_key, entry_uuid) where entry_uuid is not null
        do nothing;
      if found then v_pos := v_pos + 1; end if;
    else
      insert into public.sdk_session_entries
        (tenant_id, thread_id, project_key, session_key, position, entry_uuid, entry)
      values (p_tenant, p_thread, p_project_key, p_session_key, v_pos + 1, null, v_entry);
      v_pos := v_pos + 1;
    end if;
  end loop;
end;
$$;

revoke all on function public.sdk_session_append(uuid, uuid, text, text, jsonb) from anon, authenticated;

alter table public.agent_threads
  add column if not exists sdk_session_mirror_degraded_at timestamptz;
