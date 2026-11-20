begin;

create table if not exists public.tiktok_ad_launches (
  tenant_id     uuid not null references public.tenants(id),
  action_id     uuid not null,
  foreign key (tenant_id, action_id) references public.channel_actions(tenant_id, id),
  tag           text not null check (tag ~ '^zv[0-9a-f]{10}$'),
  advertiser_id text not null check (advertiser_id ~ '^[0-9]{1,32}$'),
  campaign_id   text check (campaign_id is null or campaign_id ~ '^[0-9]{1,32}$'),
  adgroup_id    text check (adgroup_id is null or adgroup_id ~ '^[0-9]{1,32}$'),
  ad_id         text check (ad_id is null or ad_id ~ '^[0-9]{1,32}$'),
  image_id      text check (image_id is null or char_length(image_id) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, action_id)
);
alter table public.tiktok_ad_launches enable row level security;
revoke all on public.tiktok_ad_launches from public, anon, authenticated;
grant all on public.tiktok_ad_launches to service_role;

do $$
declare r record; original text;
begin
  select oid into r from pg_proc where pronamespace = 'public'::regnamespace and proname = 'note_ad_spend_ref';
  if not found then
    raise exception 'tiktok_ads_launch: note_ad_spend_ref is missing';
  end if;
  original := pg_get_functiondef(r.oid);
  if position('''tiktok_tag''' in original) > 0 then
    raise exception 'tiktok_ads_launch: note_ad_spend_ref already names tiktok_tag';
  end if;
  if position('not in (''meta_tag'', ''meta_adset_name'', ''google_campaign_name'', ''chatgpt_campaign_name'')' in original) = 0 then
    raise exception 'tiktok_ads_launch: note_ad_spend_ref ref-kind check no longer matches';
  end if;
  execute replace(original,
    'not in (''meta_tag'', ''meta_adset_name'', ''google_campaign_name'', ''chatgpt_campaign_name'')',
    'not in (''meta_tag'', ''meta_adset_name'', ''google_campaign_name'', ''chatgpt_campaign_name'', ''tiktok_tag'')');
end $$;

commit;
