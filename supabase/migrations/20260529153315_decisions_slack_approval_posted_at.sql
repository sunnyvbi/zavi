
alter table decisions
  add column if not exists slack_approval_posted_at timestamptz;
