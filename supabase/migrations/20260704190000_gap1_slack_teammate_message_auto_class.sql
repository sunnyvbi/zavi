
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto) values
  ('slack.teammate_message', 'Agent Slack message (post/DM/upload) — teammate baseline, auto-allowed', 'auto', null, false)
on conflict (slug) do update set
  description      = excluded.description,
  default_autonomy = 'auto',
  never_auto       = false;
