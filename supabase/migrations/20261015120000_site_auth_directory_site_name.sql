
begin;

drop function if exists public.site_auth_directory(uuid);
create or replace function public.site_auth_directory(p_site_id uuid)
returns table (
  id uuid,
  hostname text,
  label text,
  status text,
  shard_id uuid,
  backend_mode text,
  kernel_shard_id uuid,
  is_test boolean,
  name text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select s.id, s.hostname, s.label, s.status, s.shard_id, s.backend_mode, s.kernel_shard_id, false, s.name
      from public.sites s
     where s.id = p_site_id
     limit 1;
  if found then
    return;
  end if;
  return query
    select t.id, t.preview_host, 'Test site'::text,
           case t.state when 'creating' then 'provisioning' else 'live' end,
           t.shard_id, 'pooled'::text, null::uuid, true, null::text
      from public.site_test_sites t
      join public.site_shards sh on sh.id = t.shard_id and sh.purpose = 'validation'
     where t.id = p_site_id and t.state in ('creating', 'active') and t.expires_at > now()
     limit 1;
end $$;

revoke all on function public.site_auth_directory(uuid) from public, anon, authenticated;
grant execute on function public.site_auth_directory(uuid) to service_role;

commit;
