
insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'google_ads.update_campaign_budget',
    'Auto route — within-cap Google Ads campaign daily-budget change. Body: { campaign_id, daily_budget_usd, expected_current_daily_budget_usd, rationale, over_cap:false }.',
    'auto',
    'google_ads.update_campaign_budget'
  ),
  (
    'google_ads.update_campaign_budget_review',
    'Approval route — over-cap or oversized-step Google Ads campaign daily-budget change. Same body as the auto class but over_cap:true.',
    'approval',
    'google_ads.update_campaign_budget_review'
  ),
  (
    'google_ads.set_status',
    'Auto route — pause/resume a Google Ads campaign. Body: { campaign_id, status, rationale, over_cap:false }. PAUSE auto-applies only when the tenant opted in to write-caps.',
    'auto',
    'google_ads.set_status'
  ),
  (
    'google_ads.set_status_review',
    'Approval route — Google Ads status flip (typically resume → ENABLED) routed for operator approval. Same body, over_cap:true.',
    'approval',
    'google_ads.set_status_review'
  )
on conflict (slug) do nothing;

alter table tenant_ads_write_caps
  drop constraint if exists tenant_ads_write_caps_platform_chk;
alter table tenant_ads_write_caps
  add constraint tenant_ads_write_caps_platform_chk
    check (platform in ('meta_ads', 'google_ads'));

update system_config
set blob = jsonb_set(blob, '{google_ads_write_enabled}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;
