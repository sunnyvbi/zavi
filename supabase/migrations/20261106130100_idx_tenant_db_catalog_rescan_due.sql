begin;
set local lock_timeout = '5s';
create index if not exists tenant_db_catalog_rescan_due_idx
  on public.tenant_db_catalog (rescan_retry_at) where rescan_retry_at is not null;
commit;
