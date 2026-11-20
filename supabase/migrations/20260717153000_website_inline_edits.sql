
begin;

create table if not exists website_edits (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  app_id     text not null,
  selector   text not null,
  patch      jsonb not null default '{}'::jsonb,
  removed    boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (tenant_id, app_id, selector)
);

create index if not exists website_edits_tenant_app_idx
  on website_edits (tenant_id, app_id);

alter table website_edits enable row level security;
drop policy if exists website_edits_select on website_edits;
create policy website_edits_select on website_edits
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = website_edits.tenant_id)
  );

commit;
