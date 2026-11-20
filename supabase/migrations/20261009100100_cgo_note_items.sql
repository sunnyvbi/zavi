
begin;

alter table cgo_notes add column if not exists items jsonb, add column if not exists headline text;

alter table cgo_notes drop constraint if exists cgo_notes_items_shape;
alter table cgo_notes add constraint cgo_notes_items_shape
  check (items is null or (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0));

alter table cgo_notes drop constraint if exists cgo_notes_headline_len;
alter table cgo_notes add constraint cgo_notes_headline_len
  check (headline is null or char_length(headline) <= 200);

create index if not exists channel_actions_blocked_recent_idx
  on channel_actions (tenant_id, status_at desc)
  where status = 'stale' and exec_status = 'failed';

create index if not exists cgo_notes_tenant_shown_idx
  on cgo_notes (tenant_id, created_at desc)
  where items is not null or changed <> '{}' or need <> '{}' or would_change <> '{}';

comment on column cgo_notes.items is
  'The note as structured items (section, text, reason, action_id, chain_root_id, ...). NULL = a legacy note or nothing to show. 20261009100100.';
comment on column cgo_notes.headline is
  'The note''s one-line lead (cgo''s own, internal ids stripped, or derived from items). 20261009100100.';

commit;
