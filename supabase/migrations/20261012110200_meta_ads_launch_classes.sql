
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.duplicate_ad_set', 'Copy a running Meta ad set with its ads, switched on at its own daily budget. Ads off in the source stay off. Held against the ad budget like a live create. Body: duplicateAdSetBodySchema (services/tools/meta-ads/write/_decision-bodies.ts).', 'approval', 'meta_ads.duplicate_ad_set', true, false, 'high'),
  ('meta_ads.duplicate_campaign', 'Copy a running Meta campaign that sets its own budget (Advantage campaign budget) with its ad sets and ads, switched on at its own daily budget. Held like a live create. Body: duplicateCampaignBodySchema.', 'approval', 'meta_ads.duplicate_campaign', true, false, 'high'),
  ('meta_ads.create_ad', 'A new live ad in an existing Meta ad set (image, video or a source ad''s media with new words). Adds no budget: the ad set''s own budget is the spend. Body: createAdBodySchema.', 'approval', 'meta_ads.create_ad', true, false, 'medium'),
  ('meta_ads.create_custom_audience', 'A Meta website-visitor custom audience (30 or 90 days) off the ad account''s pixel, for retargeting and prospecting exclusions. Spends nothing. Body: createCustomAudienceBodySchema.', 'approval', 'meta_ads.create_custom_audience', true, false, 'low')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
