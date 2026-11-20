begin;

create table if not exists public.db_connectors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  pair_code_id uuid,
  machine_name text,
  version text,
  dialect text check (dialect is null or dialect in ('postgres', 'mysql', 'mongodb')),
  rules jsonb,
  rules_hash text,
  last_seen_at timestamptz,
  offline_notified_at timestamptz,
  failing_alerted_at timestamptz,
  last_skipped_feature text,
  last_skipped_at timestamptz,
  outstanding integer not null default 0 check (outstanding >= 0),
  poll_lease_id uuid,
  poll_lease_until timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);
comment on table public.db_connectors is
  'Zavi Connector per tenant (private data S4). token_hash = sha256 of the connector token. Server only; written by the db_connector RPCs.';
alter table public.db_connectors enable row level security;
revoke all on public.db_connectors from public, anon, authenticated;
create index if not exists db_connectors_failing_alerted_idx
  on public.db_connectors (failing_alerted_at) where failing_alerted_at is not null;

create table if not exists public.db_connector_pair_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.db_connector_pair_codes is
  'One-time Zavi Connector pairing codes (sha256 only), 30-minute expiry, at most one unused per tenant. Server only.';
alter table public.db_connector_pair_codes enable row level security;
revoke all on public.db_connector_pair_codes from public, anon, authenticated;
create unique index if not exists db_connector_pair_codes_one_open_idx
  on public.db_connector_pair_codes (tenant_id) where used_at is null;
create index if not exists db_connector_pair_codes_created_idx on public.db_connector_pair_codes (created_at);

create table if not exists public.db_connector_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_id uuid not null references public.db_connectors(id) on delete cascade,
  op jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'delivered', 'done', 'refused', 'failed', 'expired')),
  execution_token uuid,
  lease_until timestamptz,
  deliveries integer not null default 0,
  result jsonb,
  reason text,
  expires_at timestamptz not null default now() + interval '60 seconds',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
comment on table public.db_connector_requests is
  'Zavi Connector read queue. A result is read once and nulled; any result is nulled 2 minutes after the read finished; rows are deleted 1 hour after creation. Server only.';
alter table public.db_connector_requests enable row level security;
revoke all on public.db_connector_requests from public, anon, authenticated;
create index if not exists db_connector_requests_claim_idx
  on public.db_connector_requests (connector_id, created_at) where status = 'queued';
create index if not exists db_connector_requests_lease_idx
  on public.db_connector_requests (connector_id, lease_until) where status = 'delivered';
create index if not exists db_connector_requests_connector_idx on public.db_connector_requests (connector_id);
create index if not exists db_connector_requests_tenant_idx on public.db_connector_requests (tenant_id);
create index if not exists db_connector_requests_expiry_idx
  on public.db_connector_requests (expires_at) where status in ('queued', 'delivered');
create index if not exists db_connector_requests_finished_result_idx
  on public.db_connector_requests (finished_at) where result is not null;
create index if not exists db_connector_requests_created_idx on public.db_connector_requests (created_at);

create or replace function public._db_connector_outstanding_release()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('queued', 'delivered') then
      update public.db_connectors set outstanding = greatest(0, outstanding - 1) where id = old.connector_id;
    end if;
    return old;
  end if;
  if old.status in ('queued', 'delivered') and new.status not in ('queued', 'delivered') then
    update public.db_connectors set outstanding = greatest(0, outstanding - 1) where id = new.connector_id;
  end if;
  return new;
end $$;
revoke all on function public._db_connector_outstanding_release() from public, anon, authenticated;
drop trigger if exists db_connector_requests_outstanding on public.db_connector_requests;
create trigger db_connector_requests_outstanding
  after update of status or delete on public.db_connector_requests
  for each row execute function public._db_connector_outstanding_release();

create table if not exists public.db_connector_pair_limits (
  scope text not null check (length(scope) between 1 and 80),
  window_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (scope, window_start)
);
comment on table public.db_connector_pair_limits is
  'Zavi Connector pairing attempts per minute per hashed client IP, hashed subnet and overall. Server only.';
alter table public.db_connector_pair_limits enable row level security;
revoke all on public.db_connector_pair_limits from public, anon, authenticated;
create index if not exists db_connector_pair_limits_window_idx on public.db_connector_pair_limits (window_start);

create table if not exists public.db_connector_discovery_outbox (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  generation bigint not null default 1,
  requested_at timestamptz not null default now(),
  lease_until timestamptz,
  attempts integer not null default 0
);
comment on table public.db_connector_discovery_outbox is
  'Pending connector discovery per tenant until operator-db.discover.requested is accepted. Server only.';
alter table public.db_connector_discovery_outbox enable row level security;
revoke all on public.db_connector_discovery_outbox from public, anon, authenticated;
create index if not exists db_connector_discovery_outbox_due_idx on public.db_connector_discovery_outbox (requested_at);

create table if not exists public.db_connector_offline_notices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connector_id uuid not null references public.db_connectors(id) on delete cascade,
  outage_started_at timestamptz not null,
  feature text not null,
  attempts integer not null default 0,
  lease_until timestamptz,
  sent_at timestamptz,
  closed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (connector_id, outage_started_at)
);
comment on table public.db_connector_offline_notices is
  'Offline email outbox for the Zavi Connector, one row per outage. Server only.';
alter table public.db_connector_offline_notices enable row level security;
revoke all on public.db_connector_offline_notices from public, anon, authenticated;
create index if not exists db_connector_offline_notices_due_idx
  on public.db_connector_offline_notices (created_at) where sent_at is null and closed_at is null;
create index if not exists db_connector_offline_notices_tenant_idx on public.db_connector_offline_notices (tenant_id);

create table if not exists public.db_rediscovery_backfill (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  lease_until timestamptz,
  requested_at timestamptz
);
comment on table public.db_rediscovery_backfill is
  'Tenants due one rediscovery after private data S4 (partition metadata). Server only.';
alter table public.db_rediscovery_backfill enable row level security;
revoke all on public.db_rediscovery_backfill from public, anon, authenticated;
create index if not exists db_rediscovery_backfill_due_idx
  on public.db_rediscovery_backfill (created_at) where requested_at is null;

