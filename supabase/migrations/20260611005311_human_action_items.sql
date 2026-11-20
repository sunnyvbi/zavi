
create table if not exists human_action_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  title        text not null,
  detail       text not null default '',
  priority     text not null default 'P1' check (priority in ('P0','P1','P2')),
  source       text not null default 'curated' check (source in ('curated','decision','digest')),
  source_ref   text,
  status       text not null default 'open' check (status in ('open','snoozed','done')),
  snooze_until timestamptz,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);

create index if not exists human_action_items_tenant_status_idx
  on human_action_items (tenant_id, status, priority, created_at);

alter table human_action_items enable row level security;
drop policy if exists human_action_items_select on human_action_items;
create policy human_action_items_select on human_action_items
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = human_action_items.tenant_id)
  );
