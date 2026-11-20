
alter table creator_library_assets
  add column if not exists meta_ad_set_id  text,
  add column if not exists metrics         jsonb,
  add column if not exists metrics_read_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'creator_library_assets'::regclass
      and conname = 'creator_library_assets_meta_ad_set_id_len'
  ) then
    alter table creator_library_assets
      add constraint creator_library_assets_meta_ad_set_id_len
      check (meta_ad_set_id is null or length(meta_ad_set_id) <= 64);
  end if;
end $$;

comment on column creator_library_assets.meta_ad_set_id is
  'The Meta ad set the paused ad was created in. Stored so a later ad-level read can be scoped: meta_ads.list_ads requires adset_id or campaign_id and has no ad_id input.';
comment on column creator_library_assets.metrics is
  'Latest absolute-number snapshot for THIS ONE AD, e.g. {"spend_usd":…,"impressions":…,"clicks":…,"reach":…,"conversions":…,"purchases":…,"purchase_value_usd":…}. Counts and totals only — never a ratio (no ROAS, no CPA), because the row names a person and the business set the targeting and budget. Null until the first readback.';
comment on column creator_library_assets.metrics_read_at is
  'When creator_library_assets.metrics was last written (the Meta fetch time).';
