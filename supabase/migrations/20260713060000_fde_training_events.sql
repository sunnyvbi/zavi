
begin;

create table if not exists fde_training_events (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,

  staff_user_id        uuid,
  staff_email          text,

  readiness_at         timestamptz,
  before_score         int,
  after_score          int,

  gap_dimension        text check (gap_dimension in (
                         'verified_brain','product_url','connectors',
                         'goal_measurable','deliverable','founder_engaged'
                       )),

  action_kind          text not null check (action_kind in (
                         'brain_correct','draft_send','connector_nudge',
                         'deliverable','dispatch'
                       )),

  input_ref            text,
  work_product_ref     text,

  escalation_category  text,

  agent_training_hint  text,

  folded_into_prompt   boolean not null default false,
  folded_at            timestamptz,

  created_at           timestamptz not null default now()
);

create index if not exists fde_training_events_tenant_idx
  on fde_training_events (tenant_id, created_at desc);
create index if not exists fde_training_events_unfolded_idx
  on fde_training_events (created_at)
  where folded_into_prompt = false;

create or replace function fde_training_events_worm_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fde_training_events is append-only (WORM): DELETE blocked'
      using errcode = '42501';
  end if;

  if old.folded_into_prompt is distinct from false
     or new.folded_into_prompt is distinct from true then
    raise exception 'fde_training_events: folded_into_prompt may only flip false->true (got % -> %)',
      old.folded_into_prompt, new.folded_into_prompt using errcode = '42501';
  end if;

  if (to_jsonb(old) - 'folded_into_prompt' - 'folded_at')
     is distinct from
     (to_jsonb(new) - 'folded_into_prompt' - 'folded_at') then
    raise exception 'fde_training_events is append-only (WORM): only folded_into_prompt/folded_at may be updated'
      using errcode = '42501';
  end if;

  new.folded_at := now();
  return new;
end $$;

drop trigger if exists fde_training_events_worm on fde_training_events;
create trigger fde_training_events_worm
  before update or delete on fde_training_events
  for each row execute function fde_training_events_worm_guard();

alter table fde_training_events enable row level security;

comment on table fde_training_events is
  'Append-only (WORM) capture of every forward-deployed-engineer rescue. One row per FDE move, with readiness before/after, so the P3 loop can fold the generalizable pattern back into the agents and drive FDE-touches-per-readied-tenant down. UPDATE limited to folded_into_prompt false->true by fde_training_events_worm trigger (incl. service-role); DELETE blocked. RLS default-deny — never readable by tenant members (it is cross-tenant). See migration 20260713060000 + onboarding-readiness-fde-plan.md P2.';

commit;
