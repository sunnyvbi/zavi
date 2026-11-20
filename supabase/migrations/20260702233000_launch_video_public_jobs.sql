
begin;

create table if not exists public.launch_video_public_jobs (
  id                 uuid primary key default gen_random_uuid(),

  tenant_id          uuid not null references public.tenants(id) on delete cascade,

  status             text not null default 'queued'
                       check (status in ('queued','rendering','ready','failed','claimed')),

  client_secret_hash text not null,

  email              text,
  email_domain       text,

  ip_hash            text,

  form_input         jsonb,
  intake             jsonb,

  preview_artifact_id uuid,
  hd_artifact_id      uuid,

  parent_job_id      uuid references public.launch_video_public_jobs(id) on delete set null,

  claimed_by_user_id uuid,
  claimed_at         timestamptz,

  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists lvpj_iphash_created_idx on public.launch_video_public_jobs (ip_hash, created_at desc);
create index if not exists lvpj_email_created_idx  on public.launch_video_public_jobs (email, created_at desc);
create index if not exists lvpj_created_idx        on public.launch_video_public_jobs (created_at desc);
create index if not exists lvpj_status_idx         on public.launch_video_public_jobs (status);

alter table public.launch_video_public_jobs enable row level security;
alter table public.launch_video_public_jobs force row level security;

commit;
