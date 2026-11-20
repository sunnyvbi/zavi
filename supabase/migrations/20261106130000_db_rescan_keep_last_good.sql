begin;
set local lock_timeout = '5s';

create or replace function public._db_catalog_table_count(p_catalog jsonb)
returns integer
language sql immutable set search_path = public, pg_temp as $$
  select case when jsonb_typeof(p_catalog->'tables') = 'array' then jsonb_array_length(p_catalog->'tables') else 0 end
$$;
revoke all on function public._db_catalog_table_count(jsonb) from public, anon, authenticated;
grant execute on function public._db_catalog_table_count(jsonb) to service_role;

alter table public.tenant_db_generation
  add column if not exists source_epoch bigint not null default 0 check (source_epoch >= 0);
comment on column public.tenant_db_generation.source_epoch is
  'Moves on every database SOURCE transition (credential, mode, dialect, connector source, disconnect), never on a policy-only one. A catalog is served only when it was written under the current epoch.';

alter table public.tenant_db_catalog
  add column if not exists source_epoch bigint not null default -1,
  add column if not exists rescan_error text,
  add column if not exists rescan_failed_at timestamptz,
  add column if not exists rescan_attempts integer not null default 0,
  add column if not exists rescan_retry_at timestamptz;
comment on column public.tenant_db_catalog.source_epoch is
  'tenant_db_generation.source_epoch when this catalog was written. A mismatch means another source: the catalog is not served.';
comment on column public.tenant_db_catalog.rescan_error is
  'Why the latest re-scan did not replace this (last good) catalog. Null after a scan that replaced it.';
comment on column public.tenant_db_catalog.rescan_failed_at is
  'When the latest re-scan failed and the last good catalog was kept.';
comment on column public.tenant_db_catalog.rescan_attempts is
  'Re-scans in a row that did not replace this catalog. Drives the retry backoff; 0 after a scan that replaced it.';
comment on column public.tenant_db_catalog.rescan_retry_at is
  'When the connector sweep next re-scans a kept catalog (claim_db_rescan_retries). Null when nothing is due.';

