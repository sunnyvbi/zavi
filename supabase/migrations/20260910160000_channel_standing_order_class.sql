
insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  (
    'channel.create-standing-order',
    'Create or replace a growth channel agent''s daily scheduled brief (approval-gated)',
    'approval',
    'praxis.create_channel_standing_order'
  )
on conflict (slug) do nothing;
