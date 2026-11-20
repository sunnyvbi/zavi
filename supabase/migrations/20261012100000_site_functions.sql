
begin;

create table if not exists public.site_function_state (
  site_id           uuid primary key,
  tenant_id         uuid not null,
  status            text not null default 'active'
    check (status in ('active', 'disabled', 'deleting', 'deleted')),
  active_generation bigint,
  active_script     text,
  status_reason     text check (status_reason is null or length(status_reason) <= 200),
  sync_version      bigint not null default 0,
  kv_dirty          boolean not null default true,
  reconcile_holder  uuid,
  reconcile_until   timestamptz,
  reconcile_after   timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists site_function_state_tenant on public.site_function_state (tenant_id);
create index if not exists site_function_state_dirty on public.site_function_state (updated_at) where kv_dirty;

create or replace function public.site_fn_state_bump() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.status is distinct from old.status
     or new.active_generation is distinct from old.active_generation
     or new.active_script is distinct from old.active_script then
    new.sync_version := old.sync_version + 1;
    new.kv_dirty := true;
  end if;
  return new;
end $$;
revoke all on function public.site_fn_state_bump() from public, anon, authenticated;
drop trigger if exists site_function_state_bump on public.site_function_state;
create trigger site_function_state_bump before update on public.site_function_state
  for each row execute function public.site_fn_state_bump();

create table if not exists public.site_function_deployments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  live_site_id  uuid not null,
  site_id       uuid not null,
  kind          text not null check (kind in ('live', 'test')),
  generation    bigint not null check (generation >= 0),
  script        text not null unique check (script ~ '^zf[nt]-[0-9a-f]{32}(-[0-9]{1,12})?$'),
  manifest      jsonb not null check (jsonb_typeof(manifest) = 'object'),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  status        text not null default 'staged'
    check (status in ('staged', 'active', 'superseded', 'deleted')),
  created_at    timestamptz not null default now(),
  activated_at  timestamptz,
  superseded_at timestamptz,
  deleted_at    timestamptz,
  unique (site_id, kind, generation)
);
create index if not exists site_function_deployments_live on public.site_function_deployments (live_site_id, status);
create index if not exists site_function_deployments_sweep on public.site_function_deployments (status, superseded_at)
  where status in ('superseded', 'staged');

create table if not exists public.site_function_secrets (
  site_id         uuid not null,
  tenant_id       uuid not null,
  scope           text not null check (scope in ('live', 'test')),
  name            text not null check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  vault_secret_id uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (site_id, scope, name)
);
create index if not exists site_function_secrets_tenant on public.site_function_secrets (tenant_id);

create table if not exists public.site_function_retired_secrets (
  vault_secret_id uuid primary key,
  site_id         uuid not null,
  tenant_id       uuid not null,
  retired_at      timestamptz not null default now()
);
create index if not exists site_function_retired_secrets_site on public.site_function_retired_secrets (site_id);
create index if not exists site_function_retired_secrets_age on public.site_function_retired_secrets (retired_at);
create index if not exists site_function_retired_secrets_tenant on public.site_function_retired_secrets (tenant_id);

create table if not exists public.site_function_schedules (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null,
  tenant_id     uuid not null,
  name          text not null check (name ~ '^[a-z][a-z0-9-]{0,47}$'),
  cron          text not null check (length(cron) between 9 and 100),
  data_access   text not null check (data_access in ('function', 'admin')),
  enabled       boolean not null default true,
  generation    bigint not null,
  next_run_at   timestamptz not null,
  claimed_until timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, name)
);
create index if not exists site_function_schedules_due on public.site_function_schedules (next_run_at) where enabled;
create index if not exists site_function_schedules_tenant on public.site_function_schedules (tenant_id);

