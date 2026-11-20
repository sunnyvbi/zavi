create or replace function public.site_auth_directory(p_site_id uuid)
returns table (
  id uuid,
  hostname text,
  label text,
  status text,
  shard_id uuid,
  backend_mode text,
  kernel_shard_id uuid
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select s.id, s.hostname, s.label, s.status, s.shard_id, s.backend_mode, s.kernel_shard_id
      from public.sites s
     where s.id = p_site_id
     limit 1;
end $$;

revoke all on function public.site_auth_directory(uuid) from public, anon, authenticated;
grant execute on function public.site_auth_directory(uuid) to service_role;
