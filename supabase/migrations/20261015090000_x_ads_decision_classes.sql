insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('x_ads.set_status', 'Pause or resume one X Ads campaign. A resume re-opens spend up to its daily budget and refuses if that budget moved since the proposal. Body: statusBody (services/connectors/x-ads/schema.ts).', 'approval', 'x_ads.set_status', true, false, 'medium'),
  ('x_ads.update_campaign', 'Rename one X Ads campaign or change its daily / total budget. Refuses if the campaign changed since the proposal. Body: updateBody.', 'approval', 'x_ads.update_campaign', true, false, 'high'),
  ('x_ads.create_campaign', 'A new X Ads campaign with one ad group promoting existing posts, built paused and switched on only if the proposal says ACTIVE. Body: createBody.', 'approval', 'x_ads.create_campaign', true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;
