
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.launch_campaign', 'A new Meta campaign with its ad set, creative and ad, switched on by one approval. The campaign holds the daily budget and is held against the ad budget like a live create; any failed step switches it off. Body: launchCampaignBodySchema.', 'approval', 'meta_ads.launch_campaign', true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
