
begin;

alter table public.site_shards add column if not exists purpose text not null default 'pool';
alter table public.site_shards drop constraint if exists site_shards_purpose_check;
alter table public.site_shards add constraint site_shards_purpose_check
  check (purpose in ('pool', 'validation'));
alter table public.site_shards drop constraint if exists site_shards_validation_never_open;
alter table public.site_shards add constraint site_shards_validation_never_open
  check (purpose <> 'validation' or (state <> 'open' and dedicated_site_id is null));
create index if not exists site_shards_validation_idx on public.site_shards (env, region)
  where purpose = 'validation' and state = 'full';

create or replace function public.site_shard_validation_ready(p_id uuid)
returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.site_shards;
begin
  if p_id is null then
    raise exception 'site_shard_validation_ready: id is required' using errcode = '22023';
  end if;
  select * into v_row from public.site_shards s where s.id = p_id for update;
  if not found then
    raise exception 'site_shard_validation_ready: shard % not found', p_id using errcode = 'P0002';
  end if;
  if v_row.purpose <> 'validation' then
    raise exception 'site_shard_validation_ready: shard % is not a validation shard', v_row.name using errcode = '42501';
  end if;
  if v_row.state = 'full' then
    return v_row;
  end if;
  if v_row.state <> 'provisioning' or v_row.provision_step is distinct from 'done'
     or v_row.project_ref is null or v_row.url is null then
    raise exception 'site_shard_validation_ready: shard % is % (step %), not fully provisioned',
      v_row.name, v_row.state, coalesce(v_row.provision_step, 'none') using errcode = '55000';
  end if;
  update public.site_shards s set state = 'full', updated_at = now() where s.id = p_id returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_shard_validation_ready(uuid) from public, anon, authenticated;
grant execute on function public.site_shard_validation_ready(uuid) to service_role;

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
    if v_shard.purpose <> 'pool' then
      raise exception 'site_backend_place: site % is bound to a % shard', p_site_id, v_shard.purpose using errcode = '42501';
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
     where sh.env = p_env and sh.purpose = 'pool' and sh.state = 'open' and sh.provision_step = 'done'
       and sh.project_ref is not null and sh.url is not null
       and sh.site_count < sh.max_sites
       and public.site_shard_load(sh) < sh.fill_ratio
     order by public.site_shard_load(sh), sh.created_at, sh.id
     limit 1
     for update;
    if not found then
      if not exists (select 1 from public.site_shards sh
                      where sh.env = p_env and sh.purpose = 'pool' and sh.state = 'open' and sh.provision_step = 'done'
                        and sh.project_ref is not null and sh.url is not null
                        and sh.site_count < sh.max_sites
                        and public.site_shard_load(sh) < sh.fill_ratio) then
        raise exception 'site_backend_place: no shard capacity in %', p_env using errcode = '53400';
      end if;
      continue;
    end if;
    update public.site_shards sh set site_count = sh.site_count + 1, updated_at = now()
     where sh.id = v_shard.id and sh.state = 'open' and sh.purpose = 'pool' and sh.site_count < sh.max_sites
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
  if v_row.state = 'open' and v_load >= v_row.fill_ratio and v_row.dedicated_site_id is null and v_row.purpose = 'pool' then
    update public.site_shards s set state = 'full', updated_at = now() where s.id = p_id returning * into v_row;
  elsif v_row.state = 'full' and v_load < v_row.fill_ratio * 0.9 and v_row.dedicated_site_id is null and v_row.purpose = 'pool' then
    update public.site_shards s set state = 'open', updated_at = now() where s.id = p_id returning * into v_row;
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_record_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_shard_record_metrics(uuid, jsonb) to service_role;

