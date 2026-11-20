
set lock_timeout = '5s';

alter table decision_revision_requests
  alter column original_decision_class drop not null;
