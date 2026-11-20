
create index if not exists account_deletions_live_deleted_tenants_gin
  on public.account_deletions using gin (deleted_tenant_ids)
  where status in ('pending', 'soft_deleted', 'held');

create index if not exists tenant_first_run_progress_setup_connectors_idx
  on public.tenant_first_run_progress (setup_connectors_at, tenant_id)
  where setup_connectors_at is not null;
