
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.create_creative', 'A reusable Meta ad creative (no ad; spends nothing until an ad uses it). Body: createCreativeBodySchema.', 'approval', 'meta_ads.create_creative', true, false, 'low'),
  ('meta_ads.update_creative', 'Rename a Meta ad creative. Body: updateCreativeBodySchema.', 'approval', 'meta_ads.update_creative', true, false, 'low'),
  ('meta_ads.upload_asset', 'Add an image or video to the Meta ad account''s library. Spends nothing. Body: uploadAssetBodySchema.', 'approval', 'meta_ads.upload_asset', true, false, 'low')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