drop function if exists public.site_shard_autoprov_claim(text, text, integer, boolean, text, text, integer);
create or replace function public.site_shard_autoprov_claim(
  p_env               text,
  p_source            text,
  p_max_per_day       integer,
  p_override          boolean,
  p_actor             text,
  p_region            text,
  p_min_retry_seconds integer,
  p_purpose           text default 'pool'
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_state   public.site_shard_autoprov;
  v_day     date := (now() at time zone 'utc')::date;
  v_prov    public.site_shards;
  v_created integer;
  v_seq     integer;
  v_n       integer;
  v_name    text;
  v_shard   public.site_shards;
  v_canary  boolean;
  v_id      uuid;
  v_max     integer;
  v_purpose text := coalesce(p_purpose, 'pool');
begin
  if p_env is null or p_env not in ('prod', 'dev') or p_source is null or p_source not in ('auto', 'staff') then
    raise exception 'site_shard_autoprov_claim: env prod|dev and source auto|staff are required' using errcode = '22023';
  end if;
  if p_region is null or p_region !~ '^[a-z]{2}-[a-z]+-[0-9]$' then
    raise exception 'site_shard_autoprov_claim: bad region' using errcode = '22023';
  end if;
  if v_purpose not in ('pool', 'validation') then
    raise exception 'site_shard_autoprov_claim: purpose pool|validation' using errcode = '22023';
  end if;
  v_max := least(greatest(coalesce(p_max_per_day, 0), 0), 10);
  if p_source = 'staff' and coalesce(p_override, false) then
    v_max := 25;
  end if;

  insert into public.site_shard_autoprov (env) values (p_env) on conflict (env) do nothing;
  select * into v_state from public.site_shard_autoprov a where a.env = p_env for update;

  if p_source = 'auto' and v_state.paused then
    return jsonb_build_object('action', 'none', 'reason', 'paused', 'paused_reason', v_state.paused_reason);
  end if;

  v_seq := coalesce((select max(l.seq) from public.site_shard_autoprov_ledger l where l.env = p_env and l.day = v_day), 0) + 1;

  select * into v_prov from public.site_shards s
   where s.env = p_env and s.state = 'provisioning' and s.dedicated_site_id is null
     and s.name ~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$'
   order by s.created_at, s.id
   limit 1;
  if v_prov.id is not null then
    if not exists (select 1 from public.site_shard_autoprov_ledger l where l.env = p_env and l.shard_name = v_prov.name and l.kind = 'create') then
      return jsonb_build_object('action', 'none', 'reason', 'in_progress_manual', 'shard_name', v_prov.name);
    end if;
    if p_source = 'auto' and v_state.last_attempt_at is not null
       and v_state.last_attempt_at > now() - make_interval(secs => greatest(coalesce(p_min_retry_seconds, 0), 0)) then
      return jsonb_build_object('action', 'none', 'reason', 'backoff', 'shard_name', v_prov.name);
    end if;
    insert into public.site_shard_autoprov_ledger (env, day, seq, kind, source, cap_override, actor, shard_id, shard_name)
    values (p_env, v_day, v_seq, 'resume', p_source, false, left(p_actor, 200), v_prov.id, v_prov.name)
    returning id into v_id;
    update public.site_shard_autoprov set last_attempt_at = now(), updated_at = now() where env = p_env;
    return jsonb_build_object('action', 'resume', 'ledger_id', v_id, 'day', v_day, 'seq', v_seq,
      'shard_name', v_prov.name, 'region', v_prov.region, 'canary', v_prov.is_canary, 'purpose', v_prov.purpose);
  end if;

  select count(*) into v_created from public.site_shard_autoprov_ledger l
   where l.env = p_env and l.day = v_day and l.kind = 'create';
  if v_created >= v_max then
    return jsonb_build_object('action', 'none', 'reason', 'cap', 'created_today', v_created, 'cap', v_max);
  end if;

  select coalesce(max((substring(s.name from '([0-9]+)$'))::int), 0) + 1 into v_n
    from public.site_shards s
   where s.env = p_env and s.name ~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$';
  if v_n > 999999 then
    raise exception 'site_shard_autoprov_claim: shard numbers exhausted in %', p_env using errcode = '54000';
  end if;
  v_name := 'zavi-shard-' || p_env || '-' || v_n;
  v_canary := v_purpose = 'pool' and not exists (select 1 from public.site_shards s
                           where s.env = p_env and s.state <> 'retired' and s.dedicated_site_id is null
                             and s.purpose = 'pool');
  insert into public.site_shards (env, name, region, is_canary, purpose)
  values (p_env, v_name, p_region, v_canary, v_purpose)
  returning * into v_shard;
  insert into public.site_shard_autoprov_ledger (env, day, seq, kind, source, cap_override, actor, shard_id, shard_name)
  values (p_env, v_day, v_seq, 'create', p_source, p_source = 'staff' and coalesce(p_override, false) and v_created >= least(greatest(coalesce(p_max_per_day, 0), 0), 10),
          left(p_actor, 200), v_shard.id, v_name)
  returning id into v_id;
  update public.site_shard_autoprov set last_attempt_at = now(), updated_at = now() where env = p_env;
  return jsonb_build_object('action', 'create', 'ledger_id', v_id, 'day', v_day, 'seq', v_seq,
    'shard_name', v_name, 'n', v_n, 'region', p_region, 'canary', v_canary, 'created_today', v_created + 1,
    'purpose', v_purpose);
end $$;

revoke all on function public.site_shard_autoprov_claim(text, text, integer, boolean, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.site_shard_autoprov_claim(text, text, integer, boolean, text, text, integer, text) to service_role;

create table if not exists public.site_test_sites (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  live_site_id         uuid not null,
  env                  text not null check (env in ('prod', 'dev')),
  shard_id             uuid not null references public.site_shards (id) on delete restrict,
  preview_host         text not null check (preview_host ~ '^[a-z2-7]{26}\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
                                            and length(preview_host) <= 253),
  deploy_id            text not null check (deploy_id ~ '^d[0-9a-z]{9}-[0-9a-f]{8}$'),
  state                text not null default 'creating'
    check (state in ('creating', 'active', 'destroying', 'destroyed')),
  manifest_hash        text check (manifest_hash is null or length(manifest_hash) <= 200),
  expires_at           timestamptz not null,
  attempts             integer not null default 0 check (attempts >= 0),
  last_error           text check (last_error is null or length(last_error) <= 500),
  destroy_reason       text check (destroy_reason is null or length(destroy_reason) <= 100),
  created_at           timestamptz not null default now(),
  activated_at         timestamptz,
  destroy_requested_at timestamptz,
  destroyed_at         timestamptz,
  updated_at           timestamptz not null default now()
);
create unique index if not exists site_test_sites_host_uq on public.site_test_sites (preview_host);
create index if not exists site_test_sites_open_idx on public.site_test_sites (env, expires_at) where state <> 'destroyed';
create index if not exists site_test_sites_live_idx on public.site_test_sites (live_site_id) where state <> 'destroyed';
create index if not exists site_test_sites_shard_idx on public.site_test_sites (shard_id) where state <> 'destroyed';

alter table public.site_test_sites enable row level security;
revoke all on public.site_test_sites from public, anon, authenticated;

create or replace function public.site_test_site_create(
  p_tenant_id    uuid,
  p_live_site_id uuid,
  p_env          text,
  p_region       text,
  p_preview_host text,
  p_deploy_id    text,
  p_ttl_seconds  integer
) returns table (id uuid, shard_id uuid, project_ref text, url text, expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site  public.sites;
  v_shard public.site_shards;
  v_id    uuid;
  v_ttl   integer := least(greatest(coalesce(p_ttl_seconds, 900), 300), 3600);
  v_exp   timestamptz;
begin
  if p_tenant_id is null or p_live_site_id is null or p_env is null or p_env not in ('prod', 'dev')
     or p_preview_host is null or p_deploy_id is null then
    raise exception 'site_test_site_create: tenant, live site, env, preview host and deploy id are required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_live_site_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception 'site_test_site_create: site % not found for tenant %', p_live_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_site.status in ('failed', 'fell_back_old', 'deleting', 'deleted') then
    raise exception 'site_test_site_create: site % is %', p_live_site_id, v_site.status using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('site_test_site_place:' || p_env));
  if (select count(*) from public.site_test_sites t where t.live_site_id = p_live_site_id and t.state <> 'destroyed') >= 8 then
    raise exception 'site_test_site_create: site % already has 8 test sites alive', p_live_site_id using errcode = '54000';
  end if;
  select * into v_shard from public.site_shards sh
   where sh.env = p_env and sh.purpose = 'validation' and sh.state = 'full' and sh.provision_step = 'done'
     and sh.project_ref is not null and sh.url is not null
     and sh.site_count < sh.max_sites
     and public.site_shard_load(sh) < sh.fill_ratio
   order by (sh.region = coalesce(p_region, '')) desc, public.site_shard_load(sh), sh.created_at, sh.id
   limit 1
   for update;
  if not found then
    raise exception 'site_test_site_create: no validation capacity in %', p_env using errcode = '53400';
  end if;
  update public.site_shards sh set site_count = sh.site_count + 1, updated_at = now()
   where sh.id = v_shard.id and sh.purpose = 'validation' and sh.site_count < sh.max_sites;
  if not found then
    raise exception 'site_test_site_create: no validation capacity in %', p_env using errcode = '53400';
  end if;

  loop
    v_id := gen_random_uuid();
    exit when not exists (select 1 from public.sites s where s.id = v_id);
  end loop;
  v_exp := now() + make_interval(secs => v_ttl);
  insert into public.site_test_sites (id, tenant_id, live_site_id, env, shard_id, preview_host, deploy_id, expires_at)
  values (v_id, p_tenant_id, p_live_site_id, p_env, v_shard.id, lower(p_preview_host), p_deploy_id, v_exp);
  return query select v_id, v_shard.id, v_shard.project_ref, v_shard.url, v_exp;
end $$;

revoke all on function public.site_test_site_create(uuid, uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.site_test_site_create(uuid, uuid, text, text, text, text, integer) to service_role;

create or replace function public.site_test_site_get(
  p_tenant_id uuid,
  p_id        uuid
) returns table (id uuid, tenant_id uuid, live_site_id uuid, env text, shard_id uuid, project_ref text, url text,
                 preview_host text, deploy_id text, state text, expires_at timestamptz, attempts integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select t.id, t.tenant_id, t.live_site_id, t.env, t.shard_id, sh.project_ref, sh.url,
           t.preview_host, t.deploy_id, t.state, t.expires_at, t.attempts
      from public.site_test_sites t join public.site_shards sh on sh.id = t.shard_id
     where t.id = p_id and t.tenant_id = p_tenant_id;
end $$;

revoke all on function public.site_test_site_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_test_site_get(uuid, uuid) to service_role;

create or replace function public.site_test_site_activate(
  p_tenant_id     uuid,
  p_id            uuid,
  p_manifest_hash text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  update public.site_test_sites t
     set state = 'active', activated_at = now(), manifest_hash = left(p_manifest_hash, 200), updated_at = now()
   where t.id = p_id and t.tenant_id = p_tenant_id and t.state = 'creating' and t.expires_at > now();
  if not found then
    raise exception 'site_test_site_activate: test site % is not creating (or has expired)', p_id using errcode = '55000';
  end if;
  return true;
end $$;

revoke all on function public.site_test_site_activate(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_test_site_activate(uuid, uuid, text) to service_role;

create or replace function public.site_test_site_destroy_begin(
  p_tenant_id uuid,
  p_id        uuid,
  p_reason    text
) returns table (id uuid, tenant_id uuid, live_site_id uuid, env text, shard_id uuid, project_ref text, url text,
                 preview_host text, deploy_id text, state text, expires_at timestamptz, attempts integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  update public.site_test_sites t
     set state = 'destroying',
         destroy_requested_at = coalesce(t.destroy_requested_at, now()),
         destroy_reason = coalesce(t.destroy_reason, left(coalesce(p_reason, 'requested'), 100)),
         updated_at = now()
   where t.id = p_id and t.tenant_id = p_tenant_id and t.state in ('creating', 'active');
  return query select * from public.site_test_site_get(p_tenant_id, p_id);
end $$;

revoke all on function public.site_test_site_destroy_begin(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_test_site_destroy_begin(uuid, uuid, text) to service_role;

create or replace function public.site_test_site_destroyed(
  p_tenant_id uuid,
  p_id        uuid
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_shard uuid;
begin
  update public.site_test_sites t
     set state = 'destroyed', destroyed_at = now(), last_error = null, updated_at = now()
   where t.id = p_id and t.tenant_id = p_tenant_id and t.state = 'destroying'
  returning t.shard_id into v_shard;
  if not found then
    return false;
  end if;
  update public.site_shards sh set site_count = greatest(sh.site_count - 1, 0), updated_at = now()
   where sh.id = v_shard;
  return true;
end $$;

revoke all on function public.site_test_site_destroyed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_test_site_destroyed(uuid, uuid) to service_role;

create or replace function public.site_test_site_failed(
  p_tenant_id uuid,
  p_id        uuid,
  p_error     text
) returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_n integer;
begin
  update public.site_test_sites t
     set attempts = t.attempts + 1, last_error = left(coalesce(p_error, 'unknown'), 500), updated_at = now()
   where t.id = p_id and t.tenant_id = p_tenant_id and t.state <> 'destroyed'
  returning t.attempts into v_n;
  return coalesce(v_n, 0);
end $$;

revoke all on function public.site_test_site_failed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_test_site_failed(uuid, uuid, text) to service_role;

create or replace function public.site_test_site_due(
  p_env   text,
  p_limit integer
) returns table (id uuid, tenant_id uuid, state text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select t.id, t.tenant_id, t.state from public.site_test_sites t
     where t.env = p_env and t.state <> 'destroyed'
       and ((t.state = 'active' and t.expires_at <= now())
            or (t.state = 'creating' and t.created_at < now() - interval '30 minutes')
            or (t.state = 'destroying' and t.updated_at < now() - interval '2 minutes'))
     order by t.expires_at, t.id
     limit least(greatest(coalesce(p_limit, 50), 1), 500);
end $$;

revoke all on function public.site_test_site_due(text, integer) from public, anon, authenticated;
grant execute on function public.site_test_site_due(text, integer) to service_role;

create or replace function public.site_test_site_stats(p_env text)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'creating',   count(*) filter (where t.state = 'creating'),
    'active',     count(*) filter (where t.state = 'active'),
    'destroying', count(*) filter (where t.state = 'destroying'),
    'overdue',    count(*) filter (where (t.state <> 'creating' and t.expires_at < now() - interval '15 minutes')
                                      or (t.state = 'creating' and t.created_at < now() - interval '45 minutes')),
    'stuck',      count(*) filter (where t.state <> 'destroyed' and t.attempts >= 3),
    'leaked',     count(*) filter (where t.state <> 'destroyed'
                                     and (t.attempts >= 3
                                          or (t.state <> 'creating' and t.expires_at < now() - interval '15 minutes')
                                          or (t.state = 'creating' and t.created_at < now() - interval '45 minutes')))
  )
  from public.site_test_sites t
  where t.env = p_env and t.state <> 'destroyed'
$$;

revoke all on function public.site_test_site_stats(text) from public, anon, authenticated;
grant execute on function public.site_test_site_stats(text) to service_role;

create or replace function public.site_test_site_states(p_ids uuid[])
returns table (id uuid, tenant_id uuid, state text)
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select t.id, t.tenant_id, t.state from public.site_test_sites t
   where t.id = any (coalesce(p_ids, array[]::uuid[]))
$$;

revoke all on function public.site_test_site_states(uuid[]) from public, anon, authenticated;
grant execute on function public.site_test_site_states(uuid[]) to service_role;

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
  is_test boolean
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select s.id, s.hostname, s.label, s.status, s.shard_id, s.backend_mode, s.kernel_shard_id, false
      from public.sites s
     where s.id = p_site_id
     limit 1;
  if found then
    return;
  end if;
  return query
    select t.id, t.preview_host, 'Test site'::text,
           case t.state when 'creating' then 'provisioning' else 'live' end,
           t.shard_id, 'pooled'::text, null::uuid, true
      from public.site_test_sites t
      join public.site_shards sh on sh.id = t.shard_id and sh.purpose = 'validation'
     where t.id = p_site_id and t.state in ('creating', 'active') and t.expires_at > now()
     limit 1;
end $$;

revoke all on function public.site_auth_directory(uuid) from public, anon, authenticated;
grant execute on function public.site_auth_directory(uuid) to service_role;

create or replace function public.site_is_validation(p_site_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.site_test_sites t where t.id = p_site_id)
     and not exists (select 1 from public.sites s where s.id = p_site_id)
$$;

revoke all on function public.site_is_validation(uuid) from public, anon, authenticated;
grant execute on function public.site_is_validation(uuid) to service_role;

commit;
