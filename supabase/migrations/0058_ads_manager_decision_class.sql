
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'ads-manager.weekly-plan',
  'ads-manager (formerly paid-acquisition) drafts a weekly paid-ads plan. Body: digest envelope.',
  'approval',
  'slack.post_message'
)
on conflict (slug) do nothing;

update agent_drafts
set slug = 'ads-manager'
where slug = 'paid-acquisition';

update agent_runs
set agent_slug = 'ads-manager'
where agent_slug = 'paid-acquisition';

