
alter table public.slack_workspaces
  add column if not exists welcome_sent_at timestamptz;

comment on column public.slack_workspaces.welcome_sent_at is
  'When the one-time slack-welcome intro (installer DM + chosen-channel post) was claimed/sent. NULL = not yet. Claim-once guard for slack-welcome worker.';
