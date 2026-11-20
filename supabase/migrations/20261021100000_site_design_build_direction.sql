begin;

alter table public.site_design_briefs
  add column if not exists build_direction text
    check (build_direction is null or build_direction ~ '^[a-z][a-z0-9-]{1,30}$'),
  add column if not exists build_direction_at timestamptz;

commit;
