insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('linkedin_ads.launch_campaign', 'One new LinkedIn Ads campaign from a launch plan, spending from the shared ad budget. Body: services/ads-wallet/linkedin-growth.ts.', 'approval', 'linkedin_ads.launch_campaign', true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
