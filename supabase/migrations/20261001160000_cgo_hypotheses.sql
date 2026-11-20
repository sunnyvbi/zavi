
create table if not exists cgo_hypotheses (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  goal_id          uuid not null references autopilot_goals(id) on delete cascade,
  problem          text not null check (problem in ('traffic', 'conversion', 'activation', 'retention', 'offer', 'tracking', 'channel', 'other')),
  claim            text not null check (char_length(claim) between 1 and 400),
  refute_if        text check (refute_if is null or char_length(refute_if) <= 300),
  rank             int not null default 5 check (rank between 1 and 10),
  status           text not null default 'listed'
                     check (status in ('listed', 'testing', 'confirmed', 'ruled_out')),
  evidence         jsonb not null default '[]'::jsonb,
  evidence_version int not null default 0,
  expected_gain    numeric,
  research_open    boolean not null default false,
  research_card_id uuid,
  created_run_id   uuid references agent_runs(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  status_at        timestamptz not null default now()
);

create unique index if not exists cgo_hypotheses_one_research_per_goal
  on cgo_hypotheses (tenant_id, goal_id) where research_open;
create index if not exists cgo_hypotheses_tenant_goal_idx
  on cgo_hypotheses (tenant_id, goal_id, status);

alter table cgo_hypotheses enable row level security;

create policy cgo_hypotheses_member_select on cgo_hypotheses
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = cgo_hypotheses.tenant_id
    )
  );
create policy cgo_hypotheses_active_tenant_restrict
  on cgo_hypotheses as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));
revoke insert, update, delete on cgo_hypotheses from anon, authenticated;
