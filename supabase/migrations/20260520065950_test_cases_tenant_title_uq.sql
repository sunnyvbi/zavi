
do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select tenant_id, lower(trim(title)) as norm_title, count(*) c
    from public.test_cases
    where status <> 'archived'
    group by tenant_id, lower(trim(title))
    having count(*) > 1
  ) sub;
  if v_dup_count > 0 then
    raise exception
      'aborting: % duplicate (tenant_id, lower(trim(title))) group(s) on non-archived test_cases would block test_cases_tenant_title_uq. Archive or merge the duplicates, then re-run this migration.',
      v_dup_count;
  end if;
end $$;

create unique index if not exists test_cases_tenant_title_uq
  on public.test_cases (tenant_id, lower(trim(title)))
  where status <> 'archived';
