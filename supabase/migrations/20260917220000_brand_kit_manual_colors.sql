begin;

alter table tenant_brand_kits
  drop constraint if exists tenant_brand_kits_source_check;

alter table tenant_brand_kits
  add constraint tenant_brand_kits_source_check
  check (source in ('scrape', 'default', 'manual'));

comment on column tenant_brand_kits.source is
  '''scrape'' = read from the tenant''s site; ''default'' = extraction found nothing; '
  '''manual'' = set by the customer on the growth page, and never overwritten by a re-scrape.';

commit;
