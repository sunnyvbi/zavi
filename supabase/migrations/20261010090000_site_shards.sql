
begin;

create table if not exists public.site_shards (
  id                 uuid primary key default gen_random_uuid(),
  env                text not null check (env in ('prod', 'dev')),
  name               text not null check (name ~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$'),
  project_ref        text check (project_ref ~ '^[a-z0-9]{8,40}$'),
  url                text,
  region             text not null check (region ~ '^[a-z]{2}-[a-z]+-[0-9]$'),
  state              text not null default 'provisioning'
    check (state in ('provisioning', 'open', 'full', 'draining', 'retired')),
  is_canary          boolean not null default false,
  schema_version     text check (schema_version ~ '^[0-9]{4}_[a-z0-9_]{1,60}$'),
  provision_step     text check (provision_step ~ '^[a-z_]{1,40}$'),
  max_sites          integer not null default 2000 check (max_sites between 1 and 1000000),
  site_count         integer not null default 0 check (site_count >= 0),
  m_records          bigint  not null default 0 check (m_records >= 0),
  m_bytes            bigint  not null default 0 check (m_bytes >= 0),
  m_requests_per_min integer not null default 0 check (m_requests_per_min >= 0),
  m_p95_ms           integer check (m_p95_ms >= 0),
  m_cpu_pct          numeric check (m_cpu_pct >= 0),
  m_connections      integer check (m_connections >= 0),
  m_auth_users       bigint  not null default 0 check (m_auth_users >= 0),
  m_sessions         bigint  not null default 0 check (m_sessions >= 0),
  m_emails_per_hour  integer not null default 0 check (m_emails_per_hour >= 0),
  metrics_at         timestamptz,
  lim_records          bigint  not null default 20000000   check (lim_records > 0),
  lim_bytes            bigint  not null default 6442450944 check (lim_bytes > 0),
  lim_requests_per_min integer not null default 30000      check (lim_requests_per_min > 0),
  lim_p95_ms           integer not null default 250        check (lim_p95_ms > 0),
  lim_cpu_pct          numeric not null default 70         check (lim_cpu_pct > 0),
  lim_connections      integer not null default 120        check (lim_connections > 0),
  lim_auth_users       bigint  not null default 2000000    check (lim_auth_users > 0),
  lim_sessions         bigint  not null default 4000000    check (lim_sessions > 0),
  lim_emails_per_hour  integer not null default 20000      check (lim_emails_per_hour > 0),
  fill_ratio         numeric not null default 0.8 check (fill_ratio > 0 and fill_ratio <= 1),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint site_shards_name_env check (name like 'zavi-shard-' || env || '-%'),
  constraint site_shards_url_matches_ref
    check (url is null or (project_ref is not null and url = 'https://' || project_ref || '.supabase.co')),
  constraint site_shards_open_needs_ref
    check (state in ('provisioning', 'retired') or (project_ref is not null and url is not null))
);

create unique index if not exists site_shards_name_uq on public.site_shards (name);
create unique index if not exists site_shards_ref_uq on public.site_shards (project_ref) where project_ref is not null;
create index if not exists site_shards_open_idx on public.site_shards (env, state) where state = 'open';

alter table public.site_shards enable row level security;
revoke all on public.site_shards from public, anon, authenticated;

alter table public.sites add column if not exists shard_id uuid references public.site_shards (id) on delete restrict;
alter table public.sites add column if not exists backend_mode text not null default 'dedicated';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sites_backend_mode_check'
                 and conrelid = 'public.sites'::regclass) then
    alter table public.sites add constraint sites_backend_mode_check
      check (backend_mode in ('static', 'pooled', 'dedicated'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sites_shard_matches_mode'
                 and conrelid = 'public.sites'::regclass) then
    alter table public.sites add constraint sites_shard_matches_mode
      check ((backend_mode = 'pooled') = (shard_id is not null));
  end if;
end $$;
create index if not exists sites_shard_idx on public.sites (shard_id) where shard_id is not null;

alter table public.sites add column if not exists host_version bigint not null default 0;
alter table public.sites add column if not exists gateway_binding jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sites_gateway_binding_shape'
                 and conrelid = 'public.sites'::regclass) then
    alter table public.sites add constraint sites_gateway_binding_shape check (
      gateway_binding is null or (
        jsonb_typeof(gateway_binding) = 'object'
        and gateway_binding ?& array['shard_id', 'shard_url', 'status', 'manifest_hash']
        and (gateway_binding - array['shard_id', 'shard_url', 'status', 'manifest_hash']) = '{}'::jsonb
        and gateway_binding->>'status' in ('active', 'paused', 'tombstoned')
        and coalesce(gateway_binding->>'shard_id', '') ~ '^[a-z0-9][a-z0-9-]{0,31}$'
        and coalesce(gateway_binding->>'shard_url', '') ~ '^https://[a-z0-9]{8,40}\.supabase\.co$'
        and jsonb_typeof(gateway_binding->'manifest_hash') = 'string'));
  end if;
