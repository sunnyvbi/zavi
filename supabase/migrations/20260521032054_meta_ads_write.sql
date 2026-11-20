

insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'meta_ads.update_ad_set_budget',
    'Auto route — within-cap ad-set daily-budget change. Body: { ad_set_id, daily_budget_usd, expected_current_daily_budget_usd, rationale, over_cap:false }.',
    'auto',
    'meta_ads.update_ad_set_budget'
  ),
  (
    'meta_ads.update_ad_set_budget_review',
    'Approval route — over-cap or pre-opt-in ad-set daily-budget change. Same body as the auto class but over_cap:true.',
    'approval',
    'meta_ads.update_ad_set_budget_review'
  ),
  (
    'meta_ads.set_status',
    'Auto route — pause/resume a campaign or ad set. Body: { object_id, level, status, rationale, over_cap:false }.',
    'auto',
    'meta_ads.set_status'
  ),
  (
    'meta_ads.set_status_review',
    'Approval route — status flip (typically resume → ACTIVE) routed for operator approval. Same body, over_cap:true.',
    'approval',
    'meta_ads.set_status_review'
  ),
  (
    'meta_ads.create_ad_set',
    'Approval-only — create a new ad set under an existing campaign. Always operator-approved (no auto sibling). Body: { campaign_id, name, daily_budget_usd, optimization_goal, billing_event, targeting, rationale }.',
    'approval',
    'meta_ads.create_ad_set'
  )
on conflict (slug) do nothing;

create table if not exists tenant_ads_write_caps (
  tenant_id                   uuid    not null references tenants(id) on delete cascade,
  platform                    text    not null default 'meta_ads',
  enabled                     boolean not null default false,
  max_daily_budget_usd        numeric(10,2),
  max_pct_change_per_run      numeric(5,4),
  max_daily_total_change_usd  numeric(10,2),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  primary key (tenant_id, platform),
  constraint tenant_ads_write_caps_platform_chk
    check (platform in ('meta_ads')),
  constraint tenant_ads_write_caps_max_pct_range_chk
    check (max_pct_change_per_run is null
           or (max_pct_change_per_run >= 0 and max_pct_change_per_run <= 1)),
  constraint tenant_ads_write_caps_nonneg_chk
    check ((max_daily_budget_usd       is null or max_daily_budget_usd       >= 0)
       and (max_daily_total_change_usd is null or max_daily_total_change_usd >= 0))
);

alter table tenant_ads_write_caps enable row level security;

update system_config
set blob = jsonb_set(blob, '{meta_ads_write_enabled}', 'false'::jsonb, true),
    updated_at = now()
where id = 1;
