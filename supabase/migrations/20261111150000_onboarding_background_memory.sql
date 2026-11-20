
begin;

create table if not exists public.onboarding_scans (
  id           uuid primary key default gen_random_uuid(),
  public_id    text not null unique check (public_id ~ '^[A-Za-z0-9]{16,32}$'),
  host         text not null check (length(host) between 1 and 253),
  status       text not null default 'queued'
               check (status in ('queued','running','done','failed')),
  enrichment   jsonb,
  claimed_by   uuid,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  expires_at   timestamptz not null default (now() + interval '24 hours')
);

alter table public.onboarding_scans enable row level security;
alter table public.onboarding_scans force row level security;
revoke all on public.onboarding_scans from anon, authenticated;

create table if not exists public.tenant_onboarding_memory (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  user_id         uuid not null,
  host            text,
  initial_name    text,
  scan_public_id  text,
  status          text not null default 'pending'
                  check (status in ('pending','ready','failed')),
  attempt         int not null default 0,
  fallback        boolean not null default false,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.tenant_onboarding_memory enable row level security;
alter table public.tenant_onboarding_memory force row level security;
revoke all on public.tenant_onboarding_memory from anon, authenticated;

alter table memory_note drop constraint if exists memory_note_source_check;
alter table memory_note add constraint memory_note_source_check check (
  source in (
    'human','agent_run','slack_distill','email_distill','operator_feedback',
    'praxis_staff','auto_distill_chat','auto_distill_agent_run','auto_distill_slack',
    'dream_cycle_merge','agent_write','gap_distill','episode_distill',
    'external_learning_distill','meeting_distill','memory_card_distill',
    'agent_discovery_verified','agent_discovery_inferred',
    'document_import',
    'onboarding_seed'
  )
);

commit;
