
begin;

alter table zsite.migrations add column if not exists checksum text;
alter table zsite.migrations drop constraint if exists migrations_checksum_hex;
alter table zsite.migrations add constraint migrations_checksum_hex
  check (checksum is null or checksum ~ '^[0-9a-f]{64}$');

update zsite.migrations m set checksum = x.sha
from (values
  ('0001_core', 'a7d7ead171e6f4475cf429f1426eb73ca609cfeb18c966019e2da6a9a0ed5fb6'),
  ('0002_api', '340501ae24ec25346470cf6572d240126ac2a2484258204fd430fc21be4afa11'),
  ('0003_storage', '910304d3e6b43ee8b14ad74f81240ad2db4d71fac9ffef2e5632167063197945'),
  ('0004_membership_slots_perf', '0befc3086c39359a28ab4bed93b4a5cad6ccdc3fed259f10083246a8e61b9f34')
) as x(version, sha)
where m.version = x.version and m.checksum is null;

create or replace function zsite.record_migration(p_version text, p_checksum text) returns text
language plpgsql security invoker set search_path = '' as $$
declare v_on text;
begin
  if p_version !~ '^[0-9]{4}_[a-z0-9_]{1,60}$' or coalesce(p_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_migration_record' using errcode = '22023';
  end if;
  insert into zsite.migrations (version, checksum) values (p_version, p_checksum)
  on conflict (version) do update set checksum = excluded.checksum
    where zsite.migrations.checksum is null;
  select m.checksum into v_on from zsite.migrations m where m.version = p_version;
  if v_on is distinct from p_checksum then
    raise exception 'checksum_mismatch: % was applied with %', p_version, v_on using errcode = '55000';
  end if;
  return v_on;
end $$;
revoke all on function zsite.record_migration(text, text) from public, anon, authenticated, zsite_facade;
grant execute on function zsite.record_migration(text, text) to service_role;
grant select, insert, update on zsite.migrations to service_role;

create or replace function zsite.json_int_between(v jsonb, lo numeric, hi numeric) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return coalesce(jsonb_typeof(v) = 'number'
     and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
     and (v #>> '{}')::numeric between lo and hi, false);
end $$;

create or replace function zsite.valid_property(p jsonb, p_in_array boolean) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare t text;
begin
  if jsonb_typeof(p) is distinct from 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k
             where k not in ('type', 'maxLength', 'minLength', 'enum', 'minimum', 'maximum',
                             'format', 'items', 'maxItems')) then
    return false;
  end if;
  if jsonb_typeof(p->'type') is distinct from 'string' then return false; end if;
  t := p->>'type';
  if t = 'string' then
    if not zsite.json_int_between(p->'maxLength', 1, 10000) then return false; end if;
    if p ? 'minLength' then
      if not zsite.json_int_between(p->'minLength', 0, 10000) then return false; end if;
      if (p->>'minLength')::numeric > (p->>'maxLength')::numeric then return false; end if;
    end if;
    if p ? 'format' and not coalesce(jsonb_typeof(p->'format') = 'string'
                                      and (p->>'format') in ('email', 'date', 'date-time', 'uuid'), false) then
      return false;
    end if;
    if p ? 'enum' and not coalesce(jsonb_typeof(p->'enum') = 'array'
                                    and jsonb_array_length(p->'enum') between 1 and 100
                                    and not exists (select 1 from jsonb_array_elements(p->'enum') e
                                                    where jsonb_typeof(e) is distinct from 'string'), false) then
      return false;
    end if;
    return not (p ? 'minimum' or p ? 'maximum' or p ? 'items' or p ? 'maxItems');
  elsif t in ('integer', 'number') then
    if p ? 'minimum' and jsonb_typeof(p->'minimum') is distinct from 'number' then return false; end if;
    if p ? 'maximum' and jsonb_typeof(p->'maximum') is distinct from 'number' then return false; end if;
    if p ? 'minimum' and p ? 'maximum' and (p->>'minimum')::numeric > (p->>'maximum')::numeric then
      return false;
    end if;
    return not (p ? 'maxLength' or p ? 'minLength' or p ? 'format' or p ? 'enum' or p ? 'items' or p ? 'maxItems');
  elsif t = 'boolean' then
    return (select count(*) from jsonb_object_keys(p)) = 1;
  elsif t = 'array' and not p_in_array then
    if not zsite.json_int_between(p->'maxItems', 1, 100) then return false; end if;
    if not p ? 'items' then return false; end if;
    return coalesce(zsite.valid_property(p->'items', true), false)
       and not (p ? 'maxLength' or p ? 'minLength' or p ? 'format' or p ? 'enum' or p ? 'minimum' or p ? 'maximum');
  end if;
  return false;
end $$;

create or replace function zsite.valid_collection_strict(
  p_kind text, p_rules jsonb, p_schema jsonb, p_fields jsonb, p_indexes jsonb
) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return coalesce(zsite.valid_collection(p_kind, p_rules, p_schema, p_fields, p_indexes), false);
end $$;
revoke all on function zsite.json_int_between(jsonb, numeric, numeric),
  zsite.valid_collection_strict(text, jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function zsite.json_int_between(jsonb, numeric, numeric),
  zsite.valid_collection_strict(text, jsonb, jsonb, jsonb, jsonb)
  to anon, authenticated, service_role, zsite_facade;

alter table zsite.collections add column if not exists archived_at timestamptz;
alter table zsite.collections add column if not exists slots_gen integer not null default 0;
alter table zsite.collections add column if not exists reindex_pending boolean not null default false;

alter table zsite.collections drop constraint if exists collections_valid;
alter table zsite.collections add constraint collections_valid
  check (zsite.valid_collection_strict(kind, rules, schema, fields, indexes)) not valid;
do $$
begin
  insert into zsite.migration_notices (migration, site_id, collection, action)
  select '0005', c.site_id, c.name, 'collection_fails_strict_check_constraint_left_not_valid'
  from zsite.collections c
  where not zsite.valid_collection_strict(c.kind, c.rules, c.schema, c.fields, c.indexes);
  if not found then
    alter table zsite.collections validate constraint collections_valid;
  end if;
end $$;

create or replace function zsite.request_grants() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  c jsonb := zsite.request_ctx();
  v_signed boolean := (c->>'uid') is not null;
  v_uid uuid := (c->>'uid')::uuid;
  x record;
  la text[] := '{}'; lo text[] := '{}'; ga text[] := '{}'; go text[] := '{}'; cr text[] := '{}';
  ua text[] := '{}'; uo text[] := '{}'; da text[] := '{}'; dw text[] := '{}';
begin
  if (c->>'site') is not null then
    for x in select y.name, y.rules from zsite.collections y
             where y.site_id = (c->>'site')::uuid and y.kind = 'records' and y.archived_at is null loop
      if zsite.ctx_match(c, x.rules->'list', null) then la := la || x.name; end if;
      if zsite.ctx_match(c, x.rules->'get', null) then ga := ga || x.name; end if;
      if zsite.ctx_match(c, x.rules->'create', v_uid) then cr := cr || x.name; end if;
      if v_signed then
        if coalesce(x.rules->'list' ? 'owner', false) then lo := lo || x.name; end if;
        if coalesce(x.rules->'get' ? 'owner', false) then go := go || x.name; end if;
        if zsite.ctx_match(c, x.rules->'update', null) then ua := ua || x.name; end if;
        if coalesce(x.rules->'update' ? 'owner', false) then uo := uo || x.name; end if;
        if zsite.ctx_match(c, x.rules->'delete', null) then da := da || x.name; end if;
        if coalesce(x.rules->'delete' ? 'owner', false) then dw := dw || x.name; end if;
      end if;
    end loop;
  end if;
  return jsonb_build_object('uid', c->'uid',
    'list_all', to_jsonb(la), 'list_own', to_jsonb(lo), 'get_all', to_jsonb(ga), 'get_own', to_jsonb(go),
    'create', to_jsonb(cr), 'update_all', to_jsonb(ua), 'update_own', to_jsonb(uo),
    'delete_all', to_jsonb(da), 'delete_own', to_jsonb(dw));
end $$;

create or replace function zsite.tg_records_before() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_end_user boolean := pg_catalog.current_setting('role', true) in ('anon', 'authenticated');
  v_ctx jsonb;
  v_member uuid;
  c zsite.collections;
  k text;
  w jsonb;
  v_owner uuid;
  v_inv jsonb;
  v_data_changed boolean := TG_OP = 'INSERT' or NEW.data is distinct from OLD.data;
begin
  if v_end_user then
    v_ctx := zsite.request_ctx();
    if (v_ctx->>'site') is null or NEW.site_id::text is distinct from v_ctx->>'site' then
      raise exception 'site_mismatch' using errcode = '42501';
    end if;
    v_member := (v_ctx->>'uid')::uuid;

    if TG_OP = 'INSERT' then
      if NEW.owner_id is not null and NEW.owner_id is distinct from v_member then
        raise exception 'owner_id_is_server_assigned' using errcode = '42501';
      end if;
      NEW.owner_id := v_member;
      NEW.created_at := now();
      NEW.idempotency_hash := case when NEW.idempotency_key is not null
                                   then zsite.idem_hash(v_member, NEW.collection, NEW.data) end;
    else
      if NEW.site_id is distinct from OLD.site_id
         or NEW.collection is distinct from OLD.collection
         or NEW.id is distinct from OLD.id
         or NEW.owner_id is distinct from OLD.owner_id
         or NEW.created_at is distinct from OLD.created_at
         or NEW.idempotency_key is distinct from OLD.idempotency_key
         or NEW.idempotency_hash is distinct from OLD.idempotency_hash then
        raise exception 'system_field_immutable' using errcode = '42501';
      end if;
    end if;
  elsif TG_OP = 'INSERT' then
    NEW.idempotency_hash := case when NEW.idempotency_key is not null
                                 then zsite.idem_hash(NEW.owner_id, NEW.collection, NEW.data) end;
  elsif NEW.site_id is distinct from OLD.site_id
        or NEW.collection is distinct from OLD.collection
        or NEW.id is distinct from OLD.id then
    raise exception 'system_field_immutable' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock_shared(zsite.manifest_lock_key(NEW.site_id, NEW.collection));
  select * into c from zsite.collections x
  where x.site_id = NEW.site_id and x.name = NEW.collection;
  if not found or c.kind <> 'records' or (v_end_user and c.archived_at is not null) then
    raise exception 'unknown_collection' using errcode = '42501';
  end if;

  if v_end_user then
    v_owner := case when TG_OP = 'INSERT' then NEW.owner_id else OLD.owner_id end;
    for k, w in select f.key, f.value->'write' from jsonb_each(c.fields) f where f.value ? 'write' loop
      if (TG_OP = 'INSERT' and NEW.data ? k)
         or (TG_OP = 'UPDATE' and (NEW.data->k) is distinct from (OLD.data->k)) then
        if not zsite.ctx_match(v_ctx, w, v_owner) then
          raise exception 'field_not_writable: %', k using errcode = '42501';
        end if;
      end if;
    end loop;
  end if;

  if v_data_changed then
    perform zsite.validate_doc(c.schema, NEW.data);
    NEW.updated_at := now();
  end if;

  select coalesce(jsonb_object_agg(e.value, e.key), '{}'::jsonb) into v_inv
  from jsonb_each_text(c.index_slots) e;
  NEW.t1 := zsite.slot_text(NEW.data -> (v_inv->>'t1'));
  NEW.t2 := zsite.slot_text(NEW.data -> (v_inv->>'t2'));
  NEW.t3 := zsite.slot_text(NEW.data -> (v_inv->>'t3'));
  NEW.n1 := zsite.slot_num(NEW.data -> (v_inv->>'n1'));
  NEW.n2 := zsite.slot_num(NEW.data -> (v_inv->>'n2'));
  NEW.d1 := zsite.slot_ts(NEW.data -> (v_inv->>'d1'));
  NEW.d2 := zsite.slot_ts(NEW.data -> (v_inv->>'d2'));
  NEW.bytes := octet_length(NEW.data::text);
  return NEW;
end $$;

create or replace function zsite.file_permits(p_name text, p_op text, p_owner text) returns boolean
language plpgsql stable security invoker set search_path = '' as $$
declare r jsonb;
begin
  select c.rules into r
  from zsite.collections c
  where c.site_id = zsite.request_site()
    and c.site_id = zsite.file_path_site(p_name)
    and c.name = split_part(p_name, '/', 2)
    and c.kind = 'files'
    and c.archived_at is null;
  if r is null then return false; end if;
  return zsite.principal_match(r->p_op, case when zsite.is_uuid(p_owner) then p_owner::uuid end);
end $$;

create or replace function zsite.tg_collections_slots() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    perform pg_advisory_xact_lock(zsite.manifest_lock_key(OLD.site_id, OLD.name));
  end if;
  NEW.index_slots := zsite.assign_slots(NEW.indexes,
                       case when TG_OP = 'UPDATE' then OLD.index_slots else '{}'::jsonb end);
  if TG_OP = 'UPDATE' and NEW.index_slots is distinct from OLD.index_slots then
    NEW.slots_gen := OLD.slots_gen + 1;
    NEW.reindex_pending := exists (select 1 from zsite.records r
                                   where r.site_id = NEW.site_id and r.collection = NEW.name);
  end if;
  NEW.updated_at := now();
  return NEW;
end $$;

drop trigger if exists collections_rematerialize on zsite.collections;

create or replace function zsite.reindex_batch(
  p_site uuid, p_collection text, p_after uuid, p_gen integer, p_batch integer default 2000
) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare v_gen integer; v_last uuid; n integer; v_ids uuid[];
begin
  select c.slots_gen into v_gen from zsite.collections c
  where c.site_id = p_site and c.name = p_collection and c.kind = 'records';
  if not found then
    raise exception 'unknown_collection' using errcode = '42704';
  end if;
  if p_gen is not null and p_gen <> v_gen then
    return jsonb_build_object('next_after', null, 'gen', v_gen, 'rows', 0, 'done', false, 'restart', true);
  end if;

  if p_after is null then
    select array_agg(x.id order by x.id) into v_ids from (
      select r.id from zsite.records r
      where r.site_id = p_site and r.collection = p_collection
      order by r.id limit least(greatest(coalesce(p_batch, 2000), 1), 10000)) x;
  else
    select array_agg(x.id order by x.id) into v_ids from (
      select r.id from zsite.records r
      where r.site_id = p_site and r.collection = p_collection and r.id > p_after
      order by r.id limit least(greatest(coalesce(p_batch, 2000), 1), 10000)) x;
  end if;
  n := coalesce(array_length(v_ids, 1), 0);
  if n > 0 then
    update zsite.records r set t1 = r.t1
    where r.site_id = p_site and r.collection = p_collection and r.id = any (v_ids);
    v_last := v_ids[n];
  end if;

  if n > 0 then
    return jsonb_build_object('next_after', v_last, 'gen', v_gen, 'rows', n, 'done', false, 'restart', false);
  end if;

  perform pg_advisory_xact_lock(zsite.manifest_lock_key(p_site, p_collection));
  update zsite.collections c set reindex_pending = false
  where c.site_id = p_site and c.name = p_collection and c.slots_gen = v_gen;
  if not found then
    return jsonb_build_object('next_after', null, 'gen', null, 'rows', 0, 'done', false, 'restart', true);
  end if;
  return jsonb_build_object('next_after', null, 'gen', v_gen, 'rows', 0, 'done', true, 'restart', false);
end $$;

create or replace procedure zsite.reindex_collection(p_site uuid, p_collection text, p_batch integer default 2000)
language plpgsql security invoker as $$
declare r jsonb; v_after uuid; v_gen integer;
begin
  loop
    perform pg_catalog.set_config('search_path', '', true);
    r := zsite.reindex_batch(p_site, p_collection, v_after, v_gen, p_batch);
    commit;
    exit when (r->>'done')::boolean;
    if (r->>'restart')::boolean then
      v_after := null; v_gen := null;
    else
      v_after := (r->>'next_after')::uuid; v_gen := (r->>'gen')::integer;
    end if;
  end loop;
end $$;

revoke all on function zsite.reindex_batch(uuid, text, uuid, integer, integer) from public, anon, authenticated, zsite_facade;
revoke all on procedure zsite.reindex_collection(uuid, text, integer) from public, anon, authenticated, zsite_facade;
grant execute on function zsite.reindex_batch(uuid, text, uuid, integer, integer) to service_role;
grant execute on procedure zsite.reindex_collection(uuid, text, integer) to service_role;

create or replace function api.list_records(
  p_collection text,
  p_filter jsonb default '{}'::jsonb,
  p_limit integer default 50,
  p_cursor text default null,
  p_sort text default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  c zsite.collections;
  v_ctx jsonb := zsite.request_ctx();
  v_g jsonb := zsite.request_grants();
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_owner uuid;
  v_tv text[] := '{}'; v_nv numeric[] := '{}'; v_dv timestamptz[] := '{}';
  v_where text := '';
  k text; v jsonb; op text; ov jsonb; def jsonb; typ text; col text; x jsonb;
  i0 integer;
  v_nfields integer := 0;
  v_sort_field text; v_sort_desc boolean := false; v_sort_col text; v_sort_typ text;
  v_cur jsonb; v_cts timestamptz; v_cid uuid;
  v_cs_t text; v_cs_n numeric; v_cs_d timestamptz;
  v_order text;
  v_sql text;
  v_rows zsite.records[];
  v_items jsonb := '[]'::jsonb;
  v_next text;
  v_last jsonb;
  i integer;
begin
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records' and x.archived_at is null;
  if not found then
    raise exception 'unknown_collection' using errcode = '42501';
  end if;

  if not (v_g->'list_all') ? p_collection then
    if (v_g->'list_own') ? p_collection then
      v_owner := (v_g->>'uid')::uuid;
      v_where := v_where || ' and r.owner_id = $3';
    else
      return jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null);
    end if;
  end if;

  if c.reindex_pending and (coalesce(p_filter, '{}'::jsonb) <> '{}'::jsonb or p_sort is not null) then
    raise exception 'index_building' using errcode = '55000';
  end if;

  if p_filter is null then p_filter := '{}'::jsonb; end if;
  if jsonb_typeof(p_filter) <> 'object' then
    raise exception 'invalid_filter' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_filter) e loop
    v_nfields := v_nfields + 1;
    if v_nfields > 4 then
      raise exception 'invalid_filter' using errcode = '22023';
    end if;
    def := c.indexes->k;
    col := zsite.slot_col(c.index_slots->>k);
    if def is null or col is null
       or (coalesce(c.fields->k ? 'read', false) and not zsite.ctx_match(v_ctx, c.fields->k->'read', null)) then
      raise exception 'filter_not_allowed' using errcode = '22023';
    end if;
    typ := def->>'type';
    if jsonb_typeof(v) <> 'object' then
      v := jsonb_build_object('eq', v);
    end if;
    for op, ov in select e.key, e.value from jsonb_each(v) e loop
      if not (def->'ops') ? (case when op in ('gt', 'gte', 'lt', 'lte') then 'range' else op end) then
        raise exception 'filter_not_allowed' using errcode = '22023';
      end if;
      if op = 'in' then
        if jsonb_typeof(ov) <> 'array' or jsonb_array_length(ov) not between 1 and 50 then
          raise exception 'invalid_filter' using errcode = '22023';
        end if;
      elsif op = 'prefix' then
        if jsonb_typeof(ov) <> 'string' or length(ov #>> '{}') < 1 then
          raise exception 'invalid_filter' using errcode = '22023';
        end if;
      elsif op not in ('eq', 'gt', 'gte', 'lt', 'lte') then
        raise exception 'filter_not_allowed' using errcode = '22023';
      end if;
      i0 := case typ when 'text' then coalesce(array_length(v_tv, 1), 0)
                     when 'number' then coalesce(array_length(v_nv, 1), 0)
                     else coalesce(array_length(v_dv, 1), 0) end + 1;
      for x in select y from jsonb_array_elements(case when op = 'in' then ov else jsonb_build_array(ov) end) y loop
        if typ = 'text' then
          if jsonb_typeof(x) not in ('string', 'boolean') then
            raise exception 'invalid_filter' using errcode = '22023';
          end if;
          v_tv := v_tv || zsite.slot_text(x);
        elsif typ = 'number' then
          if jsonb_typeof(x) <> 'number' then
            raise exception 'invalid_filter' using errcode = '22023';
          end if;
          v_nv := v_nv || zsite.slot_num(x);
        else
          if jsonb_typeof(x) <> 'string'
             or not ((x #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(x #>> '{}', 'date')
                     or (x #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$'
                        and pg_input_is_valid(x #>> '{}', 'timestamptz')) then
            raise exception 'invalid_filter' using errcode = '22023';
          end if;
          v_dv := v_dv || zsite.slot_ts(x);
        end if;
      end loop;
      v_where := v_where || ' and ' || col || case op
        when 'eq'  then ' = '  when 'gt' then ' > ' when 'gte' then ' >= '
        when 'lt'  then ' < '  when 'lte' then ' <= ' when 'in' then ' = any('
        when 'prefix' then ' >= ' end
        || case typ when 'text' then '$4' when 'number' then '$5' else '$6' end
        || case when op = 'in'
                then '[' || i0 || ':' || (i0 + jsonb_array_length(ov) - 1) || '])'
                else '[' || i0 || ']' end;
      if op = 'prefix' then
        v_where := v_where || ' and starts_with(' || col || ', $4[' || i0 || '])';
      end if;
    end loop;
  end loop;

  if p_sort is not null then
    v_sort_desc := left(p_sort, 1) = '-';
    v_sort_field := case when v_sort_desc then substr(p_sort, 2) else p_sort end;
    v_sort_col := zsite.slot_col(c.index_slots->>v_sort_field);
    if v_sort_col is null or coalesce((c.indexes->v_sort_field->>'sort')::boolean, false) is not true
       or (coalesce(c.fields->v_sort_field ? 'read', false)
           and not zsite.ctx_match(v_ctx, c.fields->v_sort_field->'read', null)) then
      raise exception 'sort_not_allowed' using errcode = '22023';
    end if;
    v_sort_typ := c.indexes->v_sort_field->>'type';
    v_where := v_where || ' and ' || v_sort_col || ' is not null';
  end if;

  if p_cursor is not null then
    begin
      v_cur := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
    exception when others then
      raise exception 'invalid_cursor' using errcode = '22023';
    end;
    if jsonb_typeof(v_cur) is distinct from 'object'
       or (v_cur->>'k') is distinct from p_sort
       or coalesce(v_cur->>'t', '') !~ '^[0-9]{1,19}$'
       or not zsite.is_uuid(v_cur->>'i') then
      raise exception 'invalid_cursor' using errcode = '22023';
    end if;
    v_cts := 'epoch'::timestamptz + ((v_cur->>'t') || ' microseconds')::interval;
    v_cid := (v_cur->>'i')::uuid;
    if p_sort is null then
      v_where := v_where || ' and (r.created_at, r.id) < ($7, $8)';
    else
      if v_sort_typ = 'text' and jsonb_typeof(v_cur->'s') = 'string' then
        v_cs_t := v_cur->>'s';
      elsif v_sort_typ = 'number' and jsonb_typeof(v_cur->'s') = 'number' then
        v_cs_n := (v_cur->>'s')::numeric;
      elsif v_sort_typ = 'timestamp' and coalesce(v_cur->>'s', '') ~ '^[0-9]{1,19}$' then
        v_cs_d := 'epoch'::timestamptz + ((v_cur->>'s') || ' microseconds')::interval;
      else
        raise exception 'invalid_cursor' using errcode = '22023';
      end if;
      v_where := v_where || ' and (' || v_sort_col || case when v_sort_desc then ' < ' else ' > ' end
              || case v_sort_typ when 'text' then '$9' when 'number' then '$10' else '$11' end
              || ' or (' || v_sort_col || ' = '
              || case v_sort_typ when 'text' then '$9' when 'number' then '$10' else '$11' end
              || ' and (r.created_at, r.id) ' || case when v_sort_desc then '>' else '<' end || ' ($7, $8)))';
    end if;
  end if;

  v_order := case
    when p_sort is null then ' order by r.created_at desc, r.id desc'
    when v_sort_desc then ' order by ' || v_sort_col || ' desc, r.created_at asc, r.id asc'
    else ' order by ' || v_sort_col || ' asc, r.created_at desc, r.id desc' end;

  v_sql := 'select array_agg(s.r order by s.n) from ('
        || 'select r, row_number() over () as n from (select r.* from zsite.records r'
        || ' where r.site_id = $1 and r.collection = $2' || v_where
        || v_order || ' limit $12) r) s';

  execute v_sql into v_rows
    using v_site, p_collection, v_owner, v_tv, v_nv, v_dv, v_cts, v_cid,
          v_cs_t, v_cs_n, v_cs_d, v_lim + 1;

  if v_rows is not null then
    for i in 1 .. least(array_length(v_rows, 1), v_lim) loop
      v_items := v_items || jsonb_build_array(zsite.project_ctx(v_ctx, c.fields, v_rows[i]));
    end loop;
    if array_length(v_rows, 1) > v_lim then
      v_last := to_jsonb(v_rows[v_lim]);
      v_next := translate(encode(convert_to(jsonb_build_object(
        'k', p_sort,
        's', case v_sort_typ
               when 'text' then v_last->(substr(v_sort_col, 3))
               when 'number' then v_last->(substr(v_sort_col, 3))
               when 'timestamp' then to_jsonb(((extract(epoch from (v_last->>substr(v_sort_col, 3))::timestamptz) * 1000000)::bigint)::text)
             end,
        't', ((extract(epoch from v_rows[v_lim].created_at) * 1000000)::bigint)::text,
        'i', v_rows[v_lim].id)::text, 'UTF8'), 'base64'), E'\n', '');
    end if;
  end if;

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end $$;

create or replace function api.get_record(p_collection text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_ctx jsonb := zsite.request_ctx();
  v_g jsonb := zsite.request_grants();
  c zsite.collections; r zsite.records;
begin
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records' and x.archived_at is null;
  if not found then return null; end if;
  select * into r from zsite.records x
  where x.site_id = v_site and x.collection = p_collection and x.id = p_id
    and ((v_g->'get_all') ? p_collection
         or (x.owner_id is not null and x.owner_id::text = v_g->>'uid' and (v_g->'get_own') ? p_collection));
  if not found then return null; end if;
  return zsite.project_ctx(v_ctx, c.fields, r);
end $$;

insert into zsite.migrations (version) values ('0005_contracts_archive_reindex') on conflict do nothing;

commit;
