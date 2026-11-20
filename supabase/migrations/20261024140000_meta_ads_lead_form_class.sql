
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('meta_ads.create_lead_form', 'A lead form on one of the founder''s Facebook Pages, under the founder''s privacy policy. Founder approval only. Body: createLeadFormBodySchema.', 'approval', 'meta_ads.create_lead_form', true, false, 'medium')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
