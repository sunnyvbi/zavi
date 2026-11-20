
begin;

alter table public.sites
  add column if not exists publish_generation bigint not null default 0,
  add column if not exists publish_lease_generation bigint,
  add column if not exists publish_lease_token uuid,
  add column if not exists publish_lease_until timestamptz;

create or replace function public.site_publish_begin(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_sha       text
) returns bigint
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_gen bigint;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_publish_begin: tenant_id and site_id are required' using errcode = '22023';
  end if;
  if p_sha is null or p_sha !~ '^[0-9a-f]{7,40}$' then
    raise exception 'site_publish_begin: invalid sha' using errcode = '22023';
  end if;
  update public.sites s
     set publish_generation = s.publish_generation + 1,
         desired_sha = p_sha
   where s.id = p_site_id and s.tenant_id = p_tenant_id
     and (s.publish_lease_generation is null or s.publish_lease_until <= now())
  returning s.publish_generation into v_gen;
  if found then
    return v_gen;
  end if;
  if exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    return 0;
  end if;
  raise exception 'site_publish_begin: site not found' using errcode = 'P0002';
end $$;

create or replace function public.site_publish_lease(
  p_tenant_id   uuid,
  p_site_id     uuid,
  p_generation  bigint,
  p_ttl_seconds integer,
  p_token       uuid
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_gen   bigint;
  v_holder bigint;
  v_until timestamptz;
  v_token uuid;
  v_ttl   integer := least(greatest(coalesce(p_ttl_seconds, 300), 30), 900);
begin
  if p_tenant_id is null or p_site_id is null or p_generation is null or p_token is null then
    raise exception 'site_publish_lease: tenant_id, site_id and generation are required' using errcode = '22023';
  end if;
  select s.publish_generation, s.publish_lease_generation, s.publish_lease_until, s.publish_lease_token
    into v_gen, v_holder, v_until, v_token
    from public.sites s
   where s.id = p_site_id and s.tenant_id = p_tenant_id
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_gen <> p_generation then
    return 'superseded';
  end if;
  if v_holder is not null and v_until > now() and v_token is distinct from p_token then
    return 'busy';
  end if;
  update public.sites
     set publish_lease_generation = p_generation,
         publish_lease_token = p_token,
         publish_lease_until = now() + make_interval(secs => v_ttl)
   where id = p_site_id and tenant_id = p_tenant_id;
  return 'leased';
end $$;

create or replace function public.site_publish_release(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_generation bigint,
  p_token      uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_generation is null or p_token is null then
    raise exception 'site_publish_release: tenant_id, site_id and generation are required' using errcode = '22023';
  end if;
  update public.sites
     set publish_lease_generation = null,
         publish_lease_token = null,
         publish_lease_until = null
   where id = p_site_id and tenant_id = p_tenant_id and publish_lease_generation = p_generation and publish_lease_token = p_token;
end $$;

revoke all on function public.site_publish_begin(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_publish_begin(uuid, uuid, text) to service_role;
revoke all on function public.site_publish_lease(uuid, uuid, bigint, integer, uuid) from public, anon, authenticated;
grant execute on function public.site_publish_lease(uuid, uuid, bigint, integer, uuid) to service_role;
revoke all on function public.site_publish_release(uuid, uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.site_publish_release(uuid, uuid, bigint, uuid) to service_role;

drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text);
create or replace function public.site_activate_if_desired(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_sha        text,
  p_deploy_id  text,
  p_live_url   text,
  p_generation bigint default null
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_sha is null or p_deploy_id is null then
    raise exception 'site_activate_if_desired: tenant_id, site_id, sha and deploy_id are required' using errcode = '22023';
  end if;
  update public.sites s set
    live_sha       = p_sha,
    live_deploy_id = p_deploy_id,
    live_url       = p_live_url,
    updated_at     = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id and s.desired_sha = p_sha
    and s.status not in ('deleting', 'deleted', 'fell_back_old')
    and (s.live_deploy_id is null
         or s.live_deploy_id !~ '^d[0-9a-z]{9}-[0-9a-f]{8}$'
         or p_deploy_id !~ '^d[0-9a-z]{9}-[0-9a-f]{8}$'
         or (substr(s.live_deploy_id, 2, 9) collate "C") <= (substr(p_deploy_id, 2, 9) collate "C"))
    and ((p_generation is null and s.publish_generation = 0) or s.publish_generation = p_generation);
  return found;
end $$;
revoke all on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint) to service_role;

drop function if exists public.site_host_bump(uuid, uuid, boolean, jsonb);
create or replace function public.site_host_bump(
  p_tenant_id   uuid,
  p_site_id     uuid,
  p_set_binding boolean,
  p_binding     jsonb,
  p_generation  bigint default null
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
  v_live boolean;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_host_bump: tenant_id and site_id are required' using errcode = '22023';
  end if;
  select * into v_row from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_host_bump: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if coalesce(p_set_binding, false) and v_row.gateway_binding->>'status' = 'tombstoned'
     and coalesce(p_binding->>'status', '') <> 'tombstoned' then
    raise exception 'site_host_bump: the hostname binding is tombstoned' using errcode = '55000';
  end if;
  v_live := coalesce(p_set_binding, false) and p_binding is not null and coalesce(p_binding->>'status', '') <> 'tombstoned';
  if v_live and p_binding->>'shard_id' is distinct from (
       select sh.project_ref from public.site_shards sh where sh.id = coalesce(v_row.shard_id, v_row.kernel_shard_id)) then
    raise exception 'site_host_bump: binding_not_current' using errcode = '55000';
  end if;
  if v_live and ((p_generation is null and v_row.publish_generation <> 0)
                 or (p_generation is not null and p_generation <> v_row.publish_generation)) then
    raise exception 'site_host_bump: stale_generation' using errcode = '55000';
  end if;
  update public.sites s set
    host_version       = s.host_version + 1,
    gateway_binding    = case when coalesce(p_set_binding, false) then p_binding else s.gateway_binding end,
    updated_at         = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_host_bump(uuid, uuid, boolean, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.site_host_bump(uuid, uuid, boolean, jsonb, bigint) to service_role;

commit;
