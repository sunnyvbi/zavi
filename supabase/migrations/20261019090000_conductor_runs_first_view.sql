alter table public.conductor_runs
  add column if not exists first_draft_at timestamptz,
  add column if not exists first_preview_at timestamptz,
  add column if not exists first_content_at timestamptz;
