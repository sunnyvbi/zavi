
insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  ('operator.file-jira-issue',    'Operator-emitted Jira ticket creation. Dispatches via existing jira.create_issue handler.',     'auto', 'jira.create_issue'),
  ('operator.file-linear-issue',  'Operator-emitted Linear issue creation. Dispatches via existing linear.create_issue handler.', 'auto', 'linear.create_issue'),
  ('operator.post-slack-message', 'Operator-emitted Slack message post. Dispatches via existing slack.post_message handler.',     'auto', 'slack.post_message')
on conflict (slug) do nothing;
