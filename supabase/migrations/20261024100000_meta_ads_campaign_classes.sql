
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.create_campaign', 'A new Meta campaign, created PAUSED. With a campaign daily budget (Advantage campaign budget) it is capped and held like an ad-set create. Body: createCampaignBodySchema.', 'approval', 'meta_ads.create_campaign', true, false, 'medium'),
  ('meta_ads.update_campaign', 'Change a Meta campaign''s name, spend cap, bid strategy or special ad categories, checked against the live campaign. Body: updateCampaignBodySchema.', 'approval', 'meta_ads.update_campaign', true, false, 'medium'),
  ('meta_ads.delete_campaign', 'Delete a Meta campaign with its ad sets and ads. Cannot be undone; the founder''s alone. Body: deleteCampaignBodySchema.', 'approval', 'meta_ads.delete_campaign', true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
