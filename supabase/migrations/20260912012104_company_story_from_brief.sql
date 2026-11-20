
begin;

insert into tenant_fact (tenant_id, key, value_text, source, source_ref, verified_at, updated_at)
select
  n.tenant_id,
  'company_story',
  btrim(n.body_markdown),
  'onboarding_enrichment'::tenant_fact_source,
  'moved from the company brief (20260912012104)',
  now(),
  now()
from memory_note n
where n.slug = 'company'
  and n.superseded_by is null
  and n.body_markdown is not null
  and btrim(n.body_markdown) <> ''
  and length(btrim(n.body_markdown)) <= 8000
  and not exists (
    select 1 from tenant_fact f
    where f.tenant_id = n.tenant_id and f.key = 'company_story'
  )
on conflict (tenant_id, key) do nothing;

commit;
