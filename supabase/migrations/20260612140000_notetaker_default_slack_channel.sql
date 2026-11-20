alter table tenant_meeting_settings
  add column if not exists slack_channel_id text,
  add column if not exists slack_channel_name text;

alter table meeting_bots
  add column if not exists default_slack_posted_at timestamptz;
