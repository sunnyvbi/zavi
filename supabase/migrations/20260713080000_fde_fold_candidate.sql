
begin;

create table if not exists fde_fold_candidate (
  id                  uuid primary key default gen_random_uuid(),

  pattern_summary     text not null,
  target_agent_slug   text,
  gap_dimension       text check (gap_dimension in (
                        'verified_brain','product_url','connectors',
                        'goal_measurable','deliverable','founder_engaged'
                      )),

  source_event_ids    uuid[] not null default '{}',
  source_tenant_count int not null default 0,

  conflict_of_interest boolean not null default false,
  conflict_detail      text,

  tenant_fact_check   text not null default 'pending'
    check (tenant_fact_check in ('pending','clean','contains_tenant_fact')),

  eval_status         text not null default 'unmeasured'
    check (eval_status in ('unmeasured','improved','regressed','neutral','error')),
  eval_delta          jsonb,

  status              text not null default 'proposed'
    check (status in ('proposed','approved','rejected','applied')),
  decided_by          uuid,
  decided_at          timestamptz,
  decision_note       text,
  applied_ref         text,
  applied_at          timestamptz,

  created_at          timestamptz not null default now()
);

create index if not exists fde_fold_candidate_open_idx
  on fde_fold_candidate (created_at desc)
  where status = 'proposed';

alter table fde_fold_candidate enable row level security;

comment on table fde_fold_candidate is
  'Staged, human-approved generalizations from FDE rescues (P3). The worker PROPOSES, a human DISPOSES, the existing staff-gated bake route APPLIES — nothing here can write an agent prompt unattended. Deliberately not an auto-apply: the last model-driven auto-writer in this codebase (the Haiku memory conflict-resolver) silently destroyed ~351 real operator facts. eval_status defaults to ''unmeasured'' because no prompt-eval holdout harness exists yet — that is why approval is human. See migration 20260713080000 + onboarding-readiness-fde-plan.md P3.';

commit;
