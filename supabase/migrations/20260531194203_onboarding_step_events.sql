
create table if not exists public.onboarding_step_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants(id) on delete set null,
  user_id     uuid,
  step        text not null,
  status      text not null default 'entered',
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.onboarding_step_events is
  'Per-step onboarding wizard progress events (GAP #52). Append-only; feeds activation drop-off diagnosis. Service-role-only access.';

create index if not exists onboarding_step_events_step_idx
  on public.onboarding_step_events (step, created_at desc);

create index if not exists onboarding_step_events_user_idx
  on public.onboarding_step_events (user_id, created_at desc);

create index if not exists onboarding_step_events_tenant_idx
  on public.onboarding_step_events (tenant_id, created_at desc);

alter table public.onboarding_step_events enable row level security;
