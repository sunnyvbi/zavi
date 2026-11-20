
begin;

create table if not exists public.site_shard_autoprov (
  env                  text primary key check (env in ('prod', 'dev')),
  paused               boolean not null default false,
  paused_reason        text check (paused_reason is null or length(paused_reason) <= 300),
  paused_by            text check (paused_by is null or length(paused_by) <= 200),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_attempt_at      timestamptz,
  last_notice          text check (last_notice is null or length(last_notice) <= 200),
  updated_at           timestamptz not null default now()
);

alter table public.site_shard_autoprov enable row level security;
revoke all on public.site_shard_autoprov from public, anon, authenticated;

create table if not exists public.site_shard_autoprov_ledger (
  id           uuid primary key default gen_random_uuid(),
  env          text not null check (env in ('prod', 'dev')),
  day          date not null,
  seq          integer not null check (seq >= 1),
  kind         text not null check (kind in ('create', 'resume')),
  source       text not null check (source in ('auto', 'staff')),
  cap_override boolean not null default false,
  actor        text check (actor is null or length(actor) <= 200),
  shard_id     uuid references public.site_shards (id) on delete set null,
  shard_name   text not null check (shard_name ~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$'),
  status       text not null default 'started' check (status in ('started', 'open', 'ready', 'blocked', 'failed')),
  reason       text check (reason is null or length(reason) <= 500),
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  constraint site_shard_autoprov_ledger_seq_uq unique (env, day, seq)
);
create index if not exists site_shard_autoprov_ledger_env_idx on public.site_shard_autoprov_ledger (env, created_at desc);

alter table public.site_shard_autoprov_ledger enable row level security;
revoke all on public.site_shard_autoprov_ledger from public, anon, authenticated;

create or replace function public.site_shard_autoprov_claim(
  p_env               text,
  p_source            text,
  p_max_per_day       integer,
  p_override          boolean,
  p_actor             text,
  p_region            text,
  p_min_retry_seconds integer
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
begin
  if p_env is null or p_env not in ('prod', 'dev') or p_source is null or p_source not in ('auto', 'staff') then
    raise exception 'site_shard_autoprov_claim: env prod|dev and source auto|staff are required' using errcode = '22023';
  end if;
  if p_region is null or p_region !~ '^[a-z]{2}-[a-z]+-[0-9]$' then
    raise exception 'site_shard_autoprov_claim: bad region' using errcode = '22023';
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
      'shard_name', v_prov.name, 'region', v_prov.region, 'canary', v_prov.is_canary);
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
  v_canary := not exists (select 1 from public.site_shards s
                           where s.env = p_env and s.state <> 'retired' and s.dedicated_site_id is null);
  insert into public.site_shards (env, name, region, is_canary)
  values (p_env, v_name, p_region, v_canary)
  returning * into v_shard;
  insert into public.site_shard_autoprov_ledger (env, day, seq, kind, source, cap_override, actor, shard_id, shard_name)
  values (p_env, v_day, v_seq, 'create', p_source, p_source = 'staff' and coalesce(p_override, false) and v_created >= least(greatest(coalesce(p_max_per_day, 0), 0), 10),
          left(p_actor, 200), v_shard.id, v_name)
  returning id into v_id;
  update public.site_shard_autoprov set last_attempt_at = now(), updated_at = now() where env = p_env;
  return jsonb_build_object('action', 'create', 'ledger_id', v_id, 'day', v_day, 'seq', v_seq,
    'shard_name', v_name, 'n', v_n, 'region', p_region, 'canary', v_canary, 'created_today', v_created + 1);
end $$;

revoke all on function public.site_shard_autoprov_claim(text, text, integer, boolean, text, text, integer) from public, anon, authenticated;
grant execute on function public.site_shard_autoprov_claim(text, text, integer, boolean, text, text, integer) to service_role;

create or replace function public.site_shard_autoprov_finish(
  p_ledger_id uuid,
  p_status    text,
  p_reason    text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row     public.site_shard_autoprov_ledger;
  v_state   public.site_shard_autoprov;
  v_tripped boolean := false;
begin
  if p_ledger_id is null or p_status is null or p_status not in ('open', 'ready', 'blocked', 'failed') then
    raise exception 'site_shard_autoprov_finish: ledger id and status open|ready|blocked|failed are required' using errcode = '22023';
  end if;
  select * into v_row from public.site_shard_autoprov_ledger l where l.id = p_ledger_id for update;
  if v_row.id is null then
    raise exception 'site_shard_autoprov_finish: ledger row % not found', p_ledger_id using errcode = 'P0002';
  end if;
  select * into v_state from public.site_shard_autoprov a where a.env = v_row.env for update;
  if v_row.status <> 'started' then
    return jsonb_build_object('status', v_row.status, 'consecutive_failures', v_state.consecutive_failures,
      'paused', v_state.paused, 'tripped', false, 'already', true);
  end if;
  update public.site_shard_autoprov_ledger
     set status = p_status, reason = left(p_reason, 500), finished_at = now()
   where id = p_ledger_id;
  if p_status in ('open', 'ready') then
    update public.site_shard_autoprov set consecutive_failures = 0, updated_at = now()
     where env = v_row.env returning * into v_state;
  else
    update public.site_shard_autoprov set consecutive_failures = consecutive_failures + 1, updated_at = now()
     where env = v_row.env returning * into v_state;
    if v_state.consecutive_failures >= 2 and not v_state.paused then
      update public.site_shard_autoprov
         set paused = true, paused_by = 'breaker',
             paused_reason = left('breaker: ' || v_state.consecutive_failures || ' provisioning attempts failed in a row', 300),
             updated_at = now()
       where env = v_row.env returning * into v_state;
      v_tripped := true;
    end if;
  end if;
  return jsonb_build_object('status', p_status, 'consecutive_failures', v_state.consecutive_failures,
    'paused', v_state.paused, 'tripped', v_tripped, 'already', false);
end $$;

revoke all on function public.site_shard_autoprov_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_shard_autoprov_finish(uuid, text, text) to service_role;

create or replace function public.site_shard_autoprov_set_paused(
  p_env    text,
  p_paused boolean,
  p_actor  text,
  p_reason text
) returns public.site_shard_autoprov
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_state public.site_shard_autoprov;
begin
  if p_env is null or p_env not in ('prod', 'dev') or p_paused is null then
    raise exception 'site_shard_autoprov_set_paused: env and paused are required' using errcode = '22023';
  end if;
  insert into public.site_shard_autoprov (env) values (p_env) on conflict (env) do nothing;
  update public.site_shard_autoprov
     set paused = p_paused,
         paused_by = case when p_paused then left(p_actor, 200) else null end,
         paused_reason = case when p_paused then left(coalesce(p_reason, 'paused by staff'), 300) else null end,
         consecutive_failures = case when p_paused then consecutive_failures else 0 end,
         last_notice = null,
         updated_at = now()
   where env = p_env
  returning * into v_state;
  return v_state;
end $$;

revoke all on function public.site_shard_autoprov_set_paused(text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.site_shard_autoprov_set_paused(text, boolean, text, text) to service_role;

create or replace function public.site_shard_autoprov_status(
  p_env   text,
  p_limit integer
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_state public.site_shard_autoprov;
  v_day   date := (now() at time zone 'utc')::date;
begin
  if p_env is null or p_env not in ('prod', 'dev') then
    raise exception 'site_shard_autoprov_status: env prod|dev is required' using errcode = '22023';
  end if;
  insert into public.site_shard_autoprov (env) values (p_env) on conflict (env) do nothing;
  select * into v_state from public.site_shard_autoprov a where a.env = p_env;
  return jsonb_build_object(
    'state', to_jsonb(v_state),
    'day', v_day,
    'created_today', (select count(*) from public.site_shard_autoprov_ledger l where l.env = p_env and l.day = v_day and l.kind = 'create'),
    'ledger', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select * from public.site_shard_autoprov_ledger l where l.env = p_env
         order by l.created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) x), '[]'::jsonb));
end $$;

revoke all on function public.site_shard_autoprov_status(text, integer) from public, anon, authenticated;
grant execute on function public.site_shard_autoprov_status(text, integer) to service_role;

create or replace function public.site_shard_autoprov_notice(
  p_env text,
  p_key text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_hit integer;
begin
  if p_env is null or p_env not in ('prod', 'dev') or p_key is null or length(p_key) > 200 then
    raise exception 'site_shard_autoprov_notice: env and a key are required' using errcode = '22023';
  end if;
  insert into public.site_shard_autoprov (env) values (p_env) on conflict (env) do nothing;
  update public.site_shard_autoprov set last_notice = p_key
   where env = p_env and last_notice is distinct from p_key;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;

revoke all on function public.site_shard_autoprov_notice(text, text) from public, anon, authenticated;
grant execute on function public.site_shard_autoprov_notice(text, text) to service_role;

create table if not exists public.site_shard_provision_guards (
  shard_name        text primary key check (shard_name ~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$'),
  holder            text check (holder is null or length(holder) between 1 and 200),
  until             timestamptz,
  create_state      text not null default 'none' check (create_state in ('none', 'creating', 'uncertain', 'created')),
  create_started_at timestamptz,
  create_attempts   integer not null default 0 check (create_attempts >= 0),
  needs_staff       text check (needs_staff is null or length(needs_staff) <= 300),
  updated_at        timestamptz not null default now()
);

alter table public.site_shard_provision_guards enable row level security;
revoke all on public.site_shard_provision_guards from public, anon, authenticated;

create or replace function public.site_shard_guard_acquire(
  p_name    text,
  p_holder  text,
  p_seconds integer
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  g public.site_shard_provision_guards;
begin
  if p_name is null or p_name !~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$' or p_holder is null or length(p_holder) not between 1 and 200 then
    raise exception 'site_shard_guard_acquire: shard name and holder are required' using errcode = '22023';
  end if;
  insert into public.site_shard_provision_guards (shard_name) values (p_name) on conflict (shard_name) do nothing;
  select * into g from public.site_shard_provision_guards x where x.shard_name = p_name for update;
  if g.needs_staff is not null then
    return jsonb_build_object('ok', false, 'reason', 'needs_staff', 'detail', g.needs_staff);
  end if;
  if g.holder is not null and g.holder <> p_holder then
    if g.until >= now() then
      return jsonb_build_object('ok', false, 'reason', 'busy');
    end if;
    update public.site_shard_provision_guards
       set needs_staff = left('lease expired while held by ' || g.holder || ' (create ' || g.create_state || ')', 300), updated_at = now()
     where shard_name = p_name;
    return jsonb_build_object('ok', false, 'reason', 'stale_lease', 'detail', g.holder);
  end if;
  update public.site_shard_provision_guards
     set holder = p_holder, until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 0), 60), 7200)), updated_at = now()
   where shard_name = p_name;
  return jsonb_build_object('ok', true, 'create_state', g.create_state);
