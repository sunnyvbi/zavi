begin;

insert into public.decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity) values
  ('tiktok_ads.set_status', 'Pause a TikTok Ads campaign, ad group or ad, or turn a campaign or ad group back on, proposed in chat. Body: tiktokStatusBody (services/connectors/tiktok-ads/held-schema.ts).', 'approval', 'tiktok_ads.set_status', true, false, 'medium'),
  ('tiktok_ads.update_budget', 'Change one TikTok Ads campaign or ad group daily budget, proposed in chat. Body: tiktokBudgetBody.', 'approval', 'tiktok_ads.update_budget', true, false, 'high')
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;

commit;