create table if not exists public.site_function_runs (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null,
  tenant_id       uuid not null,
  schedule_name   text not null,
  slot            timestamptz not null,
  idempotency_key text not null unique,
  state           text not null default 'queued'
    check (state in ('queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled')),
  attempt         integer not null default 0 check (attempt >= 0),
  max_attempts    integer not null default 5 check (max_attempts between 1 and 20),
  run_after       timestamptz not null default now(),
  lease_until     timestamptz,
  last_status     integer,
  last_error      text check (last_error is null or length(last_error) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index if not exists site_function_runs_ready on public.site_function_runs (run_after)
  where state in ('queued', 'retry', 'running');
create index if not exists site_function_runs_site on public.site_function_runs (site_id, created_at desc);
create index if not exists site_function_runs_tenant on public.site_function_runs (tenant_id);

create table if not exists public.site_function_logs (
  id         bigint generated always as identity primary key,
  site_id    uuid not null,
  tenant_id  uuid not null,
  script     text not null,
  ts         timestamptz not null,
  level      text not null check (level in ('debug', 'info', 'warn', 'error')),
  message    text not null check (length(message) <= 2000),
  outcome    text check (outcome is null or length(outcome) <= 32),
  path       text check (path is null or length(path) <= 200),
  status     integer,
  created_at timestamptz not null default now()
);
create index if not exists site_function_logs_site on public.site_function_logs (site_id, ts desc);
create index if not exists site_function_logs_age on public.site_function_logs (created_at);
create index if not exists site_function_logs_tenant on public.site_function_logs (tenant_id);

alter table public.site_function_state       enable row level security;
alter table public.site_function_deployments enable row level security;
alter table public.site_function_secrets     enable row level security;
alter table public.site_function_schedules   enable row level security;
alter table public.site_function_runs        enable row level security;
alter table public.site_function_logs        enable row level security;
alter table public.site_function_retired_secrets enable row level security;
revoke all on public.site_function_state, public.site_function_deployments, public.site_function_secrets,
  public.site_function_schedules, public.site_function_runs, public.site_function_logs,
  public.site_function_retired_secrets
  from public, anon, authenticated;

create or replace function public.site_fn_assert_site(p_tenant_id uuid, p_site_id uuid) returns void
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_fn: tenant_id and site_id are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sites s
                  where s.id = p_site_id and s.tenant_id = p_tenant_id
                    and s.status not in ('deleting', 'deleted')) then
    raise exception 'site_fn: site not found' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.site_fn_secret_set(
  p_tenant_id uuid, p_site_id uuid, p_scope text, p_name text, p_value text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_at  timestamptz;
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  if p_scope is null or p_scope not in ('live', 'test') then
    raise exception 'site_fn_secret_set: scope must be live or test' using errcode = '22023';
  end if;
  insert into public.site_function_state (site_id, tenant_id) values (p_site_id, p_tenant_id)
  on conflict (site_id) do nothing;
  if p_name is null or p_name !~ '^[A-Z][A-Z0-9_]{1,63}$' or p_name ~ '^ZAVI_' then
    raise exception 'site_fn_secret_set: invalid secret name' using errcode = '22023';
  end if;
  if p_value is null or octet_length(p_value) < 8 or octet_length(p_value) > 8192 then
    raise exception 'site_fn_secret_set: value must be 8..8192 bytes' using errcode = '22023';
  end if;
  perform 1 from public.sites s
   where s.id = p_site_id and s.tenant_id = p_tenant_id and s.status not in ('deleting', 'deleted')
   for update;
  if not found then
    raise exception 'site_fn: site not found' using errcode = 'P0002';
  end if;
  select fs.vault_secret_id into v_old from public.site_function_secrets fs
   where fs.site_id = p_site_id and fs.scope = p_scope and fs.name = p_name for update;
  if v_old is null and (select count(*) from public.site_function_secrets fs where fs.site_id = p_site_id) >= 64 then
    raise exception 'site_fn_secret_set: too many secrets for this site' using errcode = '54000';
  end if;
  v_new := vault.create_secret(p_value);
  insert into public.site_function_secrets (site_id, tenant_id, scope, name, vault_secret_id)
  values (p_site_id, p_tenant_id, p_scope, p_name, v_new)
  on conflict (site_id, scope, name) do update set vault_secret_id = excluded.vault_secret_id, updated_at = now()
  returning updated_at into v_at;
  if v_old is not null then
    insert into public.site_function_retired_secrets (vault_secret_id, site_id, tenant_id)
    values (v_old, p_site_id, p_tenant_id) on conflict do nothing;
  end if;
  if p_scope = 'live' then
    update public.site_function_state st set sync_version = st.sync_version + 1, kv_dirty = true
     where st.site_id = p_site_id;
  end if;
  return jsonb_build_object('name', p_name, 'scope', p_scope, 'updated_at', v_at, 'rotated', v_old is not null);
end $$;

create or replace function public.site_fn_secret_delete(
  p_tenant_id uuid, p_site_id uuid, p_scope text, p_name text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_old uuid;
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  delete from public.site_function_secrets fs
   where fs.site_id = p_site_id and fs.tenant_id = p_tenant_id and fs.scope = p_scope and fs.name = p_name
  returning fs.vault_secret_id into v_old;
  if v_old is null then return false; end if;
  insert into public.site_function_retired_secrets (vault_secret_id, site_id, tenant_id)
  values (v_old, p_site_id, p_tenant_id) on conflict do nothing;
  if p_scope = 'live' then
    update public.site_function_state st set sync_version = st.sync_version + 1, kv_dirty = true
     where st.site_id = p_site_id;
  end if;
  return true;
end $$;

create or replace function public.site_fn_secret_list(p_tenant_id uuid, p_site_id uuid)
returns table (name text, scope text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  return query select fs.name, fs.scope, fs.created_at, fs.updated_at
                 from public.site_function_secrets fs
                where fs.site_id = p_site_id and fs.tenant_id = p_tenant_id
                order by fs.scope, fs.name;
end $$;

create or replace function public.site_fn_secret_values(p_tenant_id uuid, p_site_id uuid, p_scope text)
returns table (name text, value text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_fn_secret_values: tenant_id and site_id are required' using errcode = '22023';
  end if;
  return query select fs.name, ds.decrypted_secret::text
                 from public.site_function_secrets fs
                 join vault.decrypted_secrets ds on ds.id = fs.vault_secret_id
                where fs.site_id = p_site_id and fs.tenant_id = p_tenant_id and fs.scope = p_scope
                order by fs.name;
end $$;

create or replace function public.site_fn_stage(
  p_tenant_id uuid, p_live_site_id uuid, p_site_id uuid, p_kind text, p_generation bigint,
  p_script text, p_manifest jsonb, p_bundle_sha256 text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_active bigint;
  v_status text;
begin
  perform public.site_fn_assert_site(p_tenant_id, p_live_site_id);
  if p_kind not in ('live', 'test') or (p_kind = 'live' and p_site_id is distinct from p_live_site_id) then
    raise exception 'site_fn_stage: invalid kind / site' using errcode = '22023';
  end if;
  if p_kind = 'live' then
    insert into public.site_function_state (site_id, tenant_id) values (p_live_site_id, p_tenant_id)
    on conflict (site_id) do nothing;
    select st.active_generation, st.status into v_active, v_status
      from public.site_function_state st where st.site_id = p_live_site_id and st.tenant_id = p_tenant_id for update;
    if not found or v_status in ('deleting', 'deleted') then
      raise exception 'site_fn_stage: site functions are being deleted' using errcode = '55000';
    end if;
    if v_active is not null and p_generation <= v_active then
      return 'superseded';
    end if;
  end if;
  insert into public.site_function_deployments
    (tenant_id, live_site_id, site_id, kind, generation, script, manifest, bundle_sha256)
  values (p_tenant_id, p_live_site_id, p_site_id, p_kind, p_generation, p_script, p_manifest, p_bundle_sha256)
  on conflict (site_id, kind, generation) do update
     set manifest = excluded.manifest, bundle_sha256 = excluded.bundle_sha256
   where public.site_function_deployments.status = 'staged'
     and public.site_function_deployments.script = excluded.script
     and public.site_function_deployments.tenant_id = excluded.tenant_id;
  return 'staged';
end $$;

create or replace function public.site_fn_activate(
  p_tenant_id uuid, p_site_id uuid, p_generation bigint, p_script text, p_schedules jsonb
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_active bigint;
  v_prev   text;
  v_status text;
  s        jsonb;
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  if p_generation is null or p_generation < 0 then
    raise exception 'site_fn_activate: invalid generation' using errcode = '22023';
  end if;
  if p_schedules is null or jsonb_typeof(p_schedules) <> 'array' or jsonb_array_length(p_schedules) > 20 then
    raise exception 'site_fn_activate: schedules must be an array of at most 20' using errcode = '22023';
  end if;
  insert into public.site_function_state (site_id, tenant_id) values (p_site_id, p_tenant_id)
  on conflict (site_id) do nothing;
  select st.active_generation, st.active_script, st.status into v_active, v_prev, v_status
    from public.site_function_state st where st.site_id = p_site_id and st.tenant_id = p_tenant_id for update;
  if not found or v_status in ('deleting', 'deleted') then
    return jsonb_build_object('outcome', 'deleting');
  end if;
  if v_active is not null and p_generation < v_active then
    return jsonb_build_object('outcome', 'superseded', 'active_generation', v_active);
  end if;
  if v_active is not null and p_generation = v_active and p_script is not distinct from v_prev then
    return jsonb_build_object('outcome', 'already', 'script', v_prev, 'status', v_status);
  end if;
  if p_script is not null and not exists (
      select 1 from public.site_function_deployments d
       where d.site_id = p_site_id and d.tenant_id = p_tenant_id and d.kind = 'live'
         and d.generation = p_generation and d.script = p_script and d.status in ('staged', 'active')) then
    raise exception 'site_fn_activate: no staged deployment for this generation' using errcode = 'P0002';
  end if;

  update public.site_function_deployments d
     set status = 'superseded', superseded_at = now()
   where d.site_id = p_site_id and d.kind = 'live' and d.status = 'active'
     and d.script is distinct from p_script;
  if p_script is not null then
    update public.site_function_deployments d set status = 'active', activated_at = now()
     where d.site_id = p_site_id and d.script = p_script;
  end if;
  update public.site_function_deployments d
     set status = 'superseded', superseded_at = now()
   where d.site_id = p_site_id and d.kind = 'live' and d.status = 'staged' and d.generation < p_generation;
  update public.site_function_state st
     set active_generation = p_generation, active_script = p_script, updated_at = now()
   where st.site_id = p_site_id;

  update public.site_function_runs r set state = 'cancelled', finished_at = now(), updated_at = now()
   where r.site_id = p_site_id and r.state in ('queued', 'retry')
     and not exists (select 1 from jsonb_array_elements(p_schedules) x where x->>'name' = r.schedule_name);
  delete from public.site_function_schedules sc
   where sc.site_id = p_site_id
     and not exists (select 1 from jsonb_array_elements(p_schedules) x where x->>'name' = sc.name);
  for s in select * from jsonb_array_elements(p_schedules) loop
    if s->>'name' is null or s->>'cron' is null or s->>'next_run_at' is null
       or coalesce(s->>'data_access', '') not in ('function', 'admin') then
      raise exception 'site_fn_activate: invalid schedule' using errcode = '22023';
    end if;
    insert into public.site_function_schedules (site_id, tenant_id, name, cron, data_access, generation, next_run_at)
    values (p_site_id, p_tenant_id, s->>'name', s->>'cron', s->>'data_access', p_generation, (s->>'next_run_at')::timestamptz)
    on conflict (site_id, name) do update
       set data_access = excluded.data_access,
           generation  = excluded.generation,
           next_run_at = case when public.site_function_schedules.cron = excluded.cron
                              then public.site_function_schedules.next_run_at else excluded.next_run_at end,
           cron        = excluded.cron,
           updated_at  = now();
  end loop;
  return jsonb_build_object('outcome', 'activated', 'script', p_script, 'previous_script', v_prev, 'status', v_status);
end $$;

create or replace function public.site_fn_set_status(p_tenant_id uuid, p_site_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_status text;
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  if p_status not in ('active', 'disabled') then
    raise exception 'site_fn_set_status: status must be active or disabled' using errcode = '22023';
  end if;
  insert into public.site_function_state (site_id, tenant_id) values (p_site_id, p_tenant_id)
  on conflict (site_id) do nothing;
  select st.status into v_status from public.site_function_state st
   where st.site_id = p_site_id and st.tenant_id = p_tenant_id for update;
  if v_status in ('deleting', 'deleted') then
    return jsonb_build_object('outcome', 'deleting');
  end if;
  update public.site_function_state st
     set status = p_status, status_reason = left(p_reason, 200), updated_at = now()
   where st.site_id = p_site_id;
  if p_status = 'disabled' then
    update public.site_function_runs r set state = 'cancelled', finished_at = now(), updated_at = now()
     where r.site_id = p_site_id and r.state in ('queued', 'retry', 'running');
  end if;
  return jsonb_build_object('outcome', 'ok', 'status', p_status,
    'generation', (select st.active_generation from public.site_function_state st where st.site_id = p_site_id),
    'script', (select st.active_script from public.site_function_state st where st.site_id = p_site_id));
end $$;

create or replace function public.site_fn_schedule_set_enabled(p_tenant_id uuid, p_site_id uuid, p_name text, p_enabled boolean)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  update public.site_function_schedules sc set enabled = coalesce(p_enabled, false), updated_at = now()
   where sc.site_id = p_site_id and sc.tenant_id = p_tenant_id and sc.name = p_name;
  if not found then return false; end if;
  if not coalesce(p_enabled, false) then
    update public.site_function_runs r set state = 'cancelled', finished_at = now(), updated_at = now()
     where r.site_id = p_site_id and r.schedule_name = p_name and r.state in ('queued', 'retry', 'running');
  end if;
  return true;
end $$;

create or replace function public.site_fn_overview(p_tenant_id uuid, p_site_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  return jsonb_build_object(
    'hostname', (select s.hostname from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id),
    'state', (select to_jsonb(st) - 'tenant_id' - 'reconcile_holder' from public.site_function_state st where st.site_id = p_site_id),
    'deployment', (select jsonb_build_object('generation', d.generation, 'manifest', d.manifest, 'activated_at', d.activated_at)
                     from public.site_function_deployments d
                    where d.site_id = p_site_id and d.kind = 'live' and d.status = 'active' limit 1),
    'schedules', coalesce((select jsonb_agg(jsonb_build_object('name', sc.name, 'cron', sc.cron, 'enabled', sc.enabled,
                                    'next_run_at', sc.next_run_at, 'data_access', sc.data_access) order by sc.name)
                             from public.site_function_schedules sc where sc.site_id = p_site_id), '[]'::jsonb));
end $$;

create or replace function public.site_fn_runs_list(p_tenant_id uuid, p_site_id uuid, p_limit integer)
returns setof jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  return query select jsonb_build_object('id', r.id, 'schedule', r.schedule_name, 'slot', r.slot, 'state', r.state,
                        'attempt', r.attempt, 'max_attempts', r.max_attempts, 'last_status', r.last_status,
                        'last_error', r.last_error, 'created_at', r.created_at, 'finished_at', r.finished_at)
                 from public.site_function_runs r
                where r.site_id = p_site_id and r.tenant_id = p_tenant_id
                order by r.created_at desc
                limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

create or replace function public.site_fn_logs_list(p_tenant_id uuid, p_site_id uuid, p_before bigint, p_limit integer)
returns setof jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  perform public.site_fn_assert_site(p_tenant_id, p_site_id);
  return query select jsonb_build_object('id', l.id, 'ts', l.ts, 'level', l.level, 'message', l.message,
                        'outcome', l.outcome, 'path', l.path, 'status', l.status)
                 from public.site_function_logs l
                where l.site_id = p_site_id and l.tenant_id = p_tenant_id
                  and (p_before is null or l.id < p_before)
                order by l.id desc
                limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

create or replace function public.site_fn_schedules_due(p_now timestamptz, p_limit integer, p_lease_s integer)
returns table (id uuid, site_id uuid, tenant_id uuid, name text, cron text, next_run_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
  with due as (
    select sc.id from public.site_function_schedules sc
      join public.site_function_state st on st.site_id = sc.site_id and st.status = 'active'
                                         and st.active_script is not null
      join public.sites ps on ps.id = sc.site_id and ps.status not in ('deleting', 'deleted')
     where sc.enabled and sc.next_run_at <= p_now
       and (sc.claimed_until is null or sc.claimed_until < p_now)
     order by sc.next_run_at
     limit least(greatest(coalesce(p_limit, 100), 1), 1000)
     for update of sc skip locked
  )
  update public.site_function_schedules sc
     set claimed_until = p_now + make_interval(secs => least(greatest(coalesce(p_lease_s, 60), 10), 600))
    from due where sc.id = due.id
  returning sc.id, sc.site_id, sc.tenant_id, sc.name, sc.cron, sc.next_run_at;
end $$;

create or replace function public.site_fn_schedule_fire(
  p_id uuid, p_expected_next timestamptz, p_slot timestamptz, p_new_next timestamptz, p_max_attempts integer
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v public.site_function_schedules%rowtype;
  v_key text;
begin
  if p_new_next is null or p_new_next <= p_slot then
    raise exception 'site_fn_schedule_fire: next slot must be after the fired slot' using errcode = '22023';
  end if;
  update public.site_function_schedules sc
     set next_run_at = p_new_next, claimed_until = null, updated_at = now()
   where sc.id = p_id and sc.next_run_at = p_expected_next and sc.enabled
     and exists (select 1 from public.site_function_state st
                  where st.site_id = sc.site_id and st.status = 'active' and st.active_script is not null)
     and exists (select 1 from public.sites ps where ps.id = sc.site_id and ps.status not in ('deleting', 'deleted'))
  returning sc.* into v;
  if not found then return 'stale'; end if;
  v_key := v.site_id::text || ':' || v.name || ':' || floor(extract(epoch from p_slot))::bigint::text;
  insert into public.site_function_runs (site_id, tenant_id, schedule_name, slot, idempotency_key, max_attempts, run_after)
  values (v.site_id, v.tenant_id, v.name, p_slot, v_key, least(greatest(coalesce(p_max_attempts, 5), 1), 20), now())
  on conflict (idempotency_key) do nothing;
  return case when found then 'fired' else 'duplicate' end;
end $$;

create or replace function public.site_fn_runs_claim(p_now timestamptz, p_limit integer, p_lease_s integer, p_site_concurrency integer)
returns table (id uuid, site_id uuid, tenant_id uuid, schedule_name text, slot timestamptz, idempotency_key text,
               attempt integer, max_attempts integer, data_access text, hostname text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_cap   integer := least(greatest(coalesce(p_site_concurrency, 2), 1), 50);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_s, 120), 30), 900));
begin
  update public.site_function_runs r
     set state = 'dead', last_error = coalesce(r.last_error, 'lease expired'), finished_at = p_now, updated_at = now()
   where r.state = 'running' and r.lease_until <= p_now and r.attempt >= r.max_attempts;

  return query
  with running as (
    select r.site_id, count(*)::int as n from public.site_function_runs r
     where r.state = 'running' and r.lease_until > p_now group by r.site_id
  ), cand as (
    select r.id, r.site_id,
           row_number() over (partition by r.site_id order by r.run_after, r.id) as rn
      from public.site_function_runs r
      join public.site_function_state st on st.site_id = r.site_id and st.status = 'active' and st.active_script is not null
      join public.site_function_schedules sc on sc.site_id = r.site_id and sc.name = r.schedule_name and sc.enabled
      join public.sites ps on ps.id = r.site_id and ps.status not in ('deleting', 'deleted')
     where ((r.state in ('queued', 'retry') and r.run_after <= p_now)
            or (r.state = 'running' and r.lease_until <= p_now))
       and r.attempt < r.max_attempts
     order by r.run_after
     limit least(greatest(coalesce(p_limit, 50), 1), 500) * 4
  ), pick as (
    select c.id from cand c left join running x on x.site_id = c.site_id
     where c.rn <= v_cap - coalesce(x.n, 0)
     limit least(greatest(coalesce(p_limit, 50), 1), 500)
  ), locked as (
    select r.id from public.site_function_runs r
      join public.site_function_state st on st.site_id = r.site_id and st.status = 'active' and st.active_script is not null
      join public.site_function_schedules sc on sc.site_id = r.site_id and sc.name = r.schedule_name and sc.enabled
      join public.sites ps on ps.id = r.site_id and ps.status not in ('deleting', 'deleted')
     where r.id in (select pick.id from pick)
       and ((r.state in ('queued', 'retry') and r.run_after <= p_now) or (r.state = 'running' and r.lease_until <= p_now))
       and r.attempt < r.max_attempts
     for update of r skip locked
  )
  update public.site_function_runs r
     set state = 'running', attempt = r.attempt + 1, lease_until = p_now + v_lease, updated_at = now()
    from locked
   where r.id = locked.id
  returning r.id, r.site_id, r.tenant_id, r.schedule_name, r.slot, r.idempotency_key, r.attempt, r.max_attempts,
            (select sc.data_access from public.site_function_schedules sc where sc.site_id = r.site_id and sc.name = r.schedule_name),
            (select s.hostname from public.sites s where s.id = r.site_id);
end $$;

create or replace function public.site_fn_run_leased(p_id uuid, p_attempt integer, p_now timestamptz)
returns table (id uuid, site_id uuid, tenant_id uuid, schedule_name text, slot timestamptz, idempotency_key text,
               attempt integer, max_attempts integer, data_access text, hostname text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select r.id, r.site_id, r.tenant_id, r.schedule_name, r.slot, r.idempotency_key, r.attempt, r.max_attempts,
           (select sc.data_access from public.site_function_schedules sc where sc.site_id = r.site_id and sc.name = r.schedule_name),
           (select s.hostname from public.sites s where s.id = r.site_id)
      from public.site_function_runs r
      join public.site_function_state st on st.site_id = r.site_id and st.status = 'active' and st.active_script is not null
      join public.site_function_schedules sc on sc.site_id = r.site_id and sc.name = r.schedule_name and sc.enabled
      join public.sites ps on ps.id = r.site_id and ps.status not in ('deleting', 'deleted')
     where r.id = p_id and r.attempt = p_attempt and r.state = 'running' and r.lease_until > p_now;
end $$;

create or replace function public.site_fn_run_finish(
  p_id uuid, p_attempt integer, p_ok boolean, p_status integer, p_error text, p_retry_at timestamptz
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_state text;
begin
  update public.site_function_runs r
     set state = case when p_ok then 'succeeded'
                      when r.attempt >= r.max_attempts or p_retry_at is null then 'dead'
                      else 'retry' end,
         run_after   = case when p_ok then r.run_after else coalesce(p_retry_at, r.run_after) end,
         last_status = p_status,
         last_error  = case when p_ok then null else left(coalesce(p_error, 'failed'), 500) end,
         lease_until = null,
         finished_at = case when p_ok or r.attempt >= r.max_attempts or p_retry_at is null then now() else null end,
         updated_at  = now()
   where r.id = p_id and r.state = 'running' and r.attempt = p_attempt
  returning r.state into v_state;
  return coalesce(v_state, 'stale');
end $$;

create or replace function public.site_fn_logs_insert(p_entries jsonb) returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_n integer;
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 500 then
    raise exception 'site_fn_logs_insert: entries must be an array of at most 500' using errcode = '22023';
  end if;
  insert into public.site_function_logs (site_id, tenant_id, script, ts, level, message, outcome, path, status)
  select d.site_id, d.tenant_id, d.script,
         to_timestamp(least(greatest((e->>'ts')::double precision / 1000.0, 0), 32503680000)),
         case when e->>'level' in ('debug', 'info', 'warn', 'error') then e->>'level' else 'info' end,
         left(coalesce(e->>'message', ''), 2000),
         left(e->>'outcome', 32),
         left(e->>'path', 200),
         case when e->>'status' ~ '^[0-9]{1,3}$' then (e->>'status')::int end
    from jsonb_array_elements(p_entries) e
    join public.site_function_deployments d on d.script = e->>'script' and d.status <> 'deleted'
   where e->>'ts' ~ '^[0-9]{1,15}(\.[0-9]+)?$';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.site_fn_secrets_for_scripts(p_scripts text[])
returns table (script text, value text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_scripts is null or cardinality(p_scripts) > 200 then
    raise exception 'site_fn_secrets_for_scripts: at most 200 scripts' using errcode = '22023';
  end if;
  return query
    select d.script, ds.decrypted_secret::text
      from public.site_function_deployments d
      join public.site_function_secrets fs on fs.site_id = d.live_site_id and fs.tenant_id = d.tenant_id
      join vault.decrypted_secrets ds on ds.id = fs.vault_secret_id
     where d.script = any (p_scripts) and octet_length(ds.decrypted_secret) >= 1
    union all
    select d.script, ds.decrypted_secret::text
      from public.site_function_deployments d
      join public.site_function_retired_secrets rs on rs.site_id = d.live_site_id and rs.tenant_id = d.tenant_id
      join vault.decrypted_secrets ds on ds.id = rs.vault_secret_id
     where d.script = any (p_scripts) and octet_length(ds.decrypted_secret) >= 1;
end $$;

create or replace function public.site_fn_reconcile_begin(p_site_id uuid, p_holder uuid, p_lease_s integer) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare st public.site_function_state%rowtype;
begin
  update public.site_function_state x
     set reconcile_holder = p_holder,
         reconcile_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_s, 120), 10), 600))
   where x.site_id = p_site_id and (x.reconcile_until is null or x.reconcile_until < now())
  returning x.* into st;
  if not found then return null; end if;
  return jsonb_build_object(
    'site_id', st.site_id, 'tenant_id', st.tenant_id, 'status', st.status,
    'active_generation', st.active_generation, 'active_script', st.active_script,
    'sync_version', st.sync_version,
    'manifest', (select d.manifest from public.site_function_deployments d
                  where d.site_id = st.site_id and d.kind = 'live' and d.script = st.active_script));
end $$;

create or replace function public.site_fn_reconcile_end(p_site_id uuid, p_holder uuid, p_version bigint, p_ok boolean) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_clean boolean;
begin
  update public.site_function_state x
     set reconcile_holder = null, reconcile_until = null,
         kv_dirty = case when p_ok and x.sync_version = p_version then false else x.kv_dirty end,
         reconcile_after = case when p_ok then null else now() + interval '10 minutes' end
   where x.site_id = p_site_id and x.reconcile_holder = p_holder
  returning not x.kv_dirty into v_clean;
  return coalesce(v_clean, false);
end $$;

create or replace function public.site_fn_dirty_sites(p_limit integer) returns setof uuid
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query select st.site_id from public.site_function_state st
                where st.kv_dirty and (st.reconcile_after is null or st.reconcile_after <= now())
                  and (st.reconcile_until is null or st.reconcile_until < now())
                order by st.updated_at limit least(greatest(coalesce(p_limit, 50), 1), 500);
end $$;

create or replace function public.site_fn_sweep_candidates(p_now timestamptz, p_limit integer)
returns table (kind text, site_id uuid, tenant_id uuid, script text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
begin
  return query
  (select 'site'::text, st.site_id, st.tenant_id, null::text
     from public.site_function_state st
     left join public.sites s on s.id = st.site_id
    where (s.id is null or s.status in ('deleting', 'deleted'))
      and (st.status <> 'deleted'
           or exists (select 1 from public.site_function_secrets fs where fs.site_id = st.site_id)
           or exists (select 1 from public.site_function_retired_secrets rs where rs.site_id = st.site_id))
    limit v_lim)
  union all
  (select distinct 'site'::text, fs.site_id, fs.tenant_id, null::text
     from public.site_function_secrets fs
     left join public.sites s on s.id = fs.site_id
     left join public.site_function_state st on st.site_id = fs.site_id
    where st.site_id is null and (s.id is null or s.status in ('deleting', 'deleted'))
    limit v_lim)
  union all
  (select 'script'::text, d.site_id, d.tenant_id, d.script
     from public.site_function_deployments d
     left join public.sites s on s.id = d.live_site_id
    where d.status <> 'deleted' and d.status <> 'active'
      and (   (d.status = 'superseded' and d.superseded_at < p_now - interval '1 hour')
           or (d.kind = 'live' and d.status = 'staged' and d.created_at < p_now - interval '6 hours')
           or (d.kind = 'test' and d.created_at < p_now - interval '2 hours')
           or s.id is null or s.status in ('deleting', 'deleted'))
    limit v_lim);
end $$;

create or replace function public.site_fn_script_deleted(p_script text) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  update public.site_function_deployments d set status = 'deleted', deleted_at = now()
   where d.script = p_script and d.status <> 'active';
  return found;
end $$;

create or replace function public.site_fn_teardown_begin(p_site_id uuid) returns setof text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  update public.site_function_state st set status = 'deleting', updated_at = now()
   where st.site_id = p_site_id and st.status <> 'deleted';
  update public.site_function_runs r set state = 'cancelled', finished_at = now(), updated_at = now()
   where r.site_id = p_site_id and r.state in ('queued', 'retry', 'running');
  update public.site_function_deployments d set status = 'superseded', superseded_at = coalesce(d.superseded_at, now())
   where d.live_site_id = p_site_id and d.status in ('active', 'staged');
  return query select d.script from public.site_function_deployments d
                where d.live_site_id = p_site_id and d.status <> 'deleted';
end $$;

create or replace function public.site_fn_teardown_finish(p_site_id uuid) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if exists (select 1 from public.site_function_deployments d where d.live_site_id = p_site_id and d.status <> 'deleted') then
    return false;
  end if;
  delete from vault.secrets vs where vs.id in (select fs.vault_secret_id from public.site_function_secrets fs where fs.site_id = p_site_id);
  delete from public.site_function_secrets fs where fs.site_id = p_site_id;
  delete from vault.secrets vs where vs.id in (select rs.vault_secret_id from public.site_function_retired_secrets rs where rs.site_id = p_site_id);
  delete from public.site_function_retired_secrets rs where rs.site_id = p_site_id;
  delete from public.site_function_schedules sc where sc.site_id = p_site_id;
  delete from public.site_function_runs r where r.site_id = p_site_id;
  delete from public.site_function_logs l where l.site_id = p_site_id;
  update public.site_function_state st set status = 'deleted', active_script = null, updated_at = now()
   where st.site_id = p_site_id;
  return true;
end $$;

create or replace function public.site_fn_retention(p_now timestamptz, p_batch integer) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_b integer := least(greatest(coalesce(p_batch, 5000), 100), 50000);
  v_l integer;
  v_r integer;
begin
  delete from public.site_function_logs l
   where l.id in (select l2.id from public.site_function_logs l2 where l2.created_at < p_now - interval '7 days' limit v_b);
  get diagnostics v_l = row_count;
  delete from public.site_function_runs r
   where r.id in (select r2.id from public.site_function_runs r2
                   where r2.state in ('succeeded', 'dead', 'cancelled') and r2.finished_at < p_now - interval '30 days' limit v_b);
  get diagnostics v_r = row_count;
  with gone as (
    delete from public.site_function_retired_secrets rs
     where rs.vault_secret_id in (select r3.vault_secret_id from public.site_function_retired_secrets r3
                                   where r3.retired_at < p_now - interval '8 days' limit v_b)
    returning rs.vault_secret_id
  )
  delete from vault.secrets vs where vs.id in (select gone.vault_secret_id from gone);
  return jsonb_build_object('logs', v_l, 'runs', v_r);
end $$;

revoke all on function public.site_fn_assert_site(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_fn_assert_site(uuid, uuid) to service_role;
revoke all on function public.site_fn_secret_set(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.site_fn_secret_set(uuid, uuid, text, text, text) to service_role;
revoke all on function public.site_fn_secret_delete(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_fn_secret_delete(uuid, uuid, text, text) to service_role;
revoke all on function public.site_fn_secret_list(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_fn_secret_list(uuid, uuid) to service_role;
revoke all on function public.site_fn_secret_values(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_fn_secret_values(uuid, uuid, text) to service_role;
revoke all on function public.site_fn_stage(uuid, uuid, uuid, text, bigint, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.site_fn_stage(uuid, uuid, uuid, text, bigint, text, jsonb, text) to service_role;
revoke all on function public.site_fn_activate(uuid, uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.site_fn_activate(uuid, uuid, bigint, text, jsonb) to service_role;
revoke all on function public.site_fn_set_status(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_fn_set_status(uuid, uuid, text, text) to service_role;
revoke all on function public.site_fn_schedule_set_enabled(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.site_fn_schedule_set_enabled(uuid, uuid, text, boolean) to service_role;
revoke all on function public.site_fn_overview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_fn_overview(uuid, uuid) to service_role;
revoke all on function public.site_fn_runs_list(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.site_fn_runs_list(uuid, uuid, integer) to service_role;
revoke all on function public.site_fn_logs_list(uuid, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.site_fn_logs_list(uuid, uuid, bigint, integer) to service_role;
revoke all on function public.site_fn_schedules_due(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.site_fn_schedules_due(timestamptz, integer, integer) to service_role;
revoke all on function public.site_fn_schedule_fire(uuid, timestamptz, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.site_fn_schedule_fire(uuid, timestamptz, timestamptz, timestamptz, integer) to service_role;
revoke all on function public.site_fn_runs_claim(timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.site_fn_runs_claim(timestamptz, integer, integer, integer) to service_role;
revoke all on function public.site_fn_run_finish(uuid, integer, boolean, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.site_fn_run_finish(uuid, integer, boolean, integer, text, timestamptz) to service_role;
revoke all on function public.site_fn_run_leased(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.site_fn_run_leased(uuid, integer, timestamptz) to service_role;
revoke all on function public.site_fn_reconcile_begin(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.site_fn_reconcile_begin(uuid, uuid, integer) to service_role;
revoke all on function public.site_fn_dirty_sites(integer) from public, anon, authenticated;
grant execute on function public.site_fn_dirty_sites(integer) to service_role;
revoke all on function public.site_fn_reconcile_end(uuid, uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.site_fn_reconcile_end(uuid, uuid, bigint, boolean) to service_role;
revoke all on function public.site_fn_logs_insert(jsonb) from public, anon, authenticated;
grant execute on function public.site_fn_logs_insert(jsonb) to service_role;
revoke all on function public.site_fn_secrets_for_scripts(text[]) from public, anon, authenticated;
grant execute on function public.site_fn_secrets_for_scripts(text[]) to service_role;
revoke all on function public.site_fn_sweep_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.site_fn_sweep_candidates(timestamptz, integer) to service_role;
revoke all on function public.site_fn_script_deleted(text) from public, anon, authenticated;
grant execute on function public.site_fn_script_deleted(text) to service_role;
revoke all on function public.site_fn_teardown_begin(uuid) from public, anon, authenticated;
grant execute on function public.site_fn_teardown_begin(uuid) to service_role;
revoke all on function public.site_fn_teardown_finish(uuid) from public, anon, authenticated;
grant execute on function public.site_fn_teardown_finish(uuid) to service_role;
revoke all on function public.site_fn_retention(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.site_fn_retention(timestamptz, integer) to service_role;

commit;
