
begin;

alter table public.site_shards add column if not exists m_db_at timestamptz;
alter table public.site_shards add column if not exists m_gateway_at timestamptz;
alter table public.site_shards add column if not exists m_cpu_at timestamptz;
alter table public.site_shards add column if not exists m_cpu_sample jsonb;
alter table public.site_shards add column if not exists metrics_max_age_s integer not null default 1800;
alter table public.site_shards add column if not exists placement_paused_until timestamptz;
alter table public.site_shards add column if not exists placement_paused_reason text;
alter table public.site_shards add column if not exists placement_paused_at timestamptz;
alter table public.site_shards add column if not exists m_alerted jsonb not null default '{}'::jsonb;
alter table public.site_shards add column if not exists m_unconfigured text[] not null default '{}';
alter table public.site_shards add column if not exists m_unconfigured_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'site_shards_metrics_max_age_range'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_metrics_max_age_range
      check (metrics_max_age_s between 60 and 86400);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_shards_cpu_sample_shape'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_cpu_sample_shape
      check (m_cpu_sample is null or jsonb_typeof(m_cpu_sample) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_shards_paused_reason_len'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_paused_reason_len
      check (placement_paused_reason is null or length(placement_paused_reason) <= 300);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_shards_unconfigured_sources'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_unconfigured_sources
      check (m_unconfigured <@ array['gateway', 'cpu']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_shards_alerted_shape'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_alerted_shape
      check (jsonb_typeof(m_alerted) = 'object');
  end if;
end $$;

create table if not exists public.site_shard_placements (
  id        bigint generated always as identity primary key,
  env       text not null check (env in ('prod', 'dev')),
  shard_id  uuid references public.site_shards (id) on delete set null,
  placed_at timestamptz not null default now()
);
create index if not exists site_shard_placements_env_idx on public.site_shard_placements (env, placed_at desc);

alter table public.site_shard_placements enable row level security;
revoke all on public.site_shard_placements from public, anon, authenticated;

create or replace function public.site_shard_metrics_fresh(s public.site_shards) returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select case
    when s.m_db_at is null and s.m_gateway_at is null and s.m_cpu_at is null
      then s.site_count < 25 and s.created_at > now() - interval '24 hours'
    else
      coalesce(s.m_db_at > now() - make_interval(secs => s.metrics_max_age_s), false)
      and ('gateway' = any(s.m_unconfigured) or coalesce(s.m_gateway_at > now() - make_interval(secs => s.metrics_max_age_s), false))
      and ('cpu' = any(s.m_unconfigured) or coalesce(s.m_cpu_at > now() - make_interval(secs => s.metrics_max_age_s), false))
  end
$$;

revoke all on function public.site_shard_metrics_fresh(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_metrics_fresh(public.site_shards) to service_role;

create or replace function public.site_shard_load(s public.site_shards) returns numeric
language sql immutable security definer
set search_path = pg_catalog, pg_temp as $$
  select greatest(
    s.site_count::numeric / s.max_sites,
    s.m_records::numeric / s.lim_records,
    s.m_bytes::numeric / s.lim_bytes,
    case when 'gateway' = any(s.m_unconfigured) then 0 else s.m_requests_per_min::numeric / s.lim_requests_per_min end,
    case when 'gateway' = any(s.m_unconfigured) then 0 else coalesce(s.m_p95_ms, 0)::numeric / s.lim_p95_ms end,
    case when 'cpu' = any(s.m_unconfigured) then 0 else coalesce(s.m_cpu_pct, 0) / s.lim_cpu_pct end,
    coalesce(s.m_connections, 0)::numeric / s.lim_connections,
    s.m_auth_users::numeric / s.lim_auth_users,
    s.m_sessions::numeric / s.lim_sessions,
    s.m_emails_per_hour::numeric / s.lim_emails_per_hour
  )
$$;

revoke all on function public.site_shard_load(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_load(public.site_shards) to service_role;

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
  v_at   jsonb;
  v_db   timestamptz;
  v_gw   timestamptz;
  v_cpu  timestamptz;
  v_sweep timestamptz;
begin
  if p_id is null or jsonb_typeof(m) <> 'object' then
    raise exception 'site_shard_record_metrics: id and an object are required' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(m) k
   where k not in ('measured_at', 'cpu_sample', 'unconfigured')
     and (k <> all (array['records', 'bytes', 'requests_per_min', 'p95_ms', 'cpu_pct', 'connections',
                          'auth_users', 'sessions', 'emails_per_hour'])
          or jsonb_typeof(m->k) not in ('number', 'null')
          or (jsonb_typeof(m->k) = 'number' and (m->>k)::numeric < 0))
   limit 1;
  if v_bad is not null then
    raise exception 'site_shard_record_metrics: bad metric %', v_bad using errcode = '22023';
  end if;
  v_at := m->'measured_at';
  if v_at is not null and jsonb_typeof(v_at) <> 'null' then
    if jsonb_typeof(v_at) <> 'object' then
      raise exception 'site_shard_record_metrics: measured_at must be an object' using errcode = '22023';
    end if;
    select k into v_bad from jsonb_object_keys(v_at) k
     where k not in ('db', 'gateway', 'cpu', 'sweep') or jsonb_typeof(v_at->k) <> 'string' limit 1;
    if v_bad is not null then
      raise exception 'site_shard_record_metrics: bad measured_at key %', v_bad using errcode = '22023';
    end if;
    begin
      v_db  := case when v_at ? 'db' then least((v_at->>'db')::timestamptz, now()) end;
      v_gw  := case when v_at ? 'gateway' then least((v_at->>'gateway')::timestamptz, now()) end;
      v_cpu := case when v_at ? 'cpu' then least((v_at->>'cpu')::timestamptz, now()) end;
      v_sweep := case when v_at ? 'sweep' then least((v_at->>'sweep')::timestamptz, now()) end;
    exception when others then
      raise exception 'site_shard_record_metrics: measured_at is not a timestamp' using errcode = '22007';
    end;
  end if;
  if m ? 'unconfigured' and (jsonb_typeof(m->'unconfigured') <> 'array'
     or exists (select 1 from jsonb_array_elements(m->'unconfigured') e
                 where jsonb_typeof(e) <> 'string' or e #>> '{}' not in ('gateway', 'cpu'))) then
    raise exception 'site_shard_record_metrics: unconfigured must be an array of gateway | cpu' using errcode = '22023';
  end if;
  if m ? 'cpu_sample' and jsonb_typeof(m->'cpu_sample') not in ('object', 'null') then
    raise exception 'site_shard_record_metrics: cpu_sample must be an object' using errcode = '22023';
  end if;
  update public.site_shards s set
    m_records          = case when (v_db is null and s.m_db_at is not null) or v_db < coalesce(s.m_db_at, '-infinity') then s.m_records else coalesce((m->>'records')::bigint, s.m_records) end,
    m_bytes            = case when (v_db is null and s.m_db_at is not null) or v_db < coalesce(s.m_db_at, '-infinity') then s.m_bytes else coalesce((m->>'bytes')::bigint, s.m_bytes) end,
    m_requests_per_min = case when (v_gw is null and s.m_gateway_at is not null) or v_gw < coalesce(s.m_gateway_at, '-infinity') then s.m_requests_per_min else coalesce((m->>'requests_per_min')::integer, s.m_requests_per_min) end,
    m_p95_ms           = case when (v_gw is null and s.m_gateway_at is not null) or v_gw < coalesce(s.m_gateway_at, '-infinity') then s.m_p95_ms else coalesce((m->>'p95_ms')::integer, s.m_p95_ms) end,
    m_cpu_pct          = case when (v_cpu is null and s.m_cpu_at is not null) or v_cpu < coalesce(s.m_cpu_at, '-infinity') then s.m_cpu_pct else coalesce((m->>'cpu_pct')::numeric, s.m_cpu_pct) end,
    m_connections      = case when (v_db is null and s.m_db_at is not null) or v_db < coalesce(s.m_db_at, '-infinity') then s.m_connections else coalesce((m->>'connections')::integer, s.m_connections) end,
    m_auth_users       = case when (v_db is null and s.m_db_at is not null) or v_db < coalesce(s.m_db_at, '-infinity') then s.m_auth_users else coalesce((m->>'auth_users')::bigint, s.m_auth_users) end,
    m_sessions         = case when (v_db is null and s.m_db_at is not null) or v_db < coalesce(s.m_db_at, '-infinity') then s.m_sessions else coalesce((m->>'sessions')::bigint, s.m_sessions) end,
    m_emails_per_hour  = case when (v_db is null and s.m_db_at is not null) or v_db < coalesce(s.m_db_at, '-infinity') then s.m_emails_per_hour else coalesce((m->>'emails_per_hour')::integer, s.m_emails_per_hour) end,
    m_db_at            = case when v_db is null then s.m_db_at else greatest(coalesce(s.m_db_at, v_db), v_db) end,
    m_gateway_at       = case when v_gw is null then s.m_gateway_at else greatest(coalesce(s.m_gateway_at, v_gw), v_gw) end,
    m_cpu_at           = case when v_cpu is null then s.m_cpu_at else greatest(coalesce(s.m_cpu_at, v_cpu), v_cpu) end,
    m_cpu_sample       = case when jsonb_typeof(m->'cpu_sample') = 'object'
                               and not ((v_cpu is null and s.m_cpu_at is not null) or v_cpu < coalesce(s.m_cpu_at, '-infinity'))
                              then m->'cpu_sample' else s.m_cpu_sample end,
    m_unconfigured     = case when m ? 'unconfigured' and v_sweep is not null and v_sweep >= coalesce(s.m_unconfigured_at, '-infinity')
                              then array(select distinct e from jsonb_array_elements_text(m->'unconfigured') e order by e)
                              else s.m_unconfigured end,
    m_unconfigured_at  = case when m ? 'unconfigured' and v_sweep is not null and v_sweep >= coalesce(s.m_unconfigured_at, '-infinity')
                              then v_sweep else s.m_unconfigured_at end,
    metrics_at         = case when v_db is null and v_gw is null and v_cpu is null and m ?& array['measured_at']
                                   and not exists (select 1 from jsonb_object_keys(m) k
                                                    where k not in ('measured_at', 'unconfigured', 'cpu_sample'))
                              then s.metrics_at else now() end,
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

create or replace function public.site_backend_place(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_env       text
) returns table (shard_id uuid, project_ref text, url text, placed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site   public.sites;
  v_shard  public.site_shards;
  v_try    integer := 0;
  v_stale  integer;
  v_paused integer;
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
       and sh.dedicated_site_id is null
       and sh.site_count < sh.max_sites
       and public.site_shard_metrics_fresh(sh)
       and (sh.placement_paused_until is null or sh.placement_paused_until <= now())
       and public.site_shard_load(sh) < sh.fill_ratio
     order by public.site_shard_load(sh), sh.created_at, sh.id
     limit 1
     for update;
    if not found then
      if not exists (select 1 from public.site_shards sh
                      where sh.env = p_env and sh.purpose = 'pool' and sh.state = 'open' and sh.provision_step = 'done'
                        and sh.project_ref is not null and sh.url is not null
                        and sh.dedicated_site_id is null
                        and sh.site_count < sh.max_sites
                        and public.site_shard_metrics_fresh(sh)
                        and (sh.placement_paused_until is null or sh.placement_paused_until <= now())
                        and public.site_shard_load(sh) < sh.fill_ratio) then
        select count(*) filter (where not public.site_shard_metrics_fresh(sh)),
               count(*) filter (where sh.placement_paused_until > now())
          into v_stale, v_paused
          from public.site_shards sh
         where sh.env = p_env and sh.purpose = 'pool' and sh.state = 'open' and sh.dedicated_site_id is null;
        raise exception 'site_backend_place: no shard capacity in % (open shards with stale metrics: %, placement paused: %)',
          p_env, v_stale, v_paused using errcode = '53400';
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

  insert into public.site_shard_placements (env, shard_id) values (p_env, v_shard.id);

  return query select v_shard.id, v_shard.project_ref, v_shard.url, true;
end $$;

revoke all on function public.site_backend_place(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_backend_place(uuid, uuid, text) to service_role;

create or replace function public.site_shard_placement_pause(
  p_id      uuid,
  p_reason  text,
  p_seconds integer
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.site_shards;
begin
  if p_id is null or p_reason is null or length(p_reason) = 0 or length(p_reason) > 300 then
    raise exception 'site_shard_placement_pause: id and a 1..300 char reason are required' using errcode = '22023';
  end if;
  if p_seconds is not null and (p_seconds < 1 or p_seconds > 86400) then
    raise exception 'site_shard_placement_pause: seconds must be 1..86400 or null' using errcode = '22023';
  end if;
  update public.site_shards s set
    placement_paused_until  = case when p_seconds is null then 'infinity'::timestamptz else now() + make_interval(secs => p_seconds) end,
    placement_paused_reason = p_reason,
    placement_paused_at     = case when s.placement_paused_until is not null and s.placement_paused_until > now()
                                   then coalesce(s.placement_paused_at, now()) else now() end,
    updated_at              = now()
  where s.id = p_id
  returning * into v_row;
  if not found then
    raise exception 'site_shard_placement_pause: shard % not found', p_id using errcode = 'P0002';
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_placement_pause(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.site_shard_placement_pause(uuid, text, integer) to service_role;

create or replace function public.site_shard_placement_resume(p_id uuid, p_expect_reason text) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.site_shards;
begin
  if p_id is null then
    raise exception 'site_shard_placement_resume: id is required' using errcode = '22023';
  end if;
  update public.site_shards s set placement_paused_until = null, placement_paused_reason = null, placement_paused_at = null, updated_at = now()
   where s.id = p_id
     and (p_expect_reason is null or s.placement_paused_reason is not distinct from p_expect_reason)
  returning * into v_row;
  if not found then
    select * into v_row from public.site_shards s where s.id = p_id;
    if not found then
      raise exception 'site_shard_placement_resume: shard % not found', p_id using errcode = 'P0002';
    end if;
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_placement_resume(uuid, text) from public, anon, authenticated;
grant execute on function public.site_shard_placement_resume(uuid, text) to service_role;

create table if not exists public.site_shard_rollout_locks (
  env        text primary key check (env in ('prod', 'dev')),
  holder     text not null check (length(holder) between 1 and 200),
  until      timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.site_shard_rollout_locks enable row level security;
revoke all on public.site_shard_rollout_locks from public, anon, authenticated;

create or replace function public.site_shard_rollout_claim(p_env text, p_holder text, p_seconds integer) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_hit integer;
begin
  if p_env is null or p_env not in ('prod', 'dev') or p_holder is null or length(p_holder) not between 1 and 200
     or p_seconds is null or p_seconds < 60 or p_seconds > 86400 then
    raise exception 'site_shard_rollout_claim: env, holder and 60..86400 seconds are required' using errcode = '22023';
  end if;
  insert into public.site_shard_rollout_locks (env, holder, until)
  values (p_env, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (env) do update set holder = excluded.holder, until = excluded.until, updated_at = now()
   where public.site_shard_rollout_locks.until <= now() or public.site_shard_rollout_locks.holder = excluded.holder;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;

revoke all on function public.site_shard_rollout_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.site_shard_rollout_claim(text, text, integer) to service_role;

create or replace function public.site_shard_rollout_release(p_env text, p_holder text) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_hit integer;
begin
  delete from public.site_shard_rollout_locks l where l.env = p_env and l.holder = p_holder;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;

revoke all on function public.site_shard_rollout_release(text, text) from public, anon, authenticated;
grant execute on function public.site_shard_rollout_release(text, text) to service_role;

create or replace function public.site_shard_capacity_inputs(p_env text) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_1h   integer;
  v_24h  integer;
  v_lead numeric;
begin
  if p_env is null or p_env not in ('prod', 'dev') then
    raise exception 'site_shard_capacity_inputs: env is required' using errcode = '22023';
  end if;
  delete from public.site_shard_placements p
   where p.id in (select x.id from public.site_shard_placements x
                   where x.env = p_env and x.placed_at < now() - interval '7 days' limit 1000);
  select count(*) filter (where p.placed_at > now() - interval '1 hour'),
         count(*)
    into v_1h, v_24h
    from public.site_shard_placements p
   where p.env = p_env and p.placed_at > now() - interval '24 hours';
  select percentile_cont(0.5) within group (order by extract(epoch from (l.finished_at - l.created_at)))
    into v_lead
    from (select * from public.site_shard_autoprov_ledger l
           where l.env = p_env and l.kind = 'create' and l.status in ('open', 'ready') and l.finished_at is not null
           order by l.created_at desc limit 10) l;
  return jsonb_build_object('placements_1h', v_1h, 'placements_24h', v_24h, 'lead_time_s', v_lead);
end $$;

revoke all on function public.site_shard_capacity_inputs(text) from public, anon, authenticated;
grant execute on function public.site_shard_capacity_inputs(text) to service_role;

create or replace function public.site_shard_metrics_alert_claim(
  p_id      uuid,
  p_key     text,
  p_every_s integer
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row  public.site_shards;
  v_last timestamptz;
begin
  if p_id is null or p_key is null or p_key !~ '^[a-z0-9_:.-]{1,80}$' or p_every_s is null or p_every_s < 60 or p_every_s > 604800 then
    raise exception 'site_shard_metrics_alert_claim: id, a short key and 60..604800 seconds are required' using errcode = '22023';
  end if;
  select * into v_row from public.site_shards s where s.id = p_id for update;
  if not found then
    raise exception 'site_shard_metrics_alert_claim: shard % not found', p_id using errcode = 'P0002';
  end if;
  v_last := (v_row.m_alerted->>p_key)::timestamptz;
  if v_last is not null and v_last > now() - make_interval(secs => p_every_s) then
    return false;
  end if;
  update public.site_shards s set m_alerted =
    case when (select count(*) from jsonb_object_keys(s.m_alerted)) >= 50 and not (s.m_alerted ? p_key)
         then jsonb_build_object(p_key, now())
         else s.m_alerted || jsonb_build_object(p_key, now()) end
   where s.id = p_id;
  return true;
end $$;

revoke all on function public.site_shard_metrics_alert_claim(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.site_shard_metrics_alert_claim(uuid, text, integer) to service_role;

commit;