create or replace function public._bump_db_source_epoch(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    return;
  end if;
  update public.tenant_db_generation set source_epoch = source_epoch + 1, updated_at = now()
   where tenant_id = p_tenant_id;
end $$;
revoke all on function public._bump_db_source_epoch(uuid) from public, anon, authenticated;
grant execute on function public._bump_db_source_epoch(uuid) to service_role;

create or replace function public._db_generation_on_config()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    perform public._bump_db_generation(old.tenant_id);
    perform public._bump_db_source_epoch(old.tenant_id);
    return old;
  end if;
  if tg_op = 'INSERT'
     or (old.type, old.mode, old.connection_secret_key, old.disabled_tables, old.hidden_fields,
         old.unhidden_fields, old.auto_hide, old.policy_catalog_hash)
        is distinct from
        (new.type, new.mode, new.connection_secret_key, new.disabled_tables, new.hidden_fields,
         new.unhidden_fields, new.auto_hide, new.policy_catalog_hash) then
    perform public._bump_db_generation(new.tenant_id);
  end if;
  if tg_op = 'INSERT'
     or (old.type, old.mode, old.connection_secret_key) is distinct from (new.type, new.mode, new.connection_secret_key) then
    perform public._bump_db_source_epoch(new.tenant_id);
  end if;
  return new;
end $$;
revoke all on function public._db_generation_on_config() from public, anon, authenticated;

create or replace function public._db_generation_on_connector()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    perform public._bump_db_generation(old.tenant_id);
    perform public._bump_db_source_epoch(old.tenant_id);
    return old;
  end if;
  if tg_op = 'INSERT'
     or (old.revoked_at, old.dialect, old.rules_hash, old.source_instance_id)
        is distinct from (new.revoked_at, new.dialect, new.rules_hash, new.source_instance_id) then
    perform public._bump_db_generation(new.tenant_id);
  end if;
  if tg_op = 'INSERT'
     or (old.revoked_at, old.dialect, old.source_instance_id) is distinct from (new.revoked_at, new.dialect, new.source_instance_id) then
    perform public._bump_db_source_epoch(new.tenant_id);
  end if;
  return new;
end $$;
revoke all on function public._db_generation_on_connector() from public, anon, authenticated;

create or replace function public._reset_db_policy_for_transition(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.tenant_db_catalog where tenant_id = p_tenant_id;
  update public.tenant_db_config
     set auto_hide = true, settings_confirmed_at = null, updated_at = now()
   where tenant_id = p_tenant_id;
  perform public._bump_db_generation(p_tenant_id);
  perform public._bump_db_source_epoch(p_tenant_id);
end $$;
revoke all on function public._reset_db_policy_for_transition(uuid) from public, anon, authenticated;
grant execute on function public._reset_db_policy_for_transition(uuid) to service_role;

create or replace function public.set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text,
  p_coverage jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_catalog jsonb := coalesce(p_catalog, '{}'::jsonb);
  v_hints   jsonb := coalesce(p_hints,   '{}'::jsonb);
  v_cov     jsonb := coalesce(p_coverage, '{}'::jsonb);
  v_hash    text  := md5(p_dialect || v_catalog::text || v_hints::text);
  v_epoch   bigint := coalesce((select g.source_epoch from public.tenant_db_generation g where g.tenant_id = p_tenant_id), 0);
begin
  insert into public.tenant_db_catalog (
    tenant_id, dialect, catalog, hints, catalog_hash, coverage,
    discovery_error, discovered_at, updated_at, source_epoch, rescan_error, rescan_failed_at,
    rescan_attempts, rescan_retry_at
  )
  values (
    p_tenant_id, p_dialect::operator_db_type, v_catalog, v_hints, v_hash, v_cov,
    p_discovery_error,
    case when p_discovery_error is null then now() else null end,
    now(), v_epoch, null, null, 0, null
  )
  on conflict (tenant_id)
  do update set
    dialect = excluded.dialect,
    catalog = excluded.catalog,
    hints = excluded.hints,
    catalog_hash = excluded.catalog_hash,
    coverage = excluded.coverage,
    discovery_error = excluded.discovery_error,
    discovered_at = case when excluded.discovery_error is null then now() else null end,
    updated_at = now(),
    source_epoch = excluded.source_epoch,
    rescan_error = null,
    rescan_failed_at = null,
    rescan_attempts = 0,
    rescan_retry_at = null;
end $$;
revoke all on function public.set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb) to service_role;

create or replace function public.apply_tenant_db_scan(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text,
  p_coverage jsonb,
  p_generation bigint
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_epoch bigint;
  v_prev_catalog jsonb;
  v_prev_epoch bigint;
  v_attempts integer;
  v_found boolean;
  v_gen bigint;
  v_prev_n integer := 0;
  v_new_n integer := 0;
  v_partial boolean;
begin
  if p_generation is null then
    raise exception 'generation is required' using errcode = '22023';
  end if;
  perform set_config('lock_timeout', '500ms', true);
  select c.catalog, c.source_epoch, c.rescan_attempts into v_prev_catalog, v_prev_epoch, v_attempts
    from public.tenant_db_catalog c where c.tenant_id = p_tenant_id for update nowait;
  v_found := found;
  select g.generation into v_gen from public.tenant_db_generation g where g.tenant_id = p_tenant_id for share nowait;
  if not found then
    v_gen := public._lock_db_generation(p_tenant_id);
  end if;
  if v_gen <> p_generation then
    return 'stale';
  end if;
  select g.source_epoch into v_epoch from public.tenant_db_generation g where g.tenant_id = p_tenant_id;
  v_epoch := coalesce(v_epoch, 0);

  if v_found and v_prev_epoch = v_epoch then
    v_prev_n := public._db_catalog_table_count(v_prev_catalog);
  end if;
  if p_discovery_error is null then
    v_new_n := public._db_catalog_table_count(p_catalog);
  end if;
  v_partial := coalesce(p_coverage->>'deadline_hit', 'false') = 'true';

  if v_prev_n > 0 and (p_discovery_error is not null or v_new_n = 0 or v_partial) then
    v_attempts := coalesce(v_attempts, 0) + 1;
    update public.tenant_db_catalog
       set rescan_error = left(coalesce(
             p_discovery_error,
             case when v_new_n = 0 then 'The latest scan found no tables'
                  else format('The latest scan did not finish (%s tables read)', v_new_n) end), 500),
           rescan_failed_at = now(),
           rescan_attempts = v_attempts,
           rescan_retry_at = now() + interval '1 hour' * least(24, power(2, least(v_attempts - 1, 5))::integer),
           discovery_error = null
     where tenant_id = p_tenant_id;
    return 'kept_last_good';
  end if;

  perform public.set_tenant_db_catalog(p_tenant_id, p_dialect, p_catalog, p_hints, p_discovery_error, p_coverage);
  return case when p_discovery_error is null then 'stored' else 'stored_error' end;
end $$;
revoke all on function public.apply_tenant_db_scan(uuid, text, jsonb, jsonb, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.apply_tenant_db_scan(uuid, text, jsonb, jsonb, text, jsonb, bigint) to service_role;

create or replace function public.set_tenant_db_catalog(
  p_tenant_id uuid,
  p_dialect text,
  p_catalog jsonb,
  p_hints jsonb,
  p_discovery_error text,
  p_coverage jsonb,
  p_generation bigint
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.apply_tenant_db_scan(p_tenant_id, p_dialect, p_catalog, p_hints, p_discovery_error, p_coverage, p_generation) <> 'stale';
end $$;
revoke all on function public.set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.set_tenant_db_catalog(uuid, text, jsonb, jsonb, text, jsonb, bigint) to service_role;

create or replace function public.stamp_tenant_db_discovery_error(p_tenant_id uuid, p_error text, p_generation bigint)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_gen bigint;
begin
  if p_generation is null then
    raise exception 'generation is required' using errcode = '22023';
  end if;
  perform set_config('lock_timeout', '500ms', true);
  perform 1 from public.tenant_db_catalog where tenant_id = p_tenant_id for update nowait;
  select g.generation into v_gen from public.tenant_db_generation g where g.tenant_id = p_tenant_id for share nowait;
  if not found then
    v_gen := public._lock_db_generation(p_tenant_id);
  end if;
  if v_gen <> p_generation then
    return false;
  end if;
  update public.tenant_db_catalog
     set rescan_error = case when public._db_catalog_table_count(catalog) > 0 then left(p_error, 500) else rescan_error end,
         rescan_failed_at = case when public._db_catalog_table_count(catalog) > 0 then now() else rescan_failed_at end,
         rescan_attempts = case when public._db_catalog_table_count(catalog) > 0 then rescan_attempts + 1 else rescan_attempts end,
         rescan_retry_at = case when public._db_catalog_table_count(catalog) > 0
                                then now() + interval '1 hour' * least(24, power(2, least(rescan_attempts, 5))::integer)
                                else rescan_retry_at end,
         discovery_error = case when public._db_catalog_table_count(catalog) > 0 then null else left(p_error, 500) end,
         updated_at = now()
   where tenant_id = p_tenant_id;
  return true;
end $$;
revoke all on function public.stamp_tenant_db_discovery_error(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.stamp_tenant_db_discovery_error(uuid, text, bigint) to service_role;

create or replace function public.claim_db_rescan_retries(p_limit integer default 50)
returns table (tenant_id uuid, failed_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 1000));
begin
  return query
  with due as (
    select c.tenant_id, coalesce(c.rescan_failed_at, c.rescan_retry_at) as failed_at
      from public.tenant_db_catalog c
     where c.rescan_retry_at is not null and c.rescan_retry_at <= now()
     order by c.rescan_retry_at
     limit v_limit
     for update skip locked
  )
  update public.tenant_db_catalog c set rescan_retry_at = now() + interval '30 minutes'
    from due where c.tenant_id = due.tenant_id
  returning c.tenant_id, due.failed_at;
end $$;
revoke all on function public.claim_db_rescan_retries(integer) from public, anon, authenticated;
grant execute on function public.claim_db_rescan_retries(integer) to service_role;

commit;

begin;

update public.tenant_db_catalog c
   set source_epoch = g.source_epoch
  from public.tenant_db_generation g
 where g.tenant_id = c.tenant_id
   and (c.discovered_at >= (select min(g2.updated_at) from public.tenant_db_generation g2)
        or public._db_catalog_table_count(c.catalog) = 0);

create temporary table _db_unproven_catalogs on commit drop as
  with gone as (
    delete from public.tenant_db_catalog c
     where c.source_epoch = -1 and public._db_catalog_table_count(c.catalog) > 0
    returning c.tenant_id
  )
  select gone.tenant_id, cfg.mode
    from gone join public.tenant_db_config cfg on cfg.tenant_id = gone.tenant_id;
insert into public.db_rediscovery_backfill (tenant_id, created_at)
select u.tenant_id, now() from _db_unproven_catalogs u where u.mode = 'direct'
on conflict (tenant_id) do update
  set created_at = excluded.created_at, requested_at = null, lease_until = null;
insert into public.db_connector_discovery_outbox as o (tenant_id, generation, requested_at, lease_until, attempts)
select u.tenant_id, 1, now(), null, 0 from _db_unproven_catalogs u where u.mode = 'connector'
on conflict (tenant_id) do update
  set generation = o.generation + 1, requested_at = now(), lease_until = null;

update public.tenant_db_catalog
   set rescan_error = discovery_error,
       rescan_failed_at = coalesce(updated_at, now()),
       rescan_attempts = 1,
       rescan_retry_at = now(),
       discovery_error = null
 where discovery_error is not null
   and public._db_catalog_table_count(catalog) > 0;

insert into public.db_rediscovery_backfill (tenant_id, created_at)
select c.tenant_id, now()
  from public.tenant_db_catalog c
  join public.tenant_db_config cfg on cfg.tenant_id = c.tenant_id and cfg.mode = 'direct'
 where public._db_catalog_table_count(c.catalog) = 0
on conflict (tenant_id) do update
  set created_at = excluded.created_at, requested_at = null, lease_until = null;

commit;
