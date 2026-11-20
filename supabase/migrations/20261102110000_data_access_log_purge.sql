begin;
create or replace function public.purge_data_access_log(p_batch_limit integer default 5000)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  with doomed as (
    select id from public.data_access_log where created_at < now() - interval '365 days'
     order by created_at limit greatest(1, least(p_batch_limit, 20000))
  )
  delete from public.data_access_log l using doomed where l.id = doomed.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.purge_data_access_log(integer) from public, anon, authenticated;
grant execute on function public.purge_data_access_log(integer) to service_role;
commit;
