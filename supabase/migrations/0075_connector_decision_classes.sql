
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  ('jira.add_comment',    'Add a comment to a JIRA issue. Body: { issue_key, body_markdown }.',                 'approval', 'jira.add_comment'),
  ('linear.create_issue', 'Create a Linear issue. Body: { team_id, title, description_markdown }.',              'approval', 'linear.create_issue'),
  ('linear.add_comment',  'Add a comment to a Linear issue. Body: { issue_id, body_markdown }.',                 'approval', 'linear.add_comment')
on conflict (slug) do nothing;
