
begin;

alter table public.site_shards add column if not exists soft_min_rpm integer not null default 60;
alter table public.site_shards add column if not exists soft_close_readings integer not null default 3;
alter table public.site_shards add column if not exists m_soft_over integer not null default 0;
alter table public.site_shards add column if not exists soft_full_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'site_shards_soft_min_rpm_range'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_soft_min_rpm_range
      check (soft_min_rpm between 0 and 10000000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_shards_soft_close_readings_range'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_soft_close_readings_range
      check (soft_close_readings between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'site_shards_soft_over_range'
                 and conrelid = 'public.site_shards'::regclass) then
    alter table public.site_shards add constraint site_shards_soft_over_range
      check (m_soft_over between 0 and 1000);
  end if;
end $$;

create or replace function public.site_shard_hard_load(s public.site_shards) returns numeric
language sql immutable security definer
set search_path = pg_catalog, pg_temp as $$
  select greatest(
    s.site_count::numeric / s.max_sites,
    s.m_records::numeric / s.lim_records,
    s.m_bytes::numeric / s.lim_bytes,
    coalesce(s.m_connections, 0)::numeric / s.lim_connections,
    s.m_auth_users::numeric / s.lim_auth_users,
    s.m_sessions::numeric / s.lim_sessions,
    s.m_emails_per_hour::numeric / s.lim_emails_per_hour
  )
$$;

revoke all on function public.site_shard_hard_load(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_hard_load(public.site_shards) to service_role;

create or replace function public.site_shard_soft_load(s public.site_shards) returns numeric
language sql immutable security definer
set search_path = pg_catalog, pg_temp as $$
  select greatest(
    case when 'gateway' = any(s.m_unconfigured) then 0 else s.m_requests_per_min::numeric / s.lim_requests_per_min end,
    case when 'gateway' = any(s.m_unconfigured) or s.m_requests_per_min < s.soft_min_rpm then 0
         else coalesce(s.m_p95_ms, 0)::numeric / s.lim_p95_ms end,
    case when 'cpu' = any(s.m_unconfigured) then 0 else coalesce(s.m_cpu_pct, 0) / s.lim_cpu_pct end
  )
$$;

revoke all on function public.site_shard_soft_load(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_soft_load(public.site_shards) to service_role;

create or replace function public.site_shard_load(s public.site_shards) returns numeric
language sql immutable security definer
set search_path = pg_catalog, pg_temp as $$
  select greatest(public.site_shard_hard_load(s), public.site_shard_soft_load(s))
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
  v_hard numeric;
  v_soft numeric;
  v_bad  text;
  m      jsonb := coalesce(p_metrics, '{}'::jsonb);
  v_at   jsonb;
  v_db   timestamptz;
  v_gw   timestamptz;
  v_cpu  timestamptz;
  v_sweep timestamptz;
  v_old_gw  timestamptz;
  v_old_cpu timestamptz;
  v_soft_read boolean;
  v_gw_new  boolean;
  v_cpu_new boolean;
  v_fresh   public.site_shards;
  v_soft_fresh numeric;
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
  select s.m_gateway_at, s.m_cpu_at into v_old_gw, v_old_cpu from public.site_shards s where s.id = p_id for update;
  if not found then
    raise exception 'site_shard_record_metrics: shard % not found', p_id using errcode = 'P0002';
  end if;
  v_gw_new  := v_gw is not null and v_gw > coalesce(v_old_gw, '-infinity') and (v_at->>'gateway')::timestamptz <= now();
  v_cpu_new := v_cpu is not null and v_cpu > coalesce(v_old_cpu, '-infinity') and (v_at->>'cpu')::timestamptz <= now();
  v_soft_read := v_gw_new or v_cpu_new;
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
  if v_row.dedicated_site_id is null and v_row.purpose = 'pool' then
    v_hard := public.site_shard_hard_load(v_row);
    v_soft := public.site_shard_soft_load(v_row);
    v_fresh := v_row;
    if not v_gw_new then
      v_fresh.m_requests_per_min := 0;
      v_fresh.m_p95_ms := 0;
    end if;
    if not v_cpu_new then
      v_fresh.m_cpu_pct := 0;
    end if;
    v_soft_fresh := public.site_shard_soft_load(v_fresh);
    if v_soft_read or v_soft < v_row.fill_ratio * 0.9 then
      update public.site_shards s set
        m_soft_over  = case when not v_soft_read then 0
                            when v_soft_fresh >= s.fill_ratio then least(s.m_soft_over + 1, 1000)
                            else 0 end,
        soft_full_at = case when v_soft < s.fill_ratio * 0.9 then null
                            when v_soft_read and v_soft_fresh >= s.fill_ratio and s.m_soft_over + 1 >= s.soft_close_readings
                              then coalesce(s.soft_full_at, now())
                            else s.soft_full_at end
       where s.id = p_id
      returning * into v_row;
    end if;
    if v_row.state = 'open' and v_hard >= v_row.fill_ratio then
      update public.site_shards s set state = 'full', updated_at = now() where s.id = p_id returning * into v_row;
    elsif v_row.state = 'full' and v_hard < v_row.fill_ratio * 0.9 then
      update public.site_shards s set state = 'open', updated_at = now() where s.id = p_id returning * into v_row;
    end if;
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_record_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_shard_record_metrics(uuid, jsonb) to service_role;

update public.site_shards sh set state = 'open', updated_at = now()
 where sh.state = 'full' and sh.purpose = 'pool' and sh.dedicated_site_id is null
   and sh.provision_step = 'done' and sh.project_ref is not null
   and public.site_shard_hard_load(sh) < sh.fill_ratio * 0.9;

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
       and public.site_shard_hard_load(sh) < sh.fill_ratio
     order by (sh.soft_full_at is not null), public.site_shard_load(sh), sh.created_at, sh.id
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
                        and public.site_shard_hard_load(sh) < sh.fill_ratio) then
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

create or replace function public.site_shard_placeable(sh public.site_shards) returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select coalesce(
       sh.purpose = 'pool' and sh.state = 'open' and sh.provision_step = 'done'
       and sh.project_ref is not null and sh.url is not null
       and sh.dedicated_site_id is null
       and sh.site_count < sh.max_sites
       and public.site_shard_metrics_fresh(sh)
       and (sh.placement_paused_until is null or sh.placement_paused_until <= now())
       and public.site_shard_hard_load(sh) < sh.fill_ratio,
     false)
$$;

revoke all on function public.site_shard_placeable(public.site_shards) from public, anon, authenticated;
grant execute on function public.site_shard_placeable(public.site_shards) to service_role;

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
     and public.site_shard_hard_load(sh) < sh.fill_ratio
   order by (sh.region = coalesce(p_region, '')) desc, (sh.soft_full_at is not null), public.site_shard_load(sh), sh.created_at, sh.id
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

commit;
