
alter table meeting_bots
  add column slack_team_id text,
  add column slack_channel_id text,
  add column slack_thread_ts text;
