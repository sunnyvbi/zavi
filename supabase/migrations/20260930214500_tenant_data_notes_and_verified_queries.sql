
begin;

create table if not exists public.tenant_data_notes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  metric_id      text check (metric_id is null or char_length(metric_id) between 1 and 64),
  note_text      text not null check (char_length(btrim(note_text)) between 1 and 1000),
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  active         boolean not null default true,
  deactivated_at timestamptz,
  deactivated_by uuid references auth.users(id) on delete set null
);

alter table public.tenant_data_notes enable row level security;

create policy tenant_data_notes_member_select on public.tenant_data_notes
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_data_notes.tenant_id
    )
  );
create policy tenant_data_notes_active_tenant_restrict
  on public.tenant_data_notes as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.tenant_data_notes from public, anon;
revoke insert, update, delete, truncate on public.tenant_data_notes from authenticated;
grant select on public.tenant_data_notes to authenticated;

create table if not exists public.tenant_verified_queries (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  question           text not null check (char_length(btrim(question)) between 1 and 500),
  sql_reads          text[] not null check (
                       cardinality(sql_reads) between 1 and 8
                       and char_length(array_to_string(sql_reads, '')) <= 40000
                     ),
  question_embedding real[] check (question_embedding is null or cardinality(question_embedding) = 1024),
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  active             boolean not null default true
);

alter table public.tenant_verified_queries enable row level security;

create policy tenant_verified_queries_member_select on public.tenant_verified_queries
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_verified_queries.tenant_id
    )
  );
create policy tenant_verified_queries_active_tenant_restrict
  on public.tenant_verified_queries as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.tenant_verified_queries from public, anon;
revoke insert, update, delete, truncate on public.tenant_verified_queries from authenticated;
grant select on public.tenant_verified_queries to authenticated;

commit;
