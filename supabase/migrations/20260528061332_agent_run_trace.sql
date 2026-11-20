
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-run-traces',
  'agent-run-traces',
  false,
  104857600,
  array[
    'application/x-ndjson',
    'application/jsonl',
    'application/json',
    'text/plain'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists agent_run_traces_deny_anon_select on storage.objects;
create policy agent_run_traces_deny_anon_select on storage.objects
  for select to anon
  using (bucket_id = 'agent-run-traces' and false);

drop policy if exists agent_run_traces_deny_anon_insert on storage.objects;
create policy agent_run_traces_deny_anon_insert on storage.objects
  for insert to anon
  with check (bucket_id = 'agent-run-traces' and false);

drop policy if exists agent_run_traces_deny_authenticated_select on storage.objects;
create policy agent_run_traces_deny_authenticated_select on storage.objects
  for select to authenticated
  using (bucket_id = 'agent-run-traces' and false);

drop policy if exists agent_run_traces_deny_authenticated_insert on storage.objects;
create policy agent_run_traces_deny_authenticated_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'agent-run-traces' and false);

create table if not exists public.agent_run_trace (
  run_id       uuid primary key references public.agent_runs(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  storage_path text not null,
  sha256       text,
  byte_size    integer,
  event_count  integer,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

alter table public.agent_run_trace enable row level security;

create index if not exists agent_run_trace_expires_at on public.agent_run_trace (expires_at);

commit;