create table if not exists public.db_rediscovery_backfill_state (
  id integer primary key check (id = 1),
  cursor_tenant uuid,
  seeded_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.db_rediscovery_backfill_state is
  'Seeding cursor for db_rediscovery_backfill (one row). Server only.';
alter table public.db_rediscovery_backfill_state enable row level security;
revoke all on public.db_rediscovery_backfill_state from public, anon, authenticated;
insert into public.db_rediscovery_backfill_state (id) values (1) on conflict (id) do nothing;

create index if not exists data_access_log_connector_failed_recent_idx
  on public.data_access_log (created_at, tenant_id) where mode = 'connector' and result = 'failed';
create index if not exists data_access_log_connector_failed_tenant_idx
  on public.data_access_log (tenant_id, created_at) where mode = 'connector' and result = 'failed';
create index if not exists data_access_log_connector_allowed_tenant_idx
  on public.data_access_log (tenant_id, created_at) where mode = 'connector' and result = 'allowed';

create or replace function public.create_db_connector_pair_code(p_tenant_id uuid, p_code_hash text)
returns table (code_id uuid, issued_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_now timestamptz := now();
begin
  perform _assert_tenant_admin(p_tenant_id);
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'bad hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  update public.db_connector_pair_codes c set used_at = v_now
   where c.tenant_id = p_tenant_id and c.used_at is null;
  insert into public.db_connector_pair_codes (tenant_id, code_hash, created_by, expires_at, created_at)
  values (p_tenant_id, p_code_hash, auth.uid(), v_now + interval '30 minutes', v_now)
  returning id into v_id;
  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, auth.uid(), 'set', 'operator_db.connector_pair_code', null, null, '{}'::jsonb);
  return query select v_id, v_now, v_now + interval '30 minutes';
end $$;
revoke all on function public.create_db_connector_pair_code(uuid, text) from public, anon, authenticated;
grant execute on function public.create_db_connector_pair_code(uuid, text) to authenticated, service_role;

create or replace function public.db_connector_resolve_pair_code(p_code_hash text)
returns table (tenant_id uuid, code_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.tenant_id, c.id from public.db_connector_pair_codes c
   where c.code_hash = p_code_hash and c.used_at is null and c.expires_at > now();
$$;
revoke all on function public.db_connector_resolve_pair_code(text) from public, anon, authenticated;
grant execute on function public.db_connector_resolve_pair_code(text) to service_role;

create or replace function public.redeem_db_connector_pair_code(
  p_tenant_id uuid, p_code_id uuid, p_code_hash text, p_token_hash text, p_machine text, p_version text
) returns uuid
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_used uuid;
  v_conn uuid;
  v_key text;
  v_old uuid;
  v_by uuid;
begin
  if p_tenant_id is null or p_code_id is null then
    raise exception 'tenant and code are required' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'bad hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  update public.db_connector_pair_codes set used_at = now()
   where id = p_code_id and tenant_id = p_tenant_id and code_hash = p_code_hash
     and used_at is null and expires_at > now()
  returning id, created_by into v_used, v_by;
  if v_used is null then
    return null;
  end if;

  delete from public.db_connectors where tenant_id = p_tenant_id;
  insert into public.db_connectors (tenant_id, token_hash, pair_code_id, machine_name, version, last_seen_at, created_by)
  values (p_tenant_id, p_token_hash, p_code_id, left(p_machine, 120), left(p_version, 40), now(), v_by)
  returning id into v_conn;

  for v_key in
    select key from public.secrets where tenant_id = p_tenant_id and left(key, 12) = 'operator_db.'
  loop
    select vault_secret_id into v_old from public.secrets where tenant_id = p_tenant_id and key = v_key;
    if v_old is not null then
      delete from vault.secrets where id = v_old;
    end if;
    delete from public.secrets where tenant_id = p_tenant_id and key = v_key;
  end loop;

  update public.tenant_db_config set mode = 'connector', updated_at = now() where tenant_id = p_tenant_id;
  perform public._reset_db_policy_for_transition(p_tenant_id);

  insert into public.connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (p_tenant_id, 'operator_db', 'connector', 'Your database', array['read']::text[], now(), null)
  on conflict (tenant_id, slug) do update
    set team_id = 'connector', team_name = 'Your database', scopes = array['read']::text[],
        connected_at = now(), managed_by = null;
  update public.tenant_mcp_servers set enabled = true where tenant_id = p_tenant_id and server_id = 'operator_db';
  update public.tenant_db_settings set managed_db_opt_out_at = null, updated_at = now()
   where tenant_id = p_tenant_id and managed_db_opt_out_at is not null;
  delete from public.db_rediscovery_backfill where tenant_id = p_tenant_id and requested_at is null;

  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, v_by, 'set', 'operator_db.connector', null, null,
          jsonb_build_object('source', 'redeem_db_connector_pair_code'));
  return v_conn;
end $$;
revoke all on function public.redeem_db_connector_pair_code(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_db_connector_pair_code(uuid, uuid, text, text, text, text) to service_role;

create or replace function public.db_connector_pair_reserve(p_ip_scope text, p_net_scope text)
returns table (allowed boolean, global_attempts integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_ip integer;
  v_net integer;
  v_global integer;
begin
  if p_ip_scope is null or p_ip_scope !~ '^ip:[0-9a-f]{64}$' or p_net_scope is null or p_net_scope !~ '^net:[0-9a-f]{64}$' then
    raise exception 'bad scope' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('db_connector_pair_limit:' || p_ip_scope));
  perform pg_advisory_xact_lock(hashtext('db_connector_pair_limit:' || p_net_scope));
  select coalesce(sum(l.attempts), 0) into v_ip from public.db_connector_pair_limits l
   where l.scope = p_ip_scope and l.window_start > now() - interval '1 hour';
  select coalesce(sum(l.attempts), 0) into v_net from public.db_connector_pair_limits l
   where l.scope = p_net_scope and l.window_start > now() - interval '1 hour';
  if v_ip >= 10 or v_net >= 30 then
    return query select false, 0;
    return;
  end if;
  insert into public.db_connector_pair_limits as l (scope, window_start, attempts)
  values (p_ip_scope, v_window, 1), (p_net_scope, v_window, 1), ('global', v_window, 1)
  on conflict (scope, window_start) do update set attempts = l.attempts + 1;
  select coalesce(sum(l.attempts), 0) into v_global from public.db_connector_pair_limits l
   where l.scope = 'global' and l.window_start > now() - interval '1 hour';
  return query select true, v_global;
end $$;
revoke all on function public.db_connector_pair_reserve(text, text) from public, anon, authenticated;
grant execute on function public.db_connector_pair_reserve(text, text) to service_role;

create or replace function public.db_connector_pair_refund(p_ip_scope text, p_net_scope text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_ip_scope is null or p_ip_scope !~ '^ip:[0-9a-f]{64}$' or p_net_scope is null or p_net_scope !~ '^net:[0-9a-f]{64}$' then
    raise exception 'bad scope' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('db_connector_pair_limit:' || p_ip_scope));
  perform pg_advisory_xact_lock(hashtext('db_connector_pair_limit:' || p_net_scope));
  update public.db_connector_pair_limits l set attempts = l.attempts - 1
   where (l.scope, l.window_start) in (
     select distinct on (x.scope) x.scope, x.window_start from public.db_connector_pair_limits x
      where x.scope in (p_ip_scope, p_net_scope, 'global') and x.attempts > 0 and x.window_start > now() - interval '1 hour'
      order by x.scope, x.window_start desc
   );
end $$;
revoke all on function public.db_connector_pair_refund(text, text) from public, anon, authenticated;
grant execute on function public.db_connector_pair_refund(text, text) to service_role;

create or replace function public.db_connector_resolve_token(p_token_hash text)
returns table (tenant_id uuid, connector_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.tenant_id, c.id from public.db_connectors c
   where c.token_hash = p_token_hash and c.revoked_at is null;
$$;
revoke all on function public.db_connector_resolve_token(text) from public, anon, authenticated;
grant execute on function public.db_connector_resolve_token(text) to service_role;

create or replace function public.acquire_db_connector_poll(p_tenant_id uuid, p_connector_id uuid, p_lease_id uuid, p_seconds integer)
returns table (acquired boolean, retry_after integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_until timestamptz;
begin
  if p_lease_id is null then
    raise exception 'lease id required' using errcode = '22023';
  end if;
  update public.db_connectors c
     set poll_lease_id = p_lease_id,
         poll_lease_until = now() + make_interval(secs => greatest(5, least(coalesce(p_seconds, 35), 120))),
         offline_notified_at = case when c.last_seen_at is null or c.last_seen_at < now() - interval '30 seconds' then null else c.offline_notified_at end,
         last_seen_at = now()
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null
     and (c.poll_lease_until is null or c.poll_lease_until <= now() or c.poll_lease_id = p_lease_id);
  if found then
    return query select true, 0;
    return;
  end if;
  select c.poll_lease_until into v_until from public.db_connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null;
  return query select false, coalesce(greatest(1, ceil(extract(epoch from (v_until - now())))::integer), 1);
end $$;
revoke all on function public.acquire_db_connector_poll(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_db_connector_poll(uuid, uuid, uuid, integer) to service_role;

create or replace function public.release_db_connector_poll(p_tenant_id uuid, p_connector_id uuid, p_lease_id uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.db_connectors
     set poll_lease_until = null
   where id = p_connector_id and tenant_id = p_tenant_id and poll_lease_id = p_lease_id;
$$;
revoke all on function public.release_db_connector_poll(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_db_connector_poll(uuid, uuid, uuid) to service_role;

create or replace function public._request_db_connector_discovery(p_tenant_id uuid)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gen bigint;
begin
  insert into public.db_connector_discovery_outbox as o (tenant_id, generation, requested_at, lease_until, attempts)
  values (p_tenant_id, 1, now(), null, 0)
  on conflict (tenant_id) do update
    set generation = o.generation + 1, requested_at = now(), lease_until = null
  returning generation into v_gen;
  return v_gen;
end $$;
revoke all on function public._request_db_connector_discovery(uuid) from public, anon, authenticated;
grant execute on function public._request_db_connector_discovery(uuid) to service_role;

create or replace function public.touch_db_connector(
  p_tenant_id uuid, p_connector_id uuid, p_machine text, p_version text, p_rules jsonb, p_rules_hash text
) returns table (is_active boolean, was_offline boolean, offline_seconds integer, rules_changed boolean, discovery_generation bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seen timestamptz;
  v_hash text;
  v_was_offline boolean;
  v_changed boolean;
  v_gen bigint;
begin
  if (p_rules is null) <> (p_rules_hash is null) then
    raise exception 'rules and rules_hash go together' using errcode = '22023';
  end if;
  select c.last_seen_at, c.rules_hash into v_seen, v_hash from public.db_connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null
   for update;
  if not found then
    return query select false, false, 0, false, null::bigint;
    return;
  end if;
  v_was_offline := v_seen is null or v_seen < now() - interval '30 seconds';
  v_changed := p_rules_hash is not null and p_rules_hash is distinct from v_hash;
  update public.db_connectors
     set last_seen_at = now(),
         offline_notified_at = case when v_was_offline then null else offline_notified_at end,
         machine_name = coalesce(left(p_machine, 120), machine_name),
         version = coalesce(left(p_version, 40), version),
         rules = coalesce(p_rules, rules),
         rules_hash = coalesce(p_rules_hash, rules_hash)
   where id = p_connector_id;
  if v_was_offline then
    update public.db_connector_offline_notices set closed_at = now()
     where connector_id = p_connector_id and sent_at is null and closed_at is null;
  end if;
  if exists (select 1 from public.tenant_db_config c where c.tenant_id = p_tenant_id and c.mode = 'connector')
     and (v_changed
          or (v_was_offline and not exists (
                select 1 from public.tenant_db_catalog k
                 where k.tenant_id = p_tenant_id and k.discovery_error is null
                   and jsonb_array_length(coalesce(k.catalog->'tables', '[]'::jsonb)) > 0))) then
    v_gen := public._request_db_connector_discovery(p_tenant_id);
  end if;
  return query select true, v_was_offline, coalesce(extract(epoch from (now() - v_seen))::integer, 0), v_changed, v_gen;
end $$;
revoke all on function public.touch_db_connector(uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.touch_db_connector(uuid, uuid, text, text, jsonb, text) to service_role;

create or replace function public.set_db_connector_dialect(p_tenant_id uuid, p_connector_id uuid, p_dialect text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev text;
  v_new_connection boolean;
begin
  if p_dialect is null or p_dialect not in ('postgres', 'mysql', 'mongodb') then
    raise exception 'bad dialect' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  select c.dialect into v_prev from public.db_connectors c
   where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null
   for update;
  if not found then
    return null;
  end if;
  if v_prev is not distinct from p_dialect
     and exists (select 1 from public.tenant_db_config where tenant_id = p_tenant_id and mode = 'connector') then
    return null;
  end if;
  update public.db_connectors set dialect = p_dialect where id = p_connector_id;
  v_new_connection := not exists (select 1 from public.tenant_db_config where tenant_id = p_tenant_id);
  insert into public.tenant_db_config (tenant_id, type, schema_map, mode, auto_hide, updated_at)
  values (p_tenant_id, p_dialect::operator_db_type, '{}'::jsonb, 'connector', true, now())
  on conflict (tenant_id) do update
    set type = excluded.type, schema_map = '{}'::jsonb, mode = 'connector', updated_at = now();
  if v_new_connection then
    insert into public.tenant_db_settings (tenant_id, raw_results_retention, chat_retention, updated_at)
    values (p_tenant_id, 'run', 'forever', now())
    on conflict (tenant_id) do update set
      raw_results_retention = coalesce(tenant_db_settings.raw_results_retention, 'run'),
      chat_retention = coalesce(tenant_db_settings.chat_retention, 'forever'),
      updated_at = now();
  end if;
  perform public._reset_db_policy_for_transition(p_tenant_id);
  return public._request_db_connector_discovery(p_tenant_id);
end $$;
revoke all on function public.set_db_connector_dialect(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_db_connector_dialect(uuid, uuid, text) to service_role;

create or replace function public.ack_db_connector_discovery(p_tenant_id uuid, p_generation bigint)
returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with d as (
    delete from public.db_connector_discovery_outbox
     where tenant_id = p_tenant_id and generation = p_generation
    returning 1
  )
  select exists (select 1 from d);
$$;
revoke all on function public.ack_db_connector_discovery(uuid, bigint) from public, anon, authenticated;
grant execute on function public.ack_db_connector_discovery(uuid, bigint) to service_role;

create or replace function public.claim_db_connector_discovery_outbox(p_limit integer default 100)
returns table (tenant_id uuid, generation bigint)
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select o.tenant_id from public.db_connector_discovery_outbox o
     where o.requested_at < now() - interval '30 seconds'
       and (o.lease_until is null or o.lease_until < now())
     order by o.requested_at
     limit greatest(1, least(coalesce(p_limit, 100), 1000))
     for update skip locked
  )
  update public.db_connector_discovery_outbox o
     set lease_until = now() + interval '2 minutes', attempts = o.attempts + 1
    from due where o.tenant_id = due.tenant_id
  returning o.tenant_id, o.generation;
$$;
revoke all on function public.claim_db_connector_discovery_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_db_connector_discovery_outbox(integer) to service_role;

create or replace function public.enqueue_db_connector_request(p_tenant_id uuid, p_op jsonb, p_ttl_seconds integer)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conn uuid;
  v_reserved uuid;
  v_id uuid;
  v_ttl integer := greatest(5, least(coalesce(p_ttl_seconds, 60), 180));
begin
  if p_op is null or jsonb_typeof(p_op) <> 'object' or octet_length(p_op::text) > 200000 then
    raise exception 'bad op' using errcode = '22023';
  end if;
  select c.id into v_conn from public.db_connectors c
   where c.tenant_id = p_tenant_id and c.revoked_at is null;
  if v_conn is null then
    return null;
  end if;
  update public.db_connectors set outstanding = outstanding + 1
   where id = v_conn and outstanding < 200
  returning id into v_reserved;
  if v_reserved is null then
    raise exception 'connector queue full' using errcode = 'ZD429';
  end if;
  insert into public.db_connector_requests (tenant_id, connector_id, op, expires_at)
  values (p_tenant_id, v_conn, p_op, now() + make_interval(secs => v_ttl))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.enqueue_db_connector_request(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.enqueue_db_connector_request(uuid, jsonb, integer) to service_role;

create or replace function public.claim_db_connector_request(p_tenant_id uuid, p_connector_id uuid)
returns table (id uuid, execution_token uuid, op jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.db_connectors c
                  where c.id = p_connector_id and c.tenant_id = p_tenant_id and c.revoked_at is null) then
    return;
  end if;
  update public.db_connectors c set last_seen_at = now(),
         offline_notified_at = case when c.last_seen_at < now() - interval '30 seconds' then null else c.offline_notified_at end
   where c.id = p_connector_id and c.tenant_id = p_tenant_id
     and (c.last_seen_at is null or c.last_seen_at < now() - interval '10 seconds');

  update public.db_connector_requests r
     set status = case when r.deliveries >= 3 then 'failed' else 'queued' end,
         reason = case when r.deliveries >= 3 then 'The connector did not finish this read after 3 tries.' else r.reason end,
         finished_at = case when r.deliveries >= 3 then now() else null end,
         execution_token = case when r.deliveries >= 3 then r.execution_token else null end,
         lease_until = null
   where r.connector_id = p_connector_id and r.tenant_id = p_tenant_id
     and r.status = 'delivered' and r.lease_until <= now() and r.expires_at > now();

  select r.id into v_id from public.db_connector_requests r
   where r.connector_id = p_connector_id and r.tenant_id = p_tenant_id
     and r.status = 'queued' and r.expires_at > now()
   order by r.created_at
   limit 1
   for update skip locked;
  if v_id is null then
    return;
  end if;
  return query
  update public.db_connector_requests r
     set status = 'delivered', execution_token = gen_random_uuid(),
         lease_until = now() + interval '30 seconds', deliveries = r.deliveries + 1
   where r.id = v_id
  returning r.id, r.execution_token, r.op;
end $$;
revoke all on function public.claim_db_connector_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_db_connector_request(uuid, uuid) to service_role;

create or replace function public.complete_db_connector_request(
  p_tenant_id uuid, p_connector_id uuid, p_request_id uuid, p_execution_token uuid,
  p_status text, p_result jsonb, p_reason text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_token uuid;
begin
  if p_status is null or p_status not in ('done', 'refused', 'failed') then
    raise exception 'bad status' using errcode = '22023';
  end if;
  if p_result is not null and octet_length(p_result::text) > 950000 then
    raise exception 'result too large' using errcode = '22023';
  end if;
  select r.status, r.execution_token into v_status, v_token from public.db_connector_requests r
   where r.id = p_request_id and r.tenant_id = p_tenant_id and r.connector_id = p_connector_id
   for update;
  if not found or v_token is distinct from p_execution_token then
    return 'stale';
  end if;
  if v_status in ('done', 'refused', 'failed') then
    return 'duplicate';
  end if;
  update public.db_connector_requests
     set status = p_status, result = p_result, reason = left(p_reason, 500),
         lease_until = null, finished_at = now()
   where id = p_request_id and status = 'delivered' and expires_at > now();
  if not found then
    return 'stale';
  end if;
  return 'accepted';
end $$;
revoke all on function public.complete_db_connector_request(uuid, uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_db_connector_request(uuid, uuid, uuid, uuid, text, jsonb, text) to service_role;

create or replace function public.take_db_connector_result(p_tenant_id uuid, p_request_id uuid)
returns table (status text, result jsonb, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_result jsonb;
  v_reason text;
  v_expires timestamptz;
begin
  select r.status, r.result, r.reason, r.expires_at into v_status, v_result, v_reason, v_expires
    from public.db_connector_requests r
   where r.id = p_request_id and r.tenant_id = p_tenant_id
   for update;
  if not found then
    return query select 'expired'::text, null::jsonb, 'request not found'::text;
    return;
  end if;
  if v_status in ('queued', 'delivered') then
    if v_expires > now() then
      return;
    end if;
    update public.db_connector_requests r set status = 'expired', lease_until = null, finished_at = now()
     where r.id = p_request_id;
    v_status := 'expired';
  end if;
  update public.db_connector_requests r set result = null where r.id = p_request_id and r.result is not null;
  return query select v_status, v_result, v_reason;
end $$;
revoke all on function public.take_db_connector_result(uuid, uuid) from public, anon, authenticated;
grant execute on function public.take_db_connector_result(uuid, uuid) to service_role;

create or replace function public.cancel_db_connector_request(p_tenant_id uuid, p_request_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.db_connector_requests
     set status = 'expired', lease_until = null, result = null, finished_at = now()
   where id = p_request_id and tenant_id = p_tenant_id and status in ('queued', 'delivered');
  return found;
end $$;
revoke all on function public.cancel_db_connector_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_db_connector_request(uuid, uuid) to service_role;

create or replace function public.claim_db_connector_offline_notice(p_tenant_id uuid, p_feature text)
returns table (notice_id uuid, should_send boolean, machine_name text, last_seen_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conn uuid;
  v_machine text;
  v_seen timestamptz;
  v_created timestamptz;
  v_feature text := left(coalesce(nullif(trim(p_feature), ''), 'A scheduled job'), 80);
  v_notice uuid;
  v_send boolean;
begin
  select c.id, c.machine_name, c.last_seen_at, c.created_at into v_conn, v_machine, v_seen, v_created
    from public.db_connectors c
   where c.tenant_id = p_tenant_id and c.revoked_at is null
     and (c.last_seen_at is null or c.last_seen_at < now() - interval '30 seconds')
   for update;
  if v_conn is null then
    return;
  end if;
  update public.db_connectors set last_skipped_feature = v_feature, last_skipped_at = now() where id = v_conn;
  insert into public.db_connector_offline_notices (tenant_id, connector_id, outage_started_at, feature)
  values (p_tenant_id, v_conn, coalesce(v_seen, v_created), v_feature)
  on conflict (connector_id, outage_started_at) do nothing;
  update public.db_connector_offline_notices n
     set lease_until = now() + interval '2 minutes', attempts = n.attempts + 1
   where n.connector_id = v_conn and n.outage_started_at = coalesce(v_seen, v_created)
     and n.sent_at is null and n.closed_at is null
     and (n.lease_until is null or n.lease_until < now())
  returning n.id into v_notice;
  v_send := v_notice is not null;
  if v_notice is null then
    select n.id into v_notice from public.db_connector_offline_notices n
     where n.connector_id = v_conn and n.outage_started_at = coalesce(v_seen, v_created);
  end if;
  return query select v_notice, v_send, v_machine, v_seen;
end $$;
revoke all on function public.claim_db_connector_offline_notice(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_db_connector_offline_notice(uuid, text) to service_role;

create or replace function public.ack_db_connector_offline_notice(p_tenant_id uuid, p_notice_id uuid, p_delivered integer, p_error text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conn uuid;
  v_attempts integer;
begin
  select n.connector_id, n.attempts into v_conn, v_attempts from public.db_connector_offline_notices n
   where n.id = p_notice_id and n.tenant_id = p_tenant_id
   for update;
  if v_conn is null then
    return;
  end if;
  if coalesce(p_delivered, 0) > 0 then
    update public.db_connector_offline_notices set sent_at = now(), lease_until = null, last_error = null where id = p_notice_id;
    update public.db_connectors set offline_notified_at = now()
     where id = v_conn and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  else
    update public.db_connector_offline_notices
       set lease_until = now() + least(interval '1 hour', interval '5 minutes' * power(2, greatest(0, v_attempts - 1))),
           last_error = left(p_error, 300)
     where id = p_notice_id;
  end if;
end $$;
revoke all on function public.ack_db_connector_offline_notice(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.ack_db_connector_offline_notice(uuid, uuid, integer, text) to service_role;

create or replace function public.claim_db_connector_offline_notices_due(p_limit integer default 100)
returns table (notice_id uuid, tenant_id uuid, feature text, machine_name text, last_seen_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.db_connector_offline_notices n set closed_at = now()
    from public.db_connectors c
   where c.id = n.connector_id and n.sent_at is null and n.closed_at is null
     and (c.revoked_at is not null or c.last_seen_at >= now() - interval '30 seconds');
  return query
  with due as (
    select n.id from public.db_connector_offline_notices n
     where n.sent_at is null and n.closed_at is null
       and (n.lease_until is null or n.lease_until < now())
     order by n.created_at
     limit greatest(1, least(coalesce(p_limit, 100), 1000))
     for update of n skip locked
  ),
  leased as (
    update public.db_connector_offline_notices n
       set lease_until = now() + interval '2 minutes', attempts = n.attempts + 1
      from due where n.id = due.id
    returning n.id, n.tenant_id, n.feature, n.connector_id
  )
  select l.id, l.tenant_id, l.feature, c.machine_name, c.last_seen_at
    from leased l join public.db_connectors c on c.id = l.connector_id;
end $$;
revoke all on function public.claim_db_connector_offline_notices_due(integer) from public, anon, authenticated;
grant execute on function public.claim_db_connector_offline_notices_due(integer) to service_role;

create or replace function public.claim_db_connector_failing_alerts(p_minutes integer default 15)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_min interval := make_interval(mins => greatest(5, least(coalesce(p_minutes, 15), 240)));
  v_n integer := 0;
  r record;
begin
  create temporary table if not exists _dbc_failing (cid uuid primary key, tid uuid, n integer, first_at timestamptz, seen timestamptz) on commit drop;
  truncate _dbc_failing;
  insert into _dbc_failing (cid, tid, n, first_at, seen)
  select c.id, c.tenant_id, f.n, f.first_at, c.last_seen_at
    from (select distinct l.tenant_id from public.data_access_log l
           where l.mode = 'connector' and l.result = 'failed' and l.created_at > now() - v_min) recent
    join public.db_connectors c on c.tenant_id = recent.tenant_id and c.revoked_at is null
    cross join lateral (
      select max(l.created_at) as at from public.data_access_log l
       where l.tenant_id = c.tenant_id and l.mode = 'connector' and l.result = 'allowed'
         and l.created_at > now() - interval '6 hours'
    ) ok
    cross join lateral (
      select count(*)::integer as n, min(l.created_at) as first_at from public.data_access_log l
       where l.tenant_id = c.tenant_id and l.mode = 'connector' and l.result = 'failed'
         and l.created_at > coalesce(ok.at, now() - interval '6 hours')
    ) f
   where f.n > 0 and f.first_at < now() - v_min;

  update public.db_connectors c set failing_alerted_at = null
   where c.failing_alerted_at is not null
     and not exists (select 1 from _dbc_failing x where x.cid = c.id);

  for r in
    update public.db_connectors c set failing_alerted_at = now()
      from _dbc_failing x
     where x.cid = c.id and c.failing_alerted_at is null
    returning c.id as cid, c.tenant_id as tid, x.n, x.first_at, x.seen
  loop
    perform public.enqueue_ops_alert(
      'db-connector-reads-failing:' || r.cid::text || ':' || floor(extract(epoch from r.first_at))::bigint::text,
      'db-connector.liveness',
      'connector_reads_failing',
      r.tid,
      format('Zavi Connector reads failing for %s min: tenant=%s connector=%s failed_reads=%s last_seen=%s',
             greatest(1, floor(extract(epoch from (now() - r.first_at)) / 60))::integer, r.tid, r.cid, r.n,
             coalesce(to_char(r.seen at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'never')));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.claim_db_connector_failing_alerts(integer) from public, anon, authenticated;
grant execute on function public.claim_db_connector_failing_alerts(integer) to service_role;

create or replace function public.remove_db_connector(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_machine text;
  v_found boolean;
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  update public.db_connectors set revoked_at = now(), revoked_by = auth.uid(), poll_lease_until = null
   where tenant_id = p_tenant_id and revoked_at is null
  returning machine_name into v_machine;
  v_found := found;
  delete from public.db_connector_requests where tenant_id = p_tenant_id;
  update public.db_connector_pair_codes set used_at = now() where tenant_id = p_tenant_id and used_at is null;
  update public.db_connector_offline_notices set closed_at = now()
   where tenant_id = p_tenant_id and sent_at is null and closed_at is null;
  delete from public.db_connector_discovery_outbox where tenant_id = p_tenant_id;
  if exists (select 1 from public.tenant_db_config where tenant_id = p_tenant_id and mode = 'connector') then
    delete from public.tenant_db_config where tenant_id = p_tenant_id and mode = 'connector';
    delete from public.tenant_db_catalog where tenant_id = p_tenant_id;
    delete from public.connector_metadata where tenant_id = p_tenant_id and slug = 'operator_db';
  elsif v_found then
    delete from public.connector_metadata
     where tenant_id = p_tenant_id and slug = 'operator_db' and team_id = 'connector';
  end if;
  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, auth.uid(), 'clear', 'operator_db.connector', null, null,
          jsonb_build_object('source', 'remove_db_connector', 'had_connector', v_found));
  return jsonb_build_object('removed', v_found, 'machine', v_machine);
end $$;
revoke all on function public.remove_db_connector(uuid) from public, anon, authenticated;
grant execute on function public.remove_db_connector(uuid) to authenticated, service_role;

create or replace function public.purge_db_connector_requests(p_batch_limit integer default 5000)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_batch_limit, 5000), 20000));
  v_expired integer;
  v_scrubbed integer;
  v_deleted integer;
  v_codes integer;
  v_limits integer;
  v_notices integer;
begin
  update public.db_connector_requests set status = 'expired', lease_until = null, finished_at = now()
   where id in (select id from public.db_connector_requests
                 where status in ('queued', 'delivered') and expires_at <= now()
                 order by expires_at limit v_limit);
  get diagnostics v_expired = row_count;
  update public.db_connector_requests set result = null
   where id in (select id from public.db_connector_requests
                 where result is not null and finished_at < now() - interval '2 minutes'
                 order by finished_at limit v_limit);
  get diagnostics v_scrubbed = row_count;
  delete from public.db_connector_requests
   where id in (select id from public.db_connector_requests
                 where created_at < now() - interval '1 hour' and status not in ('queued', 'delivered')
                 order by created_at limit v_limit);
  get diagnostics v_deleted = row_count;
  delete from public.db_connector_pair_codes
   where id in (select id from public.db_connector_pair_codes where created_at < now() - interval '1 day' limit v_limit);
  get diagnostics v_codes = row_count;
  delete from public.db_connector_pair_limits
   where (scope, window_start) in (select scope, window_start from public.db_connector_pair_limits
                                    where window_start < now() - interval '2 hours' limit v_limit);
  get diagnostics v_limits = row_count;
  delete from public.db_connector_offline_notices
   where id in (select id from public.db_connector_offline_notices where created_at < now() - interval '7 days' limit v_limit);
  get diagnostics v_notices = row_count;
  return jsonb_build_object('expired', v_expired, 'scrubbed', v_scrubbed, 'deleted', v_deleted,
                            'codes', v_codes, 'limits', v_limits, 'notices', v_notices);
end $$;
revoke all on function public.purge_db_connector_requests(integer) from public, anon, authenticated;
grant execute on function public.purge_db_connector_requests(integer) to service_role;

create or replace function public.seed_db_rediscovery_backfill(p_limit integer default 1000)
returns table (scanned integer, done boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cursor uuid;
  v_seeded timestamptz;
  v_last uuid;
  v_n integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 10000));
begin
  select s.cursor_tenant, s.seeded_at into v_cursor, v_seeded from public.db_rediscovery_backfill_state s where s.id = 1 for update;
  if v_seeded is not null then
    return query select 0, true;
    return;
  end if;
  with page as (
    select c.tenant_id, c.mode from public.tenant_db_config c
     where v_cursor is null or c.tenant_id > v_cursor
     order by c.tenant_id
     limit v_limit
  ),
  ins as (
    insert into public.db_rediscovery_backfill (tenant_id)
    select p.tenant_id from page p where p.mode = 'direct'
    on conflict (tenant_id) do nothing
    returning 1
  )
  select count(*)::integer, (array_agg(p.tenant_id order by p.tenant_id desc))[1] into v_n, v_last from page p;
  update public.db_rediscovery_backfill_state
     set cursor_tenant = coalesce(v_last, cursor_tenant),
         seeded_at = case when v_n < v_limit then now() else null end,
         updated_at = now()
   where id = 1;
  return query select v_n, v_n < v_limit;
end $$;
revoke all on function public.seed_db_rediscovery_backfill(integer) from public, anon, authenticated;
grant execute on function public.seed_db_rediscovery_backfill(integer) to service_role;

create or replace function public.claim_db_rediscovery_backfill(p_limit integer default 10)
returns setof uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 1000));
begin
  update public.db_rediscovery_backfill b set requested_at = now()
   where b.tenant_id in (
     select x.tenant_id from public.db_rediscovery_backfill x
      where x.requested_at is null
        and not exists (select 1 from public.tenant_db_config c where c.tenant_id = x.tenant_id and c.mode = 'direct')
      limit v_limit);
  return query
  with due as (
    select b.tenant_id from public.db_rediscovery_backfill b
     where b.requested_at is null and (b.lease_until is null or b.lease_until < now())
     order by b.created_at
     limit v_limit
     for update skip locked
  )
  update public.db_rediscovery_backfill b set lease_until = now() + interval '10 minutes'
    from due where b.tenant_id = due.tenant_id
  returning b.tenant_id;
end $$;
revoke all on function public.claim_db_rediscovery_backfill(integer) from public, anon, authenticated;
grant execute on function public.claim_db_rediscovery_backfill(integer) to service_role;

create or replace function public.ack_db_rediscovery_backfill(p_tenant_ids uuid[])
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  update public.db_rediscovery_backfill set requested_at = now(), lease_until = null
   where tenant_id = any (coalesce(p_tenant_ids, '{}'::uuid[])) and requested_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.ack_db_rediscovery_backfill(uuid[]) from public, anon, authenticated;
grant execute on function public.ack_db_rediscovery_backfill(uuid[]) to service_role;

create or replace function public.db_rediscovery_backfill_backlog()
returns table (pending bigint, oldest timestamptz, seeded boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select (select count(*) from public.db_rediscovery_backfill where requested_at is null),
         (select min(created_at) from public.db_rediscovery_backfill where requested_at is null),
         (select seeded_at is not null from public.db_rediscovery_backfill_state where id = 1);
$$;
revoke all on function public.db_rediscovery_backfill_backlog() from public, anon, authenticated;
grant execute on function public.db_rediscovery_backfill_backlog() to service_role;

create or replace function set_operator_db_connection(
  p_tenant_id uuid,
  p_type text,
  p_connection_string text,
  p_schema_map jsonb
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
  v_new_connection boolean;
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));

  update public.db_connectors set revoked_at = now(), revoked_by = auth.uid()
   where tenant_id = p_tenant_id and revoked_at is null;
  delete from public.db_connector_requests where tenant_id = p_tenant_id;
  update public.db_connector_pair_codes set used_at = now()
   where tenant_id = p_tenant_id and used_at is null;
  update public.db_connector_offline_notices set closed_at = now()
   where tenant_id = p_tenant_id and sent_at is null and closed_at is null;

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  v_new_connection := not exists (select 1 from tenant_db_config where tenant_id = p_tenant_id);
  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at, mode, auto_hide)
  values (p_tenant_id, p_type::operator_db_type, v_secret_key, p_schema_map, now(), 'direct', true)
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    mode = 'direct',
    updated_at = now();

  if v_new_connection then
    insert into tenant_db_settings (tenant_id, raw_results_retention, chat_retention, managed_db_opt_out_at, updated_at)
    values (p_tenant_id, 'run', 'forever', null, now())
    on conflict (tenant_id) do update set
      raw_results_retention = coalesce(tenant_db_settings.raw_results_retention, 'run'),
      chat_retention = coalesce(tenant_db_settings.chat_retention, 'forever'),
      managed_db_opt_out_at = null,
      updated_at = now();
  else
    update tenant_db_settings set managed_db_opt_out_at = null, updated_at = now()
     where tenant_id = p_tenant_id and managed_db_opt_out_at is not null;
  end if;

  perform public._reset_db_policy_for_transition(p_tenant_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (
    p_tenant_id,
    'operator_db',
    p_type,
    'Your database',
    array['read', 'update_status']::text[],
    now(),
    null
  )
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, team_name = 'Your database',
                connected_at = excluded.connected_at, managed_by = null;
  update public.tenant_mcp_servers set enabled = true where tenant_id = p_tenant_id and server_id = 'operator_db';
end $$;
revoke all on function set_operator_db_connection(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function set_operator_db_connection(uuid, text, text, jsonb) to authenticated, service_role;

create or replace function set_managed_operator_db_connection(
  p_tenant_id uuid,
  p_connection_string text
) returns boolean
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
  v_new_connection boolean;
begin
  if p_tenant_id is null or p_connection_string is null or length(p_connection_string) < 8 then
    raise exception 'tenant and connection string are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from tenant_resources
     where tenant_id = p_tenant_id and resource_kind = 'db' and mode = 'provisioned'
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));

  if exists (
    select 1 from tenant_db_settings
     where tenant_id = p_tenant_id and managed_db_opt_out_at is not null
  ) then
    return false;
  end if;

  if exists (
    select 1 from connector_metadata
     where tenant_id = p_tenant_id and slug = 'operator_db'
       and managed_by is distinct from 'zavi'
  ) then
    return false;
  end if;

  update public.db_connector_pair_codes set used_at = now()
   where tenant_id = p_tenant_id and used_at is null;

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  v_new_connection := not exists (select 1 from tenant_db_config where tenant_id = p_tenant_id);
  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at, mode, auto_hide)
  values (p_tenant_id, 'postgres'::operator_db_type, v_secret_key, '{}'::jsonb, now(), 'direct', true)
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    updated_at = now();
  if v_new_connection then
    insert into tenant_db_settings (tenant_id, raw_results_retention, chat_retention, updated_at)
    values (p_tenant_id, 'run', 'forever', now())
    on conflict (tenant_id) do update set
      raw_results_retention = coalesce(tenant_db_settings.raw_results_retention, 'run'),
      chat_retention = coalesce(tenant_db_settings.chat_retention, 'forever'),
      updated_at = now();
  end if;

  perform public._reset_db_policy_for_transition(p_tenant_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (p_tenant_id, 'operator_db', 'postgres', 'Your database', array['read']::text[], now(), 'zavi')
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, team_name = 'Your database',
                connected_at = excluded.connected_at, managed_by = 'zavi'
  where connector_metadata.managed_by = 'zavi';

  return true;
end $$;
revoke all on function set_managed_operator_db_connection(uuid, text) from public, anon, authenticated;
grant execute on function set_managed_operator_db_connection(uuid, text) to service_role;

create or replace function public.disconnect_operator_db(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_key text;
  v_old uuid;
  v_dialect text;
  v_managed text;
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  select c.type::text into v_dialect from public.tenant_db_config c where c.tenant_id = p_tenant_id;
  select m.managed_by into v_managed from public.connector_metadata m where m.tenant_id = p_tenant_id and m.slug = 'operator_db';
  for v_key in
    select key from public.secrets where tenant_id = p_tenant_id and left(key, 12) = 'operator_db.'
  loop
    select vault_secret_id into v_old from public.secrets where tenant_id = p_tenant_id and key = v_key;
    if v_old is not null then
      delete from vault.secrets where id = v_old;
    end if;
    delete from public.secrets where tenant_id = p_tenant_id and key = v_key;
  end loop;
  update public.db_connectors set revoked_at = now(), revoked_by = auth.uid()
   where tenant_id = p_tenant_id and revoked_at is null;
  delete from public.db_connector_requests where tenant_id = p_tenant_id;
  update public.db_connector_pair_codes set used_at = now() where tenant_id = p_tenant_id and used_at is null;
  update public.db_connector_offline_notices set closed_at = now()
   where tenant_id = p_tenant_id and sent_at is null and closed_at is null;
  insert into public.tenant_db_settings (tenant_id, managed_db_opt_out_at, updated_at)
  values (p_tenant_id, case when v_managed = 'zavi' then now() end, now())
  on conflict (tenant_id) do update set
    managed_db_opt_out_at = coalesce(case when v_managed = 'zavi' then now() end, tenant_db_settings.managed_db_opt_out_at),
    updated_at = now();
  delete from public.connector_metadata where tenant_id = p_tenant_id and slug = 'operator_db';
  delete from public.tenant_db_config where tenant_id = p_tenant_id;
  delete from public.tenant_db_catalog where tenant_id = p_tenant_id;
  update public.tenant_mcp_servers set enabled = false where tenant_id = p_tenant_id and server_id = 'operator_db';
  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, auth.uid(), 'clear', 'operator_db.connection', null, null,
          jsonb_build_object('source', 'disconnect_operator_db', 'managed_by', v_managed));
  return jsonb_build_object('dialect', v_dialect, 'managed_by', v_managed);
end $$;
revoke all on function public.disconnect_operator_db(uuid) from public, anon, authenticated;
grant execute on function public.disconnect_operator_db(uuid) to authenticated, service_role;

commit;
