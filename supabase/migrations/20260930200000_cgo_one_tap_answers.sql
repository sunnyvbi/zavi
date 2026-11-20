
alter table cgo_questions add column if not exists recommended text
  check (recommended is null or recommended in ('yes', 'no'));
alter table cgo_questions add column if not exists why text
  check (why is null or char_length(why) <= 200);
alter table cgo_questions add column if not exists ordinal smallint
  check (ordinal is null or ordinal between 1 and 99);
alter table cgo_questions add column if not exists on_yes jsonb;
alter table cgo_questions add column if not exists applied_line text
  check (applied_line is null or char_length(applied_line) <= 400);
alter table cgo_questions add column if not exists answered_by uuid references auth.users(id) on delete set null;
alter table cgo_questions add column if not exists reminded_at timestamptz;

alter table cgo_questions drop constraint if exists cgo_questions_answered_via_check;
alter table cgo_questions add constraint cgo_questions_answered_via_check
  check (answered_via is null or answered_via in ('email', 'slack', 'chat', 'web'));

create unique index if not exists cgo_questions_open_ordinal
  on cgo_questions (tenant_id, ordinal) where status = 'open' and ordinal is not null;

do $$ begin
  raise notice '20260930200000: cgo_questions one-tap answer columns';
end $$;
