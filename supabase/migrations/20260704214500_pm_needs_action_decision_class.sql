
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable) values
  (
    'pm.needs_action',
    'The Product Manager surfaced a roadmap theme in an exception state (a prior fix recurred, a dispatch failed to open a PR, or an in-flight fix is stuck in review). Approve to re-dispatch a re-scoped engineer task and close the stuck PR (approval-gated).',
    'approval',
    'pm.needs_action',
    true,
    false
  )
on conflict (slug) do nothing;
