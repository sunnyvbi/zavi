
begin;

create schema if not exists api;
revoke all on schema api from public;

create or replace function zsite.project(p_fields jsonb, r zsite.records) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'data', coalesce((
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(r.data) e
      where not coalesce(p_fields->e.key ? 'read', false)
         or zsite.principal_match(p_fields->e.key->'read', r.owner_id)
    ), '{}'::jsonb),
    'mine', coalesce(r.owner_id is not null
                     and r.owner_id = (select m.user_id from zsite.request_member() m), false),
    'created_at', r.created_at,
    'updated_at', r.updated_at)
$$;

create or replace function zsite.idempotent_replay(p_collection text, p_key text, p_hash text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_site uuid := zsite.request_site(); v_id uuid; v_hash text;
begin
  if v_site is null then
    raise exception 'no_site' using errcode = '42501';
  end if;
  select r.id, r.idempotency_hash into v_id, v_hash
  from zsite.records r
  where r.site_id = v_site and r.collection = p_collection and r.idempotency_key = p_key;
  if v_id is not null and v_hash is distinct from p_hash then
    raise exception 'idempotency_conflict' using errcode = '22023';
  end if;
  return v_id;
end $$;

create or replace function zsite.require_site() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare v uuid := zsite.request_site();
begin
  if v is null then
    raise exception 'no_site' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function api.list_records(
  p_collection text,
  p_filter jsonb default '{}'::jsonb,
  p_limit integer default 50,
  p_cursor text default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  c zsite.collections;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_me uuid;
  v_owner uuid;
  f text[] := array[null, null, null]::text[];
  k text; v jsonb; slot text;
  v_ts timestamptz; v_id uuid;
  v_sql text;
  v_rows zsite.records[];
  v_items jsonb := '[]'::jsonb;
  v_next text;
  i integer;
begin
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records';
  if not found then
    raise exception 'unknown_collection' using errcode = '42501';
  end if;

  if p_filter is null then p_filter := '{}'::jsonb; end if;
  if jsonb_typeof(p_filter) <> 'object' then
    raise exception 'invalid_filter' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_filter) e loop
    slot := c.indexes->>k;
    if slot is null then
      raise exception 'filter_not_allowed' using errcode = '22023';
    end if;
    if coalesce(c.fields->k ? 'read', false)
       and not zsite.principal_match(c.fields->k->'read', null) then
      raise exception 'filter_not_allowed' using errcode = '22023';
    end if;
    if jsonb_typeof(v) not in ('string', 'number', 'boolean') then
      raise exception 'invalid_filter' using errcode = '22023';
    end if;
    f[substr(slot, 2)::int] := v #>> '{}';
  end loop;

  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{1,19}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_cursor' using errcode = '22023';
    end if;
    v_ts := 'epoch'::timestamptz + (split_part(p_cursor, ':', 1) || ' microseconds')::interval;
    v_id := split_part(p_cursor, ':', 2)::uuid;
  end if;

  v_me := (select m.user_id from zsite.request_member() m);
  if not zsite.principal_match(c.rules->'list', null) then
    if v_me is not null and coalesce(c.rules->'list' ? 'owner', false) then
      v_owner := v_me;
    else
      return jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null);
    end if;
  end if;

  v_sql := 'select array_agg(s.r order by (s.r).created_at desc, (s.r).id desc) from ('
        || 'select r from zsite.records r where r.site_id = $1 and r.collection = $2'
        || ' and zsite.permits(r.collection, ''list'', r.owner_id)';
  if v_owner is not null then v_sql := v_sql || ' and r.owner_id = $3'; end if;
  if f[1] is not null then v_sql := v_sql || ' and r.idx_s1 = $4'; end if;
  if f[2] is not null then v_sql := v_sql || ' and r.idx_s2 = $5'; end if;
  if f[3] is not null then v_sql := v_sql || ' and r.idx_s3 = $6'; end if;
  if v_ts is not null then v_sql := v_sql || ' and (r.created_at, r.id) < ($7, $8)'; end if;
  v_sql := v_sql || ' order by r.created_at desc, r.id desc limit $9) s';

  execute v_sql into v_rows
    using v_site, p_collection, v_owner, f[1], f[2], f[3], v_ts, v_id, v_lim + 1;

  if v_rows is not null then
    for i in 1 .. least(array_length(v_rows, 1), v_lim) loop
      v_items := v_items || jsonb_build_array(zsite.project(c.fields, v_rows[i]));
    end loop;
    if array_length(v_rows, 1) > v_lim then
      v_next := ((extract(epoch from v_rows[v_lim].created_at) * 1000000)::bigint)::text
             || ':' || v_rows[v_lim].id::text;
    end if;
  end if;

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end $$;

