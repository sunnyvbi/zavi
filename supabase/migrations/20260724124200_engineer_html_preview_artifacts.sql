
create table if not exists public.engineer_html_preview_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  status text not null
    check (status in ('html_preview_ready', 'html_preview_failed')),
  failure_reason text
    check (
      failure_reason is null or failure_reason in (
        'artifact_empty',
        'artifact_oversized',
        'artifact_unsafe',
        'artifact_storage_failed',
        'artifact_missing',
        'malformed_metadata',
        'metadata_mismatch',
        'truncated_response',
        'retry_exhausted'
      )
    ),
  attempt_count smallint not null default 1
    check (attempt_count between 1 and 2),
  title text not null check (char_length(title) between 1 and 120),
  summary text not null check (char_length(summary) <= 4000),
  design_spec jsonb,
  storage_path text,
  sanitized_bytes integer,
  sha256 text,
  displayed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engineer_html_preview_artifacts_tenant_run_uq unique (tenant_id, run_id),
  constraint engineer_html_preview_artifacts_ready_shape check (
    (
      status = 'html_preview_ready'
      and failure_reason is null
      and storage_path is not null
      and sanitized_bytes is not null
      and sha256 is not null
    )
    or
    (
      status = 'html_preview_failed'
      and failure_reason is not null
      and storage_path is null
    )
  )
);

create index if not exists engineer_html_preview_artifacts_tenant_id_idx
  on public.engineer_html_preview_artifacts (tenant_id, id);

alter table public.engineer_html_preview_artifacts enable row level security;
revoke all on public.engineer_html_preview_artifacts from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'engineer-html-previews',
  'engineer-html-previews',
  false,
  204800,
  array['text/html']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
