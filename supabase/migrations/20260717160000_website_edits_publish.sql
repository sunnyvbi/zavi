
begin;

alter table website_edits
  add column if not exists published_patch   jsonb,
  add column if not exists published_removed boolean not null default false,
  add column if not exists published_at      timestamptz;

create index if not exists website_edits_published_app_idx
  on website_edits (app_id)
  where published_at is not null;

commit;
