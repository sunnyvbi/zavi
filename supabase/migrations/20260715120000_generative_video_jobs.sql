
create table if not exists public.generative_video_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  meter_key text not null,
  model text not null,
  job_id text,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed')),
  result_url text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generative_video_jobs_run_meter_key unique (run_id, meter_key)
);

create index if not exists generative_video_jobs_run_idx
  on public.generative_video_jobs (run_id);

alter table public.generative_video_jobs enable row level security;

comment on table public.generative_video_jobs is
  'Crash-safe ledger of in-flight Higgsfield generative-video jobs. Worker persists job_id after submit, resumes on retry. tenant_id is C8-derived, RLS deny-all.';
