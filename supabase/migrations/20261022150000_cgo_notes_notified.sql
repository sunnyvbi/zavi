
begin;

alter table cgo_notes add column if not exists notified boolean;
alter table cgo_notes add column if not exists notification_key text;
alter table cgo_notes add column if not exists queued_at timestamptz;

create unique index if not exists cgo_notes_notification_key_idx on cgo_notes (tenant_id, notification_key);

commit;
