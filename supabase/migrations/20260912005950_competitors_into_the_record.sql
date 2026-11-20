
begin;

with seeded as (
  select
    s.tenant_id,
    array_agg(distinct btrim(b.name) order by btrim(b.name)) as names
  from tenant_app_setting s
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end
  ) as b(name)
  where s.key = 'competitor_intel_custom_brands'
    and btrim(b.name) <> ''
    and length(btrim(b.name)) <= 60
  group by s.tenant_id
),
merged as (
  select
    seeded.tenant_id,
    (
      select string_agg(name, ', ' order by ord)
      from (
        select name, ord from (
          select btrim(x.name) as name, x.ord
          from unnest(string_to_array(coalesce(f.value_text, ''), ',')) with ordinality as x(name, ord)
          where btrim(x.name) <> ''
          union all
          select btrim(n.name), 1000 + n.ord
          from unnest(seeded.names) with ordinality as n(name, ord)
          where not exists (
            select 1
            from unnest(string_to_array(coalesce(f.value_text, ''), ',')) as e(name)
            where lower(btrim(e.name)) = lower(btrim(n.name))
          )
        ) all_names
        order by ord
        limit 20
      ) capped
    ) as value_text,
    f.source as existing_source
  from seeded
  left join tenant_fact f
    on f.tenant_id = seeded.tenant_id and f.key = 'competitors'
)
insert into tenant_fact (tenant_id, key, value_text, source, source_ref, verified_at, updated_at)
select
  tenant_id,
  'competitors',
  value_text,
  coalesce(existing_source, 'onboarding_enrichment'),
  'moved from competitor_intel_custom_brands (20260912005950)',
  now(),
  now()
from merged
where value_text is not null and btrim(value_text) <> ''
on conflict (tenant_id, key) do update
  set value_text  = excluded.value_text,
      source_ref  = excluded.source_ref,
      updated_at  = now();

commit;
