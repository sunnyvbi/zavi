
alter table cgo_questions alter column expires_at drop not null;

update cgo_questions
   set expires_at = null
 where status = 'open'
   and (default_action is null or default_action->>'kind' <> 'pause_channel');

alter table cgo_questions drop constraint if exists cgo_questions_status_check;
alter table cgo_questions add constraint cgo_questions_status_check
  check (status in ('open', 'queued', 'answered', 'expired', 'withdrawn'));

alter table cgo_questions add constraint cgo_questions_queued_no_default
  check (status <> 'queued' or (default_action is null and expires_at is null and ordinal is null)) not valid;
alter table cgo_questions validate constraint cgo_questions_queued_no_default;

drop index if exists cgo_questions_one_open_per_topic;
create unique index if not exists cgo_questions_one_waiting_per_topic
  on cgo_questions (tenant_id, topic_key) where status in ('open', 'queued');
