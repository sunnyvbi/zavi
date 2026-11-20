begin;

alter table public.creator_submissions add column if not exists preview_path text;
alter table public.creator_submissions add column if not exists preview_state text;
alter table public.creator_submissions add column if not exists preview_error text;
alter table public.creator_submissions add column if not exists preview_updated_at timestamptz;
alter table public.creator_submissions add column if not exists preview_attempts integer not null default 0;

alter table public.creator_submissions drop constraint if exists creator_submissions_preview_attempts_check;
alter table public.creator_submissions add constraint creator_submissions_preview_attempts_check
  check (preview_attempts >= 0);

alter table public.creator_submissions drop constraint if exists creator_submissions_preview_state_check;
alter table public.creator_submissions add constraint creator_submissions_preview_state_check
  check (preview_state is null or preview_state in ('pending', 'ready', 'failed'));

alter table public.creator_submissions drop constraint if exists creator_submissions_preview_path_check;
alter table public.creator_submissions add constraint creator_submissions_preview_path_check
  check (
    preview_path is null
    or (
      preview_path like tenant_id::text || '/' || order_id::text || '/preview/%'
      and position('..' in preview_path) = 0
    )
  );

alter table public.creator_submissions drop constraint if exists creator_submissions_preview_ready_check;
alter table public.creator_submissions add constraint creator_submissions_preview_ready_check
  check (coalesce(preview_state = 'ready', false) = (preview_path is not null));

alter table public.creator_submissions drop constraint if exists creator_submissions_preview_error_check;
alter table public.creator_submissions add constraint creator_submissions_preview_error_check
  check (preview_error is null or length(preview_error) <= 600);

commit;
