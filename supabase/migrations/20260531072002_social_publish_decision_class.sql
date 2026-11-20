
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'social.publish',
  'social drafts an organic post and publishes it to a connected social account on operator approval. Body: { rendered_markdown } with the drafted post + proposed channel/caption. Irreversible + outward-facing -> approval-only. Handler posts via connector OAuth.',
  'approval',
  'social.publish'
)
on conflict (slug) do nothing;
