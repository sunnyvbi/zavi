
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'human_member_handles'
      and column_name = 'bench_member_id'
  ) then
    alter table human_member_handles rename column bench_member_id to human_member_id;
  end if;
end $$;

