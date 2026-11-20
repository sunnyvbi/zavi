
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-artifacts',
  'agent-artifacts',
  false,
  26214400,
  array[
    'application/pdf',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists agent_artifacts_deny_anon_select on storage.objects;
create policy agent_artifacts_deny_anon_select on storage.objects
  for select to anon
  using (bucket_id = 'agent-artifacts' and false);

drop policy if exists agent_artifacts_deny_anon_insert on storage.objects;
create policy agent_artifacts_deny_anon_insert on storage.objects
  for insert to anon
  with check (bucket_id = 'agent-artifacts' and false);

drop policy if exists agent_artifacts_deny_authenticated_select on storage.objects;
create policy agent_artifacts_deny_authenticated_select on storage.objects
  for select to authenticated
  using (bucket_id = 'agent-artifacts' and false);

drop policy if exists agent_artifacts_deny_authenticated_insert on storage.objects;
create policy agent_artifacts_deny_authenticated_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'agent-artifacts' and false);

create table if not exists public.run_artifacts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  run_id       uuid not null,
  storage_path text not null,
  filename     text not null,
  mime         text not null,
  bytes        integer not null,
  created_at   timestamptz not null default now(),
  unique (tenant_id, run_id, filename)
);

alter table public.run_artifacts enable row level security;

drop policy if exists run_artifacts_tenant_select on public.run_artifacts;
create policy run_artifacts_tenant_select on public.run_artifacts
  for select to authenticated
  using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = run_artifacts.tenant_id
    )
  );

commit;