create or replace function api.get_record(p_collection text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_site uuid := zsite.require_site(); c zsite.collections; r zsite.records;
begin
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records';
  if not found then return null; end if;
  select * into r from zsite.records x
  where x.site_id = v_site and x.collection = p_collection and x.id = p_id
    and zsite.permits(x.collection, 'get', x.owner_id);
  if not found then return null; end if;
  return zsite.project(c.fields, r);
end $$;

create or replace function api.create_record(
  p_collection text, p_data jsonb, p_idempotency_key text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_me uuid := (select m.user_id from zsite.request_member() m);
  v_id uuid := gen_random_uuid();
  v_hash text;
  v_prev uuid;
  v_constraint text;
begin
  if v_me is null and p_idempotency_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    v_hash := zsite.idem_hash(v_me, p_collection, p_data);
  end if;

  if p_idempotency_key is not null then
    v_prev := zsite.idempotent_replay(p_collection, p_idempotency_key, v_hash);
    if v_prev is not null then
      return jsonb_build_object('id', v_prev, 'replayed', true);
    end if;
  end if;

  begin
    insert into zsite.records (site_id, collection, id, data, idempotency_key)
    values (v_site, p_collection, v_id, p_data, p_idempotency_key);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'records_idem_uidx' then
      raise;
    end if;
    v_prev := zsite.idempotent_replay(p_collection, p_idempotency_key, v_hash);
    if v_prev is null then
      raise;
    end if;
    return jsonb_build_object('id', v_prev, 'replayed', true);
  end;
  return jsonb_build_object('id', v_id, 'replayed', false);
end $$;

create or replace function api.update_record(p_collection text, p_id uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_site uuid := zsite.require_site(); v_old jsonb; v_new jsonb; n integer;
begin
  if zsite.request_user() is null then
    raise exception 'anonymous_write_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'invalid_patch' using errcode = '22023';
  end if;
  select r.data into v_old from zsite.records r
  where r.site_id = v_site and r.collection = p_collection and r.id = p_id
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_new
  from jsonb_each(v_old || p_patch) e where jsonb_typeof(e.value) <> 'null';

  update zsite.records r set data = v_new
  where r.site_id = v_site and r.collection = p_collection and r.id = p_id;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'updated', true);
end $$;

create or replace function api.delete_record(p_collection text, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_site uuid := zsite.require_site(); n integer;
begin
  if zsite.request_user() is null then
    raise exception 'anonymous_write_forbidden' using errcode = '42501';
  end if;
  delete from zsite.records r
  where r.site_id = v_site and r.collection = p_collection and r.id = p_id;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'deleted', true);
end $$;

grant create on schema api to zsite_facade;
alter function api.list_records(text, jsonb, integer, text) owner to zsite_facade;
alter function api.get_record(text, uuid) owner to zsite_facade;
alter function api.create_record(text, jsonb, text) owner to zsite_facade;
alter function api.update_record(text, uuid, jsonb) owner to zsite_facade;
alter function api.delete_record(text, uuid) owner to zsite_facade;
revoke create on schema api from zsite_facade;

revoke all on all functions in schema api from public;
alter default privileges in schema api revoke execute on functions from public;
grant usage on schema api to anon, authenticated;
grant execute on function
  api.list_records(text, jsonb, integer, text),
  api.get_record(text, uuid),
  api.create_record(text, jsonb, text),
  api.update_record(text, uuid, jsonb),
  api.delete_record(text, uuid)
  to anon, authenticated;

revoke all on function zsite.project(jsonb, zsite.records), zsite.idempotent_replay(text, text, text),
  zsite.require_site() from public;
grant execute on function zsite.project(jsonb, zsite.records), zsite.idempotent_replay(text, text, text),
  zsite.require_site() to zsite_facade;
grant usage on schema api to zsite_facade;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'graphql_public') then
    execute 'revoke usage on schema graphql_public from anon, authenticated';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'graphql') then
    execute 'revoke usage on schema graphql from anon, authenticated';
  end if;
end $$;

insert into zsite.migrations (version) values ('0002_api') on conflict do nothing;

commit;
