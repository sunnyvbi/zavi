
alter table public.dispatch_history
  add column if not exists lineage_key text;

create index if not exists dispatch_history_lineage_lookup
  on public.dispatch_history (tenant_id, lineage_key, created_at desc)
  where lineage_key is not null;