end $$;

revoke all on function public.site_shard_guard_acquire(text, text, integer) from public, anon, authenticated;
grant execute on function public.site_shard_guard_acquire(text, text, integer) to service_role;

create or replace function public.site_shard_guard_release(
  p_name   text,
  p_holder text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_hit integer;
begin
  update public.site_shard_provision_guards set holder = null, until = null, updated_at = now()
   where shard_name = p_name and holder = p_holder;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;

revoke all on function public.site_shard_guard_release(text, text) from public, anon, authenticated;
grant execute on function public.site_shard_guard_release(text, text) to service_role;

create or replace function public.site_shard_guard_begin_create(
  p_name           text,
  p_holder         text,
  p_source         text,
  p_enabled        boolean,
  p_max_per_day    integer,
  p_settle_seconds integer
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  g        public.site_shard_provision_guards;
  v_env    text;
  v_state  public.site_shard_autoprov;
  v_day    date := (now() at time zone 'utc')::date;
  v_max    integer;
  v_begun  integer;
begin
  if p_name is null or p_name !~ '^zavi-shard-(prod|dev)-[0-9]{1,6}$' or p_source is null or p_source not in ('auto', 'staff', 'cli') then
    raise exception 'site_shard_guard_begin_create: shard name and source auto|staff|cli are required' using errcode = '22023';
  end if;
  v_env := substring(p_name from '^zavi-shard-(prod|dev)-');
  insert into public.site_shard_autoprov (env) values (v_env) on conflict (env) do nothing;
  select * into v_state from public.site_shard_autoprov a where a.env = v_env for update;
  select * into g from public.site_shard_provision_guards x where x.shard_name = p_name for update;
  if g.shard_name is null or g.holder is distinct from p_holder or g.until < now() then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  if g.needs_staff is not null then
    return jsonb_build_object('ok', false, 'reason', 'needs_staff', 'detail', g.needs_staff);
  end if;
  if g.create_state in ('creating', 'created') then
    update public.site_shard_provision_guards
       set needs_staff = left('create state is ' || g.create_state || ' but no project was found by name', 300), updated_at = now()
     where shard_name = p_name;
    return jsonb_build_object('ok', false, 'reason', 'needs_staff', 'detail', 'create state ' || g.create_state);
  end if;
  if g.create_state = 'uncertain' then
    if g.create_attempts >= 2 then
      update public.site_shard_provision_guards
         set needs_staff = 'the create response was lost twice; no project found by name', updated_at = now()
       where shard_name = p_name;
      return jsonb_build_object('ok', false, 'reason', 'needs_staff', 'detail', 'retry exhausted');
    end if;
    if g.create_started_at > now() - make_interval(secs => greatest(coalesce(p_settle_seconds, 0), 0)) then
      return jsonb_build_object('ok', false, 'reason', 'settling');
    end if;
  end if;
  if p_source = 'auto' then
    if not coalesce(p_enabled, false) then
      return jsonb_build_object('ok', false, 'reason', 'setting_off');
    end if;
    if v_state.paused then
      return jsonb_build_object('ok', false, 'reason', 'paused');
    end if;
  end if;
  if p_source in ('auto', 'staff') then
    v_max := least(greatest(coalesce(p_max_per_day, 0), 0), 10);
    if exists (select 1 from public.site_shard_autoprov_ledger l where l.shard_name = p_name and l.kind = 'create' and l.cap_override) then
      v_max := 25;
    end if;
    select count(*) into v_begun from public.site_shard_provision_guards x
     where x.shard_name like 'zavi-shard-' || v_env || '-%' and x.shard_name <> p_name
       and x.create_started_at is not null and (x.create_started_at at time zone 'utc')::date = v_day;
    if v_begun >= v_max then
      return jsonb_build_object('ok', false, 'reason', 'cap', 'begun_today', v_begun, 'cap', v_max);
    end if;
  end if;
  update public.site_shard_provision_guards
     set create_state = 'creating', create_started_at = now(), create_attempts = create_attempts + 1, updated_at = now()
   where shard_name = p_name;
  return jsonb_build_object('ok', true, 'attempt', g.create_attempts + 1);
end $$;

revoke all on function public.site_shard_guard_begin_create(text, text, text, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.site_shard_guard_begin_create(text, text, text, boolean, integer, integer) to service_role;

create or replace function public.site_shard_guard_end_create(
  p_name    text,
  p_holder  text,
  p_outcome text
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  g public.site_shard_provision_guards;
  v_to text;
begin
  if p_outcome is null or p_outcome not in ('created', 'definite', 'ambiguous') then
    raise exception 'site_shard_guard_end_create: outcome created|definite|ambiguous' using errcode = '22023';
  end if;
  select * into g from public.site_shard_provision_guards x where x.shard_name = p_name for update;
  if g.shard_name is null or g.holder is distinct from p_holder then
    raise exception 'site_shard_guard_end_create: % is not held by this process', p_name using errcode = '55000';
  end if;
  v_to := case p_outcome
            when 'created' then 'created'
            when 'ambiguous' then 'uncertain'
            else case when g.create_attempts <= 1 then 'none' else 'uncertain' end
          end;
  update public.site_shard_provision_guards set create_state = v_to, updated_at = now() where shard_name = p_name;
  return v_to;
end $$;

revoke all on function public.site_shard_guard_end_create(text, text, text) from public, anon, authenticated;
grant execute on function public.site_shard_guard_end_create(text, text, text) to service_role;

create or replace function public.site_shard_guard_staff_recover(
  p_name  text,
  p_found integer,
  p_actor text
) returns public.site_shard_provision_guards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  g public.site_shard_provision_guards;
begin
  if p_found is null or p_found not in (0, 1) then
    raise exception 'site_shard_guard_staff_recover: % projects carry this name; delete the extras by hand first', coalesce(p_found, -1) using errcode = '55000';
  end if;
  insert into public.site_shard_provision_guards (shard_name) values (p_name) on conflict (shard_name) do nothing;
  select * into g from public.site_shard_provision_guards x where x.shard_name = p_name for update;
  if g.holder is not null and g.until >= now() then
    raise exception 'site_shard_guard_staff_recover: % is held by a live process (%)', p_name, g.holder using errcode = '55006';
  end if;
  update public.site_shard_provision_guards
     set holder = null, until = null, needs_staff = null,
         create_state = case when p_found = 1 then 'created' else 'uncertain' end,
         create_started_at = case when p_found = 1 then create_started_at else now() end,
         create_attempts = case when p_found = 1 then create_attempts else 1 end,
         updated_at = now()
   where shard_name = p_name
  returning * into g;
  return g;
end $$;

revoke all on function public.site_shard_guard_staff_recover(text, integer, text) from public, anon, authenticated;
grant execute on function public.site_shard_guard_staff_recover(text, integer, text) to service_role;

commit;
