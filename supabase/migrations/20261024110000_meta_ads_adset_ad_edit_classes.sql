
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.update_ad_set', 'Change a Meta ad set''s name, end date, bid strategy, bid amount or targeting, checked against the live ad set. Body: updateAdSetBodySchema.', 'approval', 'meta_ads.update_ad_set', true, false, 'medium'),
  ('meta_ads.update_ad', 'Rename one Meta ad, swap its creative, or switch that ad on or off. Body: updateAdBodySchema.', 'approval', 'meta_ads.update_ad', true, false, 'medium'),
  ('meta_ads.duplicate_ad', 'Copy one Meta ad with its creative into an ad set and switch it on. Adds no budget. Body: duplicateAdBodySchema.', 'approval', 'meta_ads.duplicate_ad', true, false, 'medium')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
