
begin;

insert into public.tenant_channels (tenant_id, channel_slug)
select t.id, s.slug
from public.tenants t
cross join (
  select unnest(array[
    'meta_ads','google_ads','youtube_ads','tiktok_ads','linkedin_ads','reddit_ads','affiliate',
    'seo','content','social_organic','community','influencer','youtube_organic','aso',
    'email_marketing','lifecycle','winback','referral','push','sms','in_product',
    'pr','reviews',
    'partnerships','marketplaces'
  ]) as slug
) s
on conflict (tenant_id, channel_slug) do nothing;

commit;

do $$
declare n bigint;
begin
  select count(*) into n from public.tenant_channels;
  raise notice '20260902190000: tenant_channels backfilled, % rows total', n;
end $$;
