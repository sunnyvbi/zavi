
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable)
values
  (
    'google_ads.create_campaign',
    'Approval route — create a Google Ads campaign (budget + campaign + optional first ad group, keywords and ads) in one atomic write, PAUSED. Body: createCampaignBodySchema (services/tools/google-ads/write/_decision-bodies.ts).',
    'approval',
    'google_ads.create_campaign',
    true,
    false
  ),
  (
    'google_ads.update_campaign',
    'Approval route — rename a Google Ads campaign or change its bidding target / network settings. Body: updateCampaignBodySchema.',
    'approval',
    'google_ads.update_campaign',
    false,
    false
  ),
  (
    'google_ads.create_ad_group',
    'Approval route — create a Google Ads ad group (PAUSED) with optional keywords and ads. Body: createAdGroupBodySchema.',
    'approval',
    'google_ads.create_ad_group',
    false,
    false
  ),
  (
    'google_ads.update_ad_group',
    'Approval route — rename a Google Ads ad group or change its default bids. Body: updateAdGroupBodySchema.',
    'approval',
    'google_ads.update_ad_group',
    false,
    false
  ),
  (
    'google_ads.create_ad',
    'Approval route — create a responsive search ad or a YouTube video ad (PAUSED) in an existing ad group. Body: createAdBodySchema.',
    'approval',
    'google_ads.create_ad',
    false,
    false
  ),
  (
    'google_ads.add_keywords',
    'Approval route — add positive or negative keywords to an ad group, or negative keywords to a campaign. Body: addKeywordsBodySchema.',
    'approval',
    'google_ads.add_keywords',
    false,
    false
  ),
  (
    'google_ads.remove_resource',
    'Approval route — permanently remove a Google Ads campaign, ad group, ad or keyword. Body: removeResourceBodySchema.',
    'approval',
    'google_ads.remove_resource',
    true,
    false
  )
on conflict (slug) do nothing;

update decision_classes
   set never_auto = true,
       click_allowlistable = false
 where slug in (
   'google_ads.create_campaign',
   'google_ads.remove_resource',
   'google_ads.update_campaign_budget_review',
   'google_ads.set_status_review'
 );
