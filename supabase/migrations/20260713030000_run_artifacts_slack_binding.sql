
alter table public.run_artifacts
  add column if not exists slack_team_id    text,
  add column if not exists slack_file_id    text,
  add column if not exists slack_channel_id text,
  add column if not exists slack_thread_ts  text,
  add column if not exists render_input     jsonb;

create unique index if not exists run_artifacts_slack_file_uidx
  on public.run_artifacts (tenant_id, slack_team_id, slack_file_id)
  where slack_file_id is not null;

comment on column public.run_artifacts.slack_file_id is
  'Slack file id returned by files.completeUploadExternal at delivery. Lets an agent read back a document it produced, without re-parsing its own PDF.';
comment on column public.run_artifacts.render_input is
  'The structured render_pdf input this artifact was rendered from. Served as the lossless source text on read-back.';