end $$;

alter table public.site_providers drop constraint if exists site_providers_kind_check;
alter table public.site_providers add constraint site_providers_kind_check
  check (kind in ('github_repo', 'supabase_project', 'cloudflare_host', 'r2_prefix', 'pooled_backend'));

create or replace function public.site_shard_load(s public.site_shards) returns numeric
language sql immutable security definer
set search_path = pg_catalog, pg_temp as $$
  select greatest(
    s.site_count::numeric / s.max_sites,
    s.m_records::numeric / s.lim_records,
    s.m_bytes::numeric / s.lim_bytes,
    s.m_requests_per_min::numeric / s.lim_requests_per_min,
    coalesce(s.m_p95_ms, 0)::numeric / s.lim_p95_ms,
    coalesce(s.m_cpu_pct, 0) / s.lim_cpu_pct,
    coalesce(s.m_connections, 0)::numeric / s.lim_connections,
    s.m_auth_users::numeric / s.lim_auth_users,
    s.m_sessions::numeric / s.lim_sessions,
    s.m_emails_per_hour::numeric / s.lim_emails_per_hour
  )
$$;

revoke all on function public.site_shard_load(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_load(public.site_shards) to service_role;

create or replace function public.site_shard_register(
  p_env       text,
  p_name      text,
  p_region    text,
  p_is_canary boolean
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.site_shards;
begin
  if p_env is null or p_name is null or p_region is null then
    raise exception 'site_shard_register: env, name and region are required' using errcode = '22023';
  end if;
  insert into public.site_shards (env, name, region, is_canary)
  values (p_env, p_name, p_region, coalesce(p_is_canary, false))
  on conflict (name) do nothing;
  select * into v_row from public.site_shards s where s.name = p_name;
  if v_row.env <> p_env then
    raise exception 'site_shard_register: shard % exists in another env', p_name using errcode = '42501';
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_register(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.site_shard_register(text, text, text, boolean) to service_role;

create or replace function public.site_shard_update(
  p_id    uuid,
  p_patch jsonb
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_cur public.site_shards;
  v_row public.site_shards;
  v_bad text;
  v_to  text;
begin
  if p_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'site_shard_update: id and an object patch are required' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(p_patch) k
   where k <> all (array['project_ref', 'url', 'state', 'is_canary', 'schema_version', 'provision_step',
                         'max_sites', 'fill_ratio', 'lim_records', 'lim_bytes', 'lim_requests_per_min',
                         'lim_p95_ms', 'lim_cpu_pct', 'lim_connections', 'lim_auth_users', 'lim_sessions',
                         'lim_emails_per_hour'])
   limit 1;
  if v_bad is not null then
    raise exception 'site_shard_update: key % is not patchable', v_bad using errcode = '22023';
  end if;

  select * into v_cur from public.site_shards s where s.id = p_id for update;
  if not found then
    raise exception 'site_shard_update: shard % not found', p_id using errcode = 'P0002';
  end if;
  if p_patch ? 'project_ref' and v_cur.project_ref is not null
     and v_cur.project_ref is distinct from p_patch->>'project_ref' then
    raise exception 'site_shard_update: project_ref is write-once' using errcode = '42501';
  end if;
  if p_patch ? 'state' then
    v_to := p_patch->>'state';
    if v_to is distinct from v_cur.state and not (
         (v_cur.state = 'provisioning' and v_to in ('open', 'retired'))
      or (v_cur.state = 'open' and v_to in ('full', 'draining'))
      or (v_cur.state = 'full' and v_to in ('open', 'draining'))
      or (v_cur.state = 'draining' and v_to in ('open', 'retired'))) then
      raise exception 'site_shard_update: % -> % is not allowed', v_cur.state, v_to using errcode = '22023';
    end if;
    if v_cur.state = 'provisioning' and v_to = 'open'
       and coalesce(p_patch->>'provision_step', v_cur.provision_step) is distinct from 'done' then
      raise exception 'site_shard_update: shard is not fully provisioned' using errcode = '55000';
    end if;
    if v_to = 'retired' and v_cur.site_count > 0 then
      raise exception 'site_shard_update: shard still holds % site(s)', v_cur.site_count using errcode = '55000';
    end if;
  end if;

  update public.site_shards s set
    project_ref          = case when p_patch ? 'project_ref' then p_patch->>'project_ref' else s.project_ref end,
    url                  = case when p_patch ? 'url' then p_patch->>'url' else s.url end,
    state                = case when p_patch ? 'state' then p_patch->>'state' else s.state end,
    is_canary            = case when p_patch ? 'is_canary' then (p_patch->>'is_canary')::boolean else s.is_canary end,
    schema_version       = case when p_patch ? 'schema_version' then p_patch->>'schema_version' else s.schema_version end,
    provision_step       = case when p_patch ? 'provision_step' then p_patch->>'provision_step' else s.provision_step end,
    max_sites            = case when p_patch ? 'max_sites' then (p_patch->>'max_sites')::integer else s.max_sites end,
    fill_ratio           = case when p_patch ? 'fill_ratio' then (p_patch->>'fill_ratio')::numeric else s.fill_ratio end,
    lim_records          = case when p_patch ? 'lim_records' then (p_patch->>'lim_records')::bigint else s.lim_records end,
    lim_bytes            = case when p_patch ? 'lim_bytes' then (p_patch->>'lim_bytes')::bigint else s.lim_bytes end,
    lim_requests_per_min = case when p_patch ? 'lim_requests_per_min' then (p_patch->>'lim_requests_per_min')::integer else s.lim_requests_per_min end,
    lim_p95_ms           = case when p_patch ? 'lim_p95_ms' then (p_patch->>'lim_p95_ms')::integer else s.lim_p95_ms end,
    lim_cpu_pct          = case when p_patch ? 'lim_cpu_pct' then (p_patch->>'lim_cpu_pct')::numeric else s.lim_cpu_pct end,
    lim_connections      = case when p_patch ? 'lim_connections' then (p_patch->>'lim_connections')::integer else s.lim_connections end,
    lim_auth_users       = case when p_patch ? 'lim_auth_users' then (p_patch->>'lim_auth_users')::bigint else s.lim_auth_users end,
    lim_sessions         = case when p_patch ? 'lim_sessions' then (p_patch->>'lim_sessions')::bigint else s.lim_sessions end,
    lim_emails_per_hour  = case when p_patch ? 'lim_emails_per_hour' then (p_patch->>'lim_emails_per_hour')::integer else s.lim_emails_per_hour end,
    updated_at           = now()
  where s.id = p_id
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_shard_update(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_shard_update(uuid, jsonb) to service_role;

create or replace function public.site_shard_record_metrics(
  p_id               uuid,
  p_metrics          jsonb
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row  public.site_shards;
  v_load numeric;
  v_bad  text;
  m      jsonb := coalesce(p_metrics, '{}'::jsonb);
begin
  if p_id is null or jsonb_typeof(m) <> 'object' then
    raise exception 'site_shard_record_metrics: id and an object are required' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(m) k
   where k <> all (array['records', 'bytes', 'requests_per_min', 'p95_ms', 'cpu_pct', 'connections',
                         'auth_users', 'sessions', 'emails_per_hour'])
      or jsonb_typeof(m->k) not in ('number', 'null')
      or (jsonb_typeof(m->k) = 'number' and (m->>k)::numeric < 0)
   limit 1;
  if v_bad is not null then
    raise exception 'site_shard_record_metrics: bad metric %', v_bad using errcode = '22023';
  end if;
  update public.site_shards s set
    m_records          = coalesce((m->>'records')::bigint, s.m_records),
    m_bytes            = coalesce((m->>'bytes')::bigint, s.m_bytes),
    m_requests_per_min = coalesce((m->>'requests_per_min')::integer, s.m_requests_per_min),
    m_p95_ms           = coalesce((m->>'p95_ms')::integer, s.m_p95_ms),
    m_cpu_pct          = coalesce((m->>'cpu_pct')::numeric, s.m_cpu_pct),
    m_connections      = coalesce((m->>'connections')::integer, s.m_connections),
    m_auth_users       = coalesce((m->>'auth_users')::bigint, s.m_auth_users),
    m_sessions         = coalesce((m->>'sessions')::bigint, s.m_sessions),
    m_emails_per_hour  = coalesce((m->>'emails_per_hour')::integer, s.m_emails_per_hour),
    metrics_at         = now(),
    updated_at         = now()
  where s.id = p_id
  returning * into v_row;
  if not found then
    raise exception 'site_shard_record_metrics: shard % not found', p_id using errcode = 'P0002';
  end if;
  v_load := public.site_shard_load(v_row);
  if v_row.state = 'open' and v_load >= v_row.fill_ratio then
    update public.site_shards s set state = 'full', updated_at = now() where s.id = p_id returning * into v_row;
  elsif v_row.state = 'full' and v_load < v_row.fill_ratio * 0.9 then
    update public.site_shards s set state = 'open', updated_at = now() where s.id = p_id returning * into v_row;
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_record_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_shard_record_metrics(uuid, jsonb) to service_role;

create or replace function public.site_shard_list(p_env text)
returns setof public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_env is null then
    raise exception 'site_shard_list: env is required' using errcode = '22023';
  end if;
  return query select * from public.site_shards s where s.env = p_env order by s.created_at, s.id;
end $$;

revoke all on function public.site_shard_list(text) from public, anon, authenticated;
grant execute on function public.site_shard_list(text) to service_role;

create or replace function public.site_shard_get(p_id uuid)
returns setof public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query select * from public.site_shards s where s.id = p_id;
end $$;

revoke all on function public.site_shard_get(uuid) from public, anon, authenticated;
grant execute on function public.site_shard_get(uuid) to service_role;

create or replace function public.site_backend_init_static(
  p_tenant_id uuid,
  p_site_id   uuid
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_backend_init_static: tenant_id and site_id are required' using errcode = '22023';
  end if;
  select * into v_row from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_backend_init_static: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_row.backend_mode in ('static', 'pooled') then
    return v_row;
  end if;
  if v_row.status <> 'provisioning' or v_row.supabase_project_ref is not null
     or exists (select 1 from public.site_providers sp
                 where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = 'supabase_project') then
    raise exception 'site_backend_init_static: site % already has a dedicated database', p_site_id using errcode = '55000';
  end if;
  update public.sites s set backend_mode = 'static', updated_at = now()
   where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_backend_init_static(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_backend_init_static(uuid, uuid) to service_role;

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

create or replace function public.site_backend_release(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_to        text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site public.sites;
begin
  if p_tenant_id is null or p_site_id is null or p_to is null then
    raise exception 'site_backend_release: tenant_id, site_id and to are required' using errcode = '22023';
  end if;
  if p_to not in ('static', 'dedicated') then
    raise exception 'site_backend_release: invalid target %', p_to using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_backend_release: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_site.shard_id is null then
    return false;
  end if;
  update public.site_shards sh set site_count = greatest(sh.site_count - 1, 0), updated_at = now()
   where sh.id = v_site.shard_id;
  update public.sites s set shard_id = null, backend_mode = p_to, updated_at = now()
   where s.id = p_site_id and s.tenant_id = p_tenant_id;
  return true;
end $$;

revoke all on function public.site_backend_release(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_backend_release(uuid, uuid, text) to service_role;

create table if not exists public.site_shard_secrets (
  shard_id        uuid not null references public.site_shards (id) on delete cascade,
  name            text not null check (name in ('service_key', 'anon_key', 'broker_db_url', 'hook_secret')),
  vault_secret_id uuid not null,
  updated_at      timestamptz not null default now(),
  primary key (shard_id, name)
);
alter table public.site_shard_secrets enable row level security;
revoke all on public.site_shard_secrets from public, anon, authenticated;

create or replace function public.site_shard_secret_set(
  p_shard_id uuid,
  p_name     text,
  p_value    text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if p_shard_id is null or p_name is null or p_value is null
     or length(p_value) = 0 or length(p_value) > 4000 then
    raise exception 'site_shard_secret_set: shard, name and a 1..4000 char value are required' using errcode = '22023';
  end if;
  if p_name not in ('service_key', 'anon_key', 'broker_db_url', 'hook_secret') then
    raise exception 'site_shard_secret_set: unknown secret %', p_name using errcode = '22023';
  end if;
  if not exists (select 1 from public.site_shards sh where sh.id = p_shard_id) then
    raise exception 'site_shard_secret_set: shard % not found', p_shard_id using errcode = 'P0002';
  end if;
  select ss.vault_secret_id into v_old from public.site_shard_secrets ss
   where ss.shard_id = p_shard_id and ss.name = p_name for update;
  v_new := vault.create_secret(p_value);
  insert into public.site_shard_secrets (shard_id, name, vault_secret_id, updated_at)
  values (p_shard_id, p_name, v_new, now())
  on conflict (shard_id, name) do update set vault_secret_id = excluded.vault_secret_id, updated_at = now();
  if v_old is not null then
    delete from vault.secrets vs where vs.id = v_old;
  end if;
end $$;

revoke all on function public.site_shard_secret_set(uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_shard_secret_set(uuid, text, text) to service_role;

create or replace function public.site_shard_secret_get(
  p_shard_id uuid,
  p_name     text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v text;
begin
  select ds.decrypted_secret into v
    from public.site_shard_secrets ss
    join vault.decrypted_secrets ds on ds.id = ss.vault_secret_id
   where ss.shard_id = p_shard_id and ss.name = p_name;
  return v;
end $$;

revoke all on function public.site_shard_secret_get(uuid, text) from public, anon, authenticated;
grant execute on function public.site_shard_secret_get(uuid, text) to service_role;

create table if not exists public.site_shard_migrations (
  shard_id   uuid not null references public.site_shards (id) on delete cascade,
  version    text not null check (version ~ '^[0-9]{4}_[a-z0-9_]{1,60}$'),
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now(),
  primary key (shard_id, version)
);
alter table public.site_shard_migrations enable row level security;
revoke all on public.site_shard_migrations from public, anon, authenticated;

create or replace function public.site_shard_migration_record(
  p_shard_id uuid,
  p_version  text,
  p_sha256   text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v text;
begin
  if p_shard_id is null or p_version is null or p_sha256 is null then
    raise exception 'site_shard_migration_record: shard, version and sha256 are required' using errcode = '22023';
  end if;
  insert into public.site_shard_migrations (shard_id, version, sha256)
  values (p_shard_id, p_version, p_sha256)
  on conflict (shard_id, version) do nothing;
  select m.sha256 into v from public.site_shard_migrations m where m.shard_id = p_shard_id and m.version = p_version;
  return v;
end $$;

revoke all on function public.site_shard_migration_record(uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_shard_migration_record(uuid, text, text) to service_role;

create or replace function public.site_host_bump(
  p_tenant_id   uuid,
  p_site_id     uuid,
  p_set_binding boolean,
  p_binding     jsonb
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
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
  update public.sites s set
    host_version    = s.host_version + 1,
    gateway_binding = case when coalesce(p_set_binding, false) then p_binding else s.gateway_binding end,
    updated_at      = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_host_bump(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.site_host_bump(uuid, uuid, boolean, jsonb) to service_role;

commit;
