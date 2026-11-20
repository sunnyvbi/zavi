
begin;

create table if not exists tenant_document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 255),
  mime text not null default 'application/octet-stream',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  storage_path text not null,
  status text not null default 'approved' check (status in ('approved', 'archived')),
  version int not null default 1,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_document_tenant_status
  on tenant_document (tenant_id, status, updated_at desc);

alter table tenant_document enable row level security;

drop policy if exists tenant_document_member_select on tenant_document;
create policy tenant_document_member_select on tenant_document
  for select
  using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = tenant_document.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on tenant_document from anon, authenticated;
grant select on tenant_document to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('tenant-documents', 'tenant-documents', false, 26214400)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

drop policy if exists tenant_documents_member_select on storage.objects;
create policy tenant_documents_member_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-documents'
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists tenant_documents_deny_anon_select on storage.objects;
create policy tenant_documents_deny_anon_select on storage.objects
  for select to anon
  using (bucket_id = 'tenant-documents' and false);

drop policy if exists tenant_documents_deny_insert on storage.objects;
create policy tenant_documents_deny_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'tenant-documents' and false);

drop policy if exists tenant_documents_deny_update on storage.objects;
create policy tenant_documents_deny_update on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'tenant-documents' and false);

drop policy if exists tenant_documents_deny_delete on storage.objects;
create policy tenant_documents_deny_delete on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'tenant-documents' and false);

commit;
