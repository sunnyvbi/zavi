begin;

alter table public.run_artifacts
  add column if not exists title text,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

update public.run_artifacts
set title = regexp_replace(filename, '\.[^.]+$', '')
where title is null or btrim(title) = '';

update public.run_artifacts ra
set created_by = ar.enqueued_by
from public.agent_runs ar
where ra.run_id = ar.id and ra.created_by is null;

create or replace function public.normalize_run_artifact_metadata()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.created_by is null then
    select ar.enqueued_by into new.created_by
    from public.agent_runs ar
    where ar.id = new.run_id and ar.tenant_id = new.tenant_id;
  end if;
  if new.title is null or btrim(new.title) = '' then
    new.title := regexp_replace(new.filename, '\.[^.]+$', '');
  end if;
  new.title := left(btrim(new.title), 160);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists normalize_run_artifact_metadata on public.run_artifacts;
create trigger normalize_run_artifact_metadata
  before insert or update on public.run_artifacts
  for each row execute function public.normalize_run_artifact_metadata();

alter table public.run_artifacts
  alter column title set not null;

create index if not exists run_artifacts_tenant_created_idx
  on public.run_artifacts (tenant_id, created_at desc);

create index if not exists run_artifacts_tenant_title_idx
  on public.run_artifacts (tenant_id, lower(title));

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'text/csv',
  'text/html',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.zavi.ui+json'
]
where id = 'agent-artifacts';

commit;
