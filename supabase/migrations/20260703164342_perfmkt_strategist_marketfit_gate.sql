
insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable)
values
  (
    'perfmkt.create_ad_set_pending_strategist',
    'Internal parked class — a performance-marketer create-ad-set proposal awaiting a growth-lead market-fit review. default_autonomy=auto so the auto-cron fires the NON-SPEND review handler (enqueues growth-lead + records review-state). Body nests the create under create_ad_set (kind=create_ad_set_pending_strategist) so the spend estimator charges $0. NOT operator-facing and NOT meta_ads.% (cannot leak into proposals/revision surfaces).',
    'auto',
    'perfmkt.create_ad_set_pending_strategist',
    false,
    false
  )
on conflict (slug) do nothing;

update decision_classes
   set never_auto = true,
       click_allowlistable = false
 where slug = 'meta_ads.create_ad_set';

create table if not exists ad_set_strategist_reviews (
  pending_decision_id  uuid        primary key references decisions(id) on delete cascade,
  tenant_id            uuid        not null references tenants(id) on delete cascade,
  status               text        not null default 'pending'
                       check (status in ('pending','resolving','approved','bounced','failed')),
  review_run_id        uuid,
  attempts             integer     not null default 0,
  final_decision_id    uuid,
  bounce_reason        text,
  claimed_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists ad_set_strategist_reviews_tenant_pending_uq
  on ad_set_strategist_reviews (tenant_id, pending_decision_id);

create index if not exists ad_set_strategist_reviews_open_idx
  on ad_set_strategist_reviews (status, updated_at)
  where status in ('pending', 'resolving');

alter table ad_set_strategist_reviews enable row level security;
