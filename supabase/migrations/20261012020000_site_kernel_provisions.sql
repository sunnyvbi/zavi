
begin;

create table if not exists public.site_kernel_provisions (
  site_id         uuid primary key references public.sites (id) on delete cascade,
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  state           text not null default 'requested'
                  check (state in ('requested', 'project_ready', 'kernel_ready', 'attached')),
  reason          text not null check (reason in ('isolation', 'capacity', 'staff')),
  project_ref     text check (project_ref is null or project_ref ~ '^[a-z0-9]{8,40}$'),
  region          text check (region is null or region ~ '^[a-z0-9-]{2,40}$'),
  kernel_shard_id uuid references public.site_shards (id) on delete set null,
  attempts        integer not null default 0,
  last_error      text,
  lease_id        uuid,
  lease_until     timestamptz,
  requested_at    timestamptz not null default now(),
  attached_at     timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.site_kernel_provisions enable row level security;
revoke all on public.site_kernel_provisions from public, anon, authenticated;

create or replace function public.site_kernel_site_check(
  p_fn   text,
  p_site public.sites
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_site.status in ('deleting', 'deleted', 'failed', 'fell_back_old') then
    raise exception '%: site % is %', p_fn, p_site.id, p_site.status using errcode = '55000';
  end if;
  if p_site.backend_mode = 'pooled' or p_site.shard_id is not null then
    raise exception '%: site % already has pooled data; it must graduate', p_fn, p_site.id using errcode = '55000';
  end if;
  if p_site.backend_mode = 'dedicated' and p_site.kernel_shard_id is null then
    raise exception '%: site % is a legacy dedicated site', p_fn, p_site.id using errcode = '55000';
  end if;
end $$;

revoke all on function public.site_kernel_site_check(text, public.sites) from public, anon, authenticated, service_role;

create or replace function public.site_kernel_provision_claim(
  p_tenant_id     uuid,
  p_site_id       uuid,
  p_reason        text,
  p_lease_seconds integer
) returns setof public.site_kernel_provisions
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site public.sites;
  v_row  public.site_kernel_provisions;
  v_has  boolean;
begin
  if p_tenant_id is null or p_site_id is null or p_reason is null then
    raise exception 'site_kernel_provision_claim: tenant, site and reason are required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'site_kernel_provision_claim: lease must be 10..3600 seconds' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_kernel_provision_claim: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  perform public.site_kernel_site_check('site_kernel_provision_claim', v_site);
  select * into v_row from public.site_kernel_provisions k where k.site_id = p_site_id and k.tenant_id = p_tenant_id for update;
  v_has := found;
  if v_has and v_row.state = 'attached' then
    return next v_row;
    return;
  end if;
  if v_site.gateway_binding is not null or v_site.kernel_shard_id is not null
     or exists (select 1 from public.site_providers sp
                 where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = 'pooled_backend'
                   and coalesce(sp.ref->>'kernel_site', '') <> 'true') then
    raise exception 'site_kernel_provision_claim: site % already has pooled data; it must graduate', p_site_id using errcode = '55000';
  end if;
  if not v_has and exists (select 1 from public.site_providers sp
                            where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = 'supabase_project'
                              and sp.ref->>'legacy_dedicated' = 'true') then
    raise exception 'site_kernel_provision_claim: site % is a legacy dedicated site', p_site_id using errcode = '55000';
  end if;
  if not v_has then
    insert into public.site_kernel_provisions (site_id, tenant_id, reason)
    values (p_site_id, p_tenant_id, p_reason)
    returning * into v_row;
  end if;
  return query
  update public.site_kernel_provisions k
     set lease_id = gen_random_uuid(), lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = k.attempts + 1, updated_at = now()
   where k.site_id = p_site_id and k.tenant_id = p_tenant_id and k.state <> 'attached'
     and (k.lease_until is null or k.lease_until < now())
  returning k.*;
end $$;

revoke all on function public.site_kernel_provision_claim(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.site_kernel_provision_claim(uuid, uuid, text, integer) to service_role;

create or replace function public.site_kernel_provision_advance(
  p_tenant_id     uuid,
  p_site_id       uuid,
  p_lease_id      uuid,
  p_from          text,
  p_to            text,
  p_patch         jsonb,
  p_release       boolean,
  p_lease_seconds integer
) returns setof public.site_kernel_provisions
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_site  public.sites;
  v_row   public.site_kernel_provisions;
begin
  if p_tenant_id is null or p_site_id is null or p_lease_id is null then
    raise exception 'site_kernel_provision_advance: tenant, site and lease are required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'site_kernel_provision_advance: lease must be 10..3600 seconds' using errcode = '22023';
  end if;
  if jsonb_typeof(v_patch) <> 'object' or (v_patch - array['project_ref', 'region', 'kernel_shard_id', 'last_error']) <> '{}'::jsonb then
    raise exception 'site_kernel_provision_advance: patch has keys outside the allowlist' using errcode = '22023';
  end if;
  if not ((p_from, p_to) in (('requested', 'project_ready'), ('project_ready', 'kernel_ready'),
                             ('requested', 'requested'), ('project_ready', 'project_ready'), ('kernel_ready', 'kernel_ready'))) then
    raise exception 'site_kernel_provision_advance: % -> % is not a step', p_from, p_to using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_kernel_provision_advance: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if not (coalesce(p_release, false) and p_from = p_to) then
    perform public.site_kernel_site_check('site_kernel_provision_advance', v_site);
  end if;
  update public.site_kernel_provisions k set
    state           = p_to,
    project_ref     = case when v_patch ? 'project_ref' then v_patch->>'project_ref' else k.project_ref end,
    region          = case when v_patch ? 'region' then v_patch->>'region' else k.region end,
    kernel_shard_id = case when v_patch ? 'kernel_shard_id' then (v_patch->>'kernel_shard_id')::uuid else k.kernel_shard_id end,
    last_error      = case when v_patch ? 'last_error' then left(v_patch->>'last_error', 500)
                           when p_to <> p_from then null else k.last_error end,
    lease_id        = case when coalesce(p_release, false) then null else k.lease_id end,
    lease_until     = case when coalesce(p_release, false) then null else now() + make_interval(secs => p_lease_seconds) end,
    updated_at      = now()
   where k.site_id = p_site_id and k.tenant_id = p_tenant_id and k.state = p_from
     and k.lease_id = p_lease_id and k.lease_until >= now()
  returning k.* into v_row;
  if not found then
    return;
  end if;
  if p_from = 'requested' and p_to = 'project_ready' then
    insert into public.site_providers (site_id, tenant_id, kind, state, ref, updated_at)
    values (p_site_id, p_tenant_id, 'pooled_backend', 'created', jsonb_build_object('kernel_site', true), now())
    on conflict (site_id, kind) do update
      set state = 'created', ref = public.site_providers.ref || jsonb_build_object('kernel_site', true),
          scheduled_delete_at = null, updated_at = now()
      where coalesce(public.site_providers.ref->>'kernel_site', '') = 'true';
  end if;
  return next v_row;
end $$;

revoke all on function public.site_kernel_provision_advance(uuid, uuid, uuid, text, text, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function public.site_kernel_provision_advance(uuid, uuid, uuid, text, text, jsonb, boolean, integer) to service_role;

create or replace function public.site_kernel_attach(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_lease_id  uuid
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site   public.sites;
  v_row    public.site_kernel_provisions;
  v_kernel uuid;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_kernel_attach: tenant_id and site_id are required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_kernel_attach: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  perform public.site_kernel_site_check('site_kernel_attach', v_site);
  select * into v_row from public.site_kernel_provisions k where k.site_id = p_site_id and k.tenant_id = p_tenant_id for update;
  if not found or v_row.state not in ('kernel_ready', 'attached') then
    raise exception 'site_kernel_attach: the kernel of % is not ready', p_site_id using errcode = '55000';
  end if;
  select sh.id into v_kernel from public.site_shards sh
   where sh.dedicated_site_id = p_site_id and sh.project_ref = v_site.supabase_project_ref
     and sh.state = 'full' and sh.provision_step = 'done' and sh.max_sites = 1;
  if v_kernel is null then
    raise exception 'site_kernel_attach: the kernel shard of % is not registered to its project or not serving', p_site_id using errcode = '55000';
  end if;
  if v_row.state = 'attached' then
    if v_site.backend_mode = 'dedicated' and v_site.kernel_shard_id = v_kernel then
      return v_site;
    end if;
    raise exception 'site_kernel_attach: site % no longer matches its attached kernel', p_site_id using errcode = '55000';
  end if;
  if p_lease_id is null or v_row.lease_id is distinct from p_lease_id or v_row.lease_until < now() then
    raise exception 'site_kernel_attach: the lease on % is not held', p_site_id using errcode = '55000';
  end if;
  if v_site.backend_mode <> 'static' or v_site.kernel_shard_id is not null or v_site.gateway_binding is not null
     or exists (select 1 from public.site_providers sp
                 where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = 'pooled_backend'
                   and coalesce(sp.ref->>'kernel_site', '') <> 'true') then
    raise exception 'site_kernel_attach: site % is not a static site without pooled data', p_site_id using errcode = '55000';
  end if;
  update public.sites s set backend_mode = 'dedicated', kernel_shard_id = v_kernel, updated_at = now()
   where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_site;
  insert into public.site_providers (site_id, tenant_id, kind, state, ref, updated_at)
  values (p_site_id, p_tenant_id, 'pooled_backend', 'created', jsonb_build_object('kernel_site', true, 'kernel_shard_id', v_kernel), now())
  on conflict (site_id, kind) do update
    set state = 'created', ref = jsonb_build_object('kernel_site', true, 'kernel_shard_id', v_kernel),
        scheduled_delete_at = null, updated_at = now();
  update public.site_kernel_provisions k set state = 'attached', kernel_shard_id = v_kernel, lease_id = null, lease_until = null,
         attached_at = now(), last_error = null, updated_at = now()
   where k.site_id = p_site_id;
  return v_site;
end $$;

revoke all on function public.site_kernel_attach(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_kernel_attach(uuid, uuid, uuid) to service_role;

create or replace function public.site_backend_dedicate_static_reserve(
  p_tenant_id uuid,
  p_site_id   uuid
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site public.sites;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_backend_dedicate_static_reserve: tenant_id and site_id are required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_backend_dedicate_static_reserve: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_site.status in ('deleting', 'deleted', 'failed', 'fell_back_old') then
    raise exception 'site_backend_dedicate_static_reserve: site % is %', p_site_id, v_site.status using errcode = '55000';
  end if;
  if exists (select 1 from public.site_kernel_provisions k where k.site_id = p_site_id) then
    raise exception 'site_backend_dedicate_static_reserve: site % is being set up on its own database', p_site_id using errcode = '55000';
  end if;
  if v_site.backend_mode = 'dedicated' then
    return;
  end if;
  insert into public.site_providers (site_id, tenant_id, kind, state, ref, updated_at)
  values (p_site_id, p_tenant_id, 'supabase_project', 'claimed', jsonb_build_object('legacy_dedicated', true), now())
  on conflict (site_id, kind) do update
    set ref = public.site_providers.ref || jsonb_build_object('legacy_dedicated', true), updated_at = now()
  where public.site_providers.tenant_id = p_tenant_id;
end $$;

revoke all on function public.site_backend_dedicate_static_reserve(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_backend_dedicate_static_reserve(uuid, uuid) to service_role;

create or replace function public.site_backend_place(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_env       text
) returns table (shard_id uuid, project_ref text, url text, placed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site  public.sites;
  v_shard public.site_shards;
  v_try   integer := 0;
begin
  if p_tenant_id is null or p_site_id is null or p_env is null then
    raise exception 'site_backend_place: tenant_id, site_id and env are required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_backend_place: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_site.status in ('failed', 'fell_back_old', 'deleting', 'deleted') then
    raise exception 'site_backend_place: site % is %', p_site_id, v_site.status using errcode = '55000';
  end if;
  if v_site.backend_mode = 'dedicated' then
    raise exception 'site_backend_place: site % has a dedicated database', p_site_id using errcode = '42501';
  end if;
  if exists (select 1 from public.site_kernel_provisions k where k.site_id = p_site_id) then
    raise exception 'site_backend_place: site % is being set up on its own database', p_site_id using errcode = '42501';
  end if;

  if v_site.shard_id is not null then
    select * into v_shard from public.site_shards sh where sh.id = v_site.shard_id;
    if v_shard.env <> p_env then
      raise exception 'site_backend_place: site % is on a shard of another env', p_site_id using errcode = '42501';
    end if;
    return query select v_shard.id, v_shard.project_ref, v_shard.url, false;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('site_backend_place:' || p_env));

  loop
    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'site_backend_place: no shard capacity in %', p_env using errcode = '53400';
    end if;
    select * into v_shard from public.site_shards sh
     where sh.env = p_env and sh.state = 'open' and sh.provision_step = 'done'
       and sh.project_ref is not null and sh.url is not null
       and sh.site_count < sh.max_sites
       and public.site_shard_load(sh) < sh.fill_ratio
     order by public.site_shard_load(sh), sh.created_at, sh.id
     limit 1
     for update;
    if not found then
      if not exists (select 1 from public.site_shards sh
                      where sh.env = p_env and sh.state = 'open' and sh.provision_step = 'done'
                        and sh.project_ref is not null and sh.url is not null
                        and sh.site_count < sh.max_sites
                        and public.site_shard_load(sh) < sh.fill_ratio) then
        raise exception 'site_backend_place: no shard capacity in %', p_env using errcode = '53400';
      end if;
      continue;
    end if;
    update public.site_shards sh set site_count = sh.site_count + 1, updated_at = now()
     where sh.id = v_shard.id and sh.state = 'open' and sh.site_count < sh.max_sites
    returning * into v_shard;
    exit when found;
  end loop;

  update public.sites s set shard_id = v_shard.id, backend_mode = 'pooled', updated_at = now()
   where s.id = p_site_id and s.tenant_id = p_tenant_id;

  insert into public.site_providers (site_id, tenant_id, kind, state, ref, updated_at)
  values (p_site_id, p_tenant_id, 'pooled_backend', 'created', jsonb_build_object('shard_id', v_shard.id), now())
  on conflict (site_id, kind) do update
    set state = 'created', ref = excluded.ref, scheduled_delete_at = null, updated_at = now();

  return query select v_shard.id, v_shard.project_ref, v_shard.url, true;
end $$;

revoke all on function public.site_backend_place(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_backend_place(uuid, uuid, text) to service_role;

commit;
