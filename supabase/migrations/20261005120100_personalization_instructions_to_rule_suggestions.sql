
begin;

insert into public.tenant_rules (
  tenant_id, scope_kind, scope_slug, text, status, origin,
  source_ref, source_hash, suggested_by
)
select
  l.tenant_id, 'all', null, left(l.line, 280), 'suggested', 'moved_from_personalization',
  'personalization:' || l.tenant_id || ':' || l.n, md5(l.line), 'zavi'
from (
  select p.tenant_id, btrim(t.line) as line, t.n
    from public.tenant_personalization p
    cross join lateral regexp_split_to_table(coalesce(p.custom_instructions, ''), '\r?\n')
      with ordinality as t(line, n)
) l
where length(l.line) > 0
  and l.line !~ '^\[[^\]]*\]$'
  and l.line !~ '\m\d{3}[ -]?\d{2}[ -]?\d{4}\M'
  and l.line !~ '(\d[ -]?){13,19}'
  and l.n <= 10
on conflict (tenant_id, origin, source_ref, source_hash) where source_ref is not null
do nothing;

commit;
