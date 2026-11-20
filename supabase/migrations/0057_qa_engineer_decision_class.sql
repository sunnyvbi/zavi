
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'qa-engineer.file-bug',
  'qa-engineer flags a regression for operator review. Body: { test_name, file_path, error_msg, suspected_pr }. Slack-only until first customer ask wires a real ticket tool.',
  'approval',
  'slack.post_message'
)
on conflict (slug) do nothing;
