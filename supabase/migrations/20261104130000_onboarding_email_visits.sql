
create table if not exists public.onboarding_email_visits (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null,
  step        integer not null check (step between 1 and 99),
  visited_at  timestamptz not null default now(),
  unique (tenant_id, user_id, step)
);

comment on table public.onboarding_email_visits is
  'First visit from each onboarding email button, one row per (workspace, person, email number). RLS default-deny, service_role only.';

alter table public.onboarding_email_visits enable row level security;
revoke all on public.onboarding_email_visits from public, anon, authenticated;
grant select, insert, update, delete on public.onboarding_email_visits to service_role;
