
create table if not exists meta_ad_account_cooldown (
  ad_account       text primary key,
  cooling_until    timestamptz not null,
  probe_claimed_at timestamptz,
  reason           text,
  updated_at       timestamptz not null default now()
);

comment on table meta_ad_account_cooldown is
  'Meta Ads API cooldown per ad account after a rate-limit answer (services/tools/meta-ads/_cooldown.ts). Platform state, no tenant data; service role only.';

alter table meta_ad_account_cooldown enable row level security;
revoke all on table meta_ad_account_cooldown from public, anon, authenticated;
