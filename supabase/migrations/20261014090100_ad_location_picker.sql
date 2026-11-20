
begin;

alter table public.tenant_fact
  drop constraint if exists tenant_fact_country_iso_check;
alter table public.tenant_fact
  add constraint tenant_fact_country_iso_check
  check (key <> 'country' or value_text ~ '^[A-Z]{2}$');

create table if not exists public.ad_location_choices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  channel_slug text not null check (channel_slug in ('google_ads', 'youtube_ads', 'meta_ads')),
  platform     text not null check (platform in ('google', 'meta')),
  object_id    text not null check (object_id ~ '^[0-9]{1,64}$'),
  state        text not null check (state in ('noted', 'country', 'places')),
  places       jsonb not null default '[]'::jsonb
               check (jsonb_typeof(places) = 'array' and jsonb_array_length(places) <= 50),
  decision_id  uuid references public.decisions(id) on delete set null,
  chosen_by    uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, platform, object_id)
);

alter table public.ad_location_choices enable row level security;
revoke all on public.ad_location_choices from public, anon, authenticated;
grant select, insert, update, delete on public.ad_location_choices to service_role;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity)
values
  (
    'google_ads.replace_geo_targets_review',
    'Approval route — the founder replaces where ONE Google Ads campaign shows: its positive LOCATION criteria (campaign level; every ad group for Demand Gen). Negative, proximity and location-group criteria are kept. Fails stale on a targeting fingerprint, reads back after. Body: replaceGeoTargetsBodySchema (services/tools/google-ads/write/replace_geo_targets.ts).',
    'approval',
    'google_ads.replace_geo_targets_review',
    true,
    false,
    'medium'
  ),
  (
    'meta_ads.replace_ad_set_geo_review',
    'Approval route — the founder replaces where ONE Meta ad set shows: targeting.geo_locations only, every other targeting field kept. Fails stale on a targeting fingerprint, reads back after. Body: replaceAdSetGeoBodySchema (services/tools/meta-ads/write/replace_ad_set_geo.ts).',
    'approval',
    'meta_ads.replace_ad_set_geo_review',
    true,
    false,
    'medium'
  )
on conflict (slug) do update
  set description         = excluded.description,
      default_autonomy    = excluded.default_autonomy,
      dispatch_handler    = excluded.dispatch_handler,
      never_auto          = excluded.never_auto,
      click_allowlistable = excluded.click_allowlistable,
      severity            = excluded.severity;

commit;
