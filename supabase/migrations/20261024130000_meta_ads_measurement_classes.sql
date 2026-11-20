
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.create_lookalike_audience', 'A Meta lookalike of one of the account''s audiences (1-10% of a country). Spends nothing. Body: createLookalikeAudienceBodySchema.', 'approval', 'meta_ads.create_lookalike_audience', true, false, 'low'),
  ('meta_ads.create_custom_conversion', 'A Meta custom conversion: a pixel event narrowed to a URL rule. Spends nothing. Body: createCustomConversionBodySchema.', 'approval', 'meta_ads.create_custom_conversion', true, false, 'low')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
