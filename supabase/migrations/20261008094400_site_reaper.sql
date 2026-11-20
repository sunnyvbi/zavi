
begin;

create or replace function public.site_reaper_candidates(
  p_cutoff timestamptz,
  p_limit  int
) returns table (tenant_id uuid, site_id uuid, status text, tenant_slug text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_cutoff is null then
    raise exception 'site_reaper_candidates: cutoff is required' using errcode = '22023';
  end if;
  return query
    select s.tenant_id, s.id, s.status, t.slug
      from public.sites s
      join public.tenants t on t.id = s.tenant_id
     where exists (select 1 from public.site_providers p
                    where p.site_id = s.id and p.tenant_id = s.tenant_id and p.state <> 'deleted'
                      and not (p.state = 'delete_scheduled'
                               and (p.scheduled_delete_at is null or p.scheduled_delete_at > now()))
                      and not (p.ref @> '{"retained": true}'::jsonb))
       and (
         (s.status in ('fell_back_old', 'failed', 'deleting', 'deleted')
          and (
            s.updated_at < p_cutoff
            or exists (select 1 from public.site_providers p
                        where p.site_id = s.id and p.tenant_id = s.tenant_id
                          and (p.state in ('cleanup_pending', 'delete_issuing')
                               or (p.state = 'delete_scheduled' and p.scheduled_delete_at <= now())))
          ))
         or
         (s.status in ('provisioning', 'building')
          and s.updated_at < p_cutoff
          and not exists (select 1 from public.conductor_runs r
                           where r.id = s.root_conductor_run_id and r.tenant_id = s.tenant_id
                             and r.status in ('provisioning', 'active', 'paused')))
       )
     order by s.updated_at
     limit least(greatest(coalesce(p_limit, 25), 1), 200);
end $$;

revoke all on function public.site_reaper_candidates(timestamptz, int) from public, anon, authenticated;
grant execute on function public.site_reaper_candidates(timestamptz, int) to service_role;

create or replace function public.delete_site_secrets(
  p_tenant_id uuid,
  p_site_id   uuid
) returns int
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_keys text[];
  v_n    int;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'delete_site_secrets: tenant_id and site_id are required' using errcode = '22023';
  end if;
  v_keys := array[
    'site.' || p_site_id::text || '.sb_service_role',
    'site.' || p_site_id::text || '.sb_anon',
    'site.' || p_site_id::text || '.sb_db_password'
  ];
  delete from vault.secrets v
   where v.id in (select s.vault_secret_id from public.secrets s
                   where s.tenant_id = p_tenant_id and s.key = any (v_keys));
  delete from public.secrets s
   where s.tenant_id = p_tenant_id and s.key = any (v_keys);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.delete_site_secrets(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_site_secrets(uuid, uuid) to service_role;

commit;
