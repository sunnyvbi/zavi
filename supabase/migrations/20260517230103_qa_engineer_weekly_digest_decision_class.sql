
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'qa-engineer.weekly-digest',
  'qa-engineer emits a weekly QA digest (catalog-built or weekly-execute mode). Body: { mode, tier1..tier4, rendered_markdown, summary }. Routes to digest.post → tenant #praxis Slack if reachable, /approvals always.',
  'auto',
  'digest.post'
)
on conflict (slug) do nothing;
