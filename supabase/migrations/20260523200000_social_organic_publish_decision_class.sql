
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values (
  'social-organic.publish',
  'social-organic publishes a drafted post to a connected social account (Instagram/LinkedIn/TikTok) via the Anchor browser. Body: { platform, account_handle, draft_id, media_path, caption }. Irreversible + outward-facing → approval-only. Handler wired in P2.',
  'approval',
  null
)
on conflict (slug) do nothing;
