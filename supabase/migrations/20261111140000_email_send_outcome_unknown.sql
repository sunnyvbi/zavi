begin;

alter table public.email_send_outcomes drop constraint if exists email_send_outcomes_outcome_check;
alter table public.email_send_outcomes
  add constraint email_send_outcomes_outcome_check check (outcome in ('sent', 'failed', 'unknown'));

commit;
