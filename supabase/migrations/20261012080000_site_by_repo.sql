
begin;

create or replace function public.site_by_repo(p_github_full_name text)
returns table (tenant_id uuid, site_id uuid, status text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_name text := lower(btrim(coalesce(p_github_full_name, '')));
begin
  if v_name = '' then
    return;
  end if;
  return query
    select s.tenant_id, s.id, s.status
      from public.sites s
     where s.github_full_name is not null
       and lower(s.github_full_name) = v_name
     limit 1;
end $$;

revoke all on function public.site_by_repo(text) from public, anon, authenticated;
grant execute on function public.site_by_repo(text) to service_role;

commit;
