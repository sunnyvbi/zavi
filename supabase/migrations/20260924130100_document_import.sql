
begin;

alter table tenant_document drop constraint if exists tenant_document_status_check;
alter table tenant_document
  add constraint tenant_document_status_check check (status in ('approved', 'archived', 'imported'));
alter table tenant_document add column if not exists extraction jsonb;

drop policy if exists tenant_document_member_select on tenant_document;
create policy tenant_document_member_select on tenant_document
  for select
  using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = tenant_document.tenant_id
        and tu.user_id = auth.uid()
        and (tenant_document.status <> 'imported' or tu.role in ('owner', 'admin'))
    )
  );

drop policy if exists tenant_documents_member_select on storage.objects;
create policy tenant_documents_member_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-documents'
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id::text = (storage.foldername(name))[1]
        and (
          tu.role in ('owner', 'admin')
          or exists (
            select 1 from tenant_document d
            where d.storage_path = storage.objects.name
              and d.tenant_id = tu.tenant_id
              and d.status <> 'imported'
          )
        )
    )
  );

alter table memory_note drop constraint if exists memory_note_source_check;
alter table memory_note add constraint memory_note_source_check check (
  source in (
    'human','agent_run','slack_distill','email_distill','operator_feedback',
    'praxis_staff','auto_distill_chat','auto_distill_agent_run','auto_distill_slack',
    'dream_cycle_merge','agent_write','gap_distill','episode_distill',
    'external_learning_distill','meeting_distill','memory_card_distill',
    'agent_discovery_verified','agent_discovery_inferred',
    'document_import'
  )
);

commit;
