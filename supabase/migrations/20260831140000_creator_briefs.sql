
begin;

create table if not exists creator_briefs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,

  status             text not null default 'draft'
                       check (status in ('draft', 'sent', 'filled', 'cancelled')),

  title              text not null check (length(btrim(title)) between 1 and 200),
  angle              text not null check (length(btrim(angle)) between 1 and 600),
  hook               text not null check (length(btrim(hook)) between 1 and 400),
  format             text not null check (length(btrim(format)) between 1 and 120),
  deliverables       int  not null default 1 check (deliverables between 1 and 20),

  rationale          text not null check (length(btrim(rationale)) between 1 and 1200),
  evidence           jsonb not null default '[]'::jsonb
                       check (jsonb_typeof(evidence) = 'array'),

  source_campaign_ref text not null default '' check (length(source_campaign_ref) <= 200),
  source_run_id      uuid references agent_runs(id) on delete set null,

  budget_usd         numeric(10, 2) check (budget_usd is null or budget_usd >= 0),

  utm_campaign       text not null
                       default ('zavi-brief-' || substring(replace(gen_random_uuid()::text, '-', ''), 1, 12))
                       check (length(utm_campaign) between 1 and 64),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (utm_campaign)
);

create index if not exists creator_briefs_tenant_idx
  on creator_briefs (tenant_id, created_at desc);

alter table creator_briefs enable row level security;

drop policy if exists creator_briefs_member_select on creator_briefs;
create policy creator_briefs_member_select on creator_briefs
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = creator_briefs.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on creator_briefs from anon, authenticated;
grant select on creator_briefs to authenticated;

commit;
