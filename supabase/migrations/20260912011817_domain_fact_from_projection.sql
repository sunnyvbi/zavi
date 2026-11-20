
begin;

insert into tenant_fact (tenant_id, key, value_text, source, source_ref, verified_at, updated_at)
select
  t.id,
  'domain',
  t.product_url->>'marketing',
  case
    when t.product_url->>'marketing' like '%onrender.com%' then 'provisioned'
    else 'onboarding_enrichment'
  end::tenant_fact_source,
  'backfilled from tenants.product_url (20260912011817)',
  now(),
  now()
from tenants t
where coalesce(t.kind, '') <> 'test'
  and t.product_url->>'marketing' is not null
  and btrim(t.product_url->>'marketing') <> ''
  and length(btrim(t.product_url->>'marketing')) <= 500
  and not exists (
    select 1 from tenant_fact f
    where f.tenant_id = t.id and f.key = 'domain'
  );

commit;
