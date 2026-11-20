
begin;

create table if not exists zsite.migration_notices (
  id         bigserial primary key,
  migration  text not null,
  site_id    uuid,
  collection text,
  subject    text,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table zsite.migration_notices enable row level security;
revoke all on zsite.migration_notices from public, anon, authenticated;
grant select on zsite.migration_notices to service_role;

alter table zsite.identities alter column auth_user_id drop not null;

alter table zsite.identities drop constraint if exists identities_state_check;
alter table zsite.identities add constraint identities_state_check
  check (state in ('pending', 'unverified', 'active', 'email_change_pending', 'deleting'));
with moved as (
  update zsite.identities set state = 'unverified', updated_at = now()
  where state = 'pending' and auth_user_id is not null
  returning site_id, email_norm)
insert into zsite.migration_notices (migration, site_id, subject, action, detail)
select '0004', site_id, 'identities', 'pending_with_auth_user_to_unverified',
       jsonb_build_object('rows', count(*))
from moved group by site_id;

alter table zsite.identities drop constraint if exists identities_pending_no_user;
alter table zsite.identities add constraint identities_pending_no_user
  check ((state = 'pending') = (auth_user_id is null));

revoke all on zsite.identities from anon, authenticated, zsite_facade;
grant select (site_id, auth_user_id, state) on zsite.identities to anon, authenticated, zsite_facade;
drop policy if exists identities_self on zsite.identities;
create policy identities_self on zsite.identities for select to authenticated, zsite_facade
  using (site_id = (select zsite.request_site()) and auth_user_id = (select zsite.request_user()));

create or replace function zsite.claims() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  return coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
end $$;

create or replace function zsite.is_uuid(p text) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return p is not null and p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
end $$;

create or replace function zsite.claim_site() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare c jsonb := zsite.claims();
begin
  if (c->>'role') in ('anon', 'authenticated') and zsite.is_uuid(c->>'site_id') then
    return (c->>'site_id')::uuid;
  end if;
  return null;
end $$;

create or replace function zsite.request_site() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare v uuid := zsite.claim_site(); r uuid;
begin
  if v is null then return null; end if;
  select s.site_id into r from zsite.sites s where s.site_id = v and s.status = 'active';
  return r;
end $$;

create or replace function zsite.request_user() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare c jsonb;
begin
  if pg_catalog.current_setting('role', true) is distinct from 'authenticated' then return null; end if;
  c := zsite.claims();
  if (c->>'role') = 'authenticated' and zsite.is_uuid(c->>'sub') then
    return (c->>'sub')::uuid;
  end if;
  return null;
end $$;

create or replace function zsite.request_ctx() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_site uuid := zsite.request_site(); v_usr uuid; v_uid uuid; v_role text;
begin
  if v_site is not null then
    v_usr := zsite.request_user();
    if v_usr is not null then
      select mm.user_id, mm.role into v_uid, v_role
      from zsite.members mm
      join zsite.identities i on i.site_id = mm.site_id and i.auth_user_id = mm.user_id
      where mm.site_id = v_site and mm.user_id = v_usr and mm.status = 'active'
        and i.state in ('active', 'email_change_pending');
    end if;
  end if;
  return jsonb_build_object('site', v_site, 'uid', v_uid, 'role', v_role);
end $$;

create or replace function zsite.request_member(out user_id uuid, out role text)
language plpgsql stable security invoker set search_path = '' as $$
declare c jsonb := zsite.request_ctx();
begin
  user_id := (c->>'uid')::uuid;
  role := c->>'role';
end $$;

create or replace function zsite.ctx_match(p_ctx jsonb, p_principals jsonb, p_owner uuid) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare v_uid text := p_ctx->>'uid'; v_role text := p_ctx->>'role';
begin
  if jsonb_typeof(p_principals) is distinct from 'array' then return false; end if;
  if p_principals ? 'anyone' then return true; end if;
  if v_uid is null then return false; end if;
  return p_principals ? 'signed_in'
      or (p_owner is not null and p_owner::text = v_uid and p_principals ? 'owner')
      or (v_role = 'admin' and p_principals ? 'admin')
      or (v_role is not null and p_principals ? ('role:' || v_role));
end $$;

create or replace function zsite.principal_match(p_principals jsonb, p_owner uuid) returns boolean
language plpgsql stable security invoker set search_path = '' as $$
begin
  return zsite.ctx_match(zsite.request_ctx(), p_principals, p_owner);
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
             where y.site_id = (c->>'site')::uuid and y.kind = 'records' loop
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

create or replace function zsite.permits(p_collection text, p_op text, p_owner uuid) returns boolean
language plpgsql stable security invoker set search_path = '' as $$
declare g jsonb := zsite.request_grants();
begin
  if p_op = 'create' then return (g->'create') ? p_collection; end if;
  return coalesce((g->(p_op || '_all')) ? p_collection, false)
      or (p_owner is not null and p_owner::text = g->>'uid'
          and coalesce((g->(p_op || '_own')) ? p_collection, false));
end $$;

alter table zsite.collections add column if not exists index_slots jsonb not null default '{}'::jsonb;

alter table zsite.records add column if not exists t1 text collate "C";
alter table zsite.records add column if not exists t2 text collate "C";
alter table zsite.records add column if not exists t3 text collate "C";
alter table zsite.records add column if not exists n1 numeric;
alter table zsite.records add column if not exists n2 numeric;
alter table zsite.records add column if not exists d1 timestamptz;
alter table zsite.records add column if not exists d2 timestamptz;

create or replace function zsite.slot_text(v jsonb) returns text
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return case jsonb_typeof(v) when 'string' then v #>> '{}' when 'boolean' then v::text end;
end $$;
create or replace function zsite.slot_num(v jsonb) returns numeric
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return case jsonb_typeof(v) when 'number' then (v #>> '{}')::numeric end;
end $$;
create or replace function zsite.slot_ts(v jsonb) returns timestamptz
language plpgsql stable security invoker set search_path = '' as $$
begin
  if jsonb_typeof(v) is distinct from 'string' then return null; end if;
  if (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' then
    return ((v #>> '{}')::date)::timestamp at time zone 'UTC';
  elsif (v #>> '{}') ~ '(Z|[+-]\d{2}:\d{2})$' then
    return (v #>> '{}')::timestamptz;
  end if;
  return null;
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
  if not found or c.kind <> 'records' then
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

alter table zsite.quotas add column if not exists max_deletes_per_min integer not null default 1200
  check (max_deletes_per_min >= 0);
alter table zsite.usage add column if not exists del_window_start timestamptz not null default '-infinity';
alter table zsite.usage add column if not exists del_window_count integer not null default 0;

create or replace function zsite.tg_records_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_end_user boolean := pg_catalog.current_setting('role', true) in ('anon', 'authenticated');
  v_site uuid;
  d_rec integer;
  d_bytes bigint;
  v_size integer;
  v_now timestamptz := date_trunc('minute', clock_timestamp());
  v_max_records bigint; v_max_bytes bigint; v_max_wpm integer; v_max_rec_bytes integer; v_max_dpm integer;
begin
  if TG_OP = 'DELETE' then
    v_site := OLD.site_id;
    if v_end_user then
      select q.max_deletes_per_min into v_max_dpm
        from zsite.quotas q where q.site_id = v_site for share;
      update zsite.usage u
         set records          = u.records - 1,
             bytes            = u.bytes - OLD.bytes,
             del_window_start = case when u.del_window_start < v_now then v_now else u.del_window_start end,
             del_window_count = case when u.del_window_start < v_now then 1 else u.del_window_count + 1 end
       where u.site_id = v_site
         and (u.del_window_start < v_now or u.del_window_count < coalesce(v_max_dpm, 0));
      if not found then
        raise exception 'quota_exceeded: delete rate' using errcode = '53400';
      end if;
    else
      update zsite.usage u set records = u.records - 1, bytes = u.bytes - OLD.bytes
       where u.site_id = v_site;
    end if;
    return null;
  end if;

  v_site := NEW.site_id;
  if TG_OP = 'INSERT' then
    d_rec := 1; d_bytes := NEW.bytes;
  else
    d_rec := 0; d_bytes := NEW.bytes - OLD.bytes;
  end if;
  v_size := NEW.bytes;

  select q.max_records, q.max_bytes, q.max_writes_per_min, q.max_record_bytes
    into v_max_records, v_max_bytes, v_max_wpm, v_max_rec_bytes
    from zsite.quotas q where q.site_id = v_site for share;
  if not found then
    raise exception 'quota_exceeded' using errcode = '53400';
  end if;

  update zsite.usage u
     set records       = u.records + d_rec,
         bytes         = u.bytes + d_bytes,
         window_start  = case when not v_end_user then u.window_start
                              when u.window_start < v_now then v_now else u.window_start end,
         window_writes = case when not v_end_user then u.window_writes
                              when u.window_start < v_now then 1 else u.window_writes + 1 end
   where u.site_id = v_site
     and (d_rec <= 0 or u.records + d_rec <= v_max_records)
     and (d_bytes <= 0 or u.bytes + d_bytes <= v_max_bytes)
     and v_size <= v_max_rec_bytes
     and (not v_end_user or u.window_start < v_now or u.window_writes < v_max_wpm);
  if not found then
    raise exception 'quota_exceeded' using errcode = '53400';
  end if;
  return null;
end $$;

drop trigger if exists records_quota on zsite.records;
create trigger records_quota after insert or delete on zsite.records
  for each row execute function zsite.tg_records_quota();
drop trigger if exists records_quota_upd on zsite.records;
create trigger records_quota_upd after update on zsite.records
  for each row when (old.data is distinct from new.data)
  execute function zsite.tg_records_quota();

create or replace function zsite.slot_kind(p_type text) returns text
language sql immutable security invoker set search_path = '' as $$
  select case p_type when 'text' then 't' when 'number' then 'n' when 'timestamp' then 'd' end
$$;

create or replace function zsite.assign_slots(p_indexes jsonb, p_prev jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare
  r jsonb := '{}'::jsonb;
  f text; d jsonb; k text; prev text; s text;
begin
  if jsonb_typeof(p_indexes) is distinct from 'object' then return r; end if;
  for f, d in select e.key, e.value from jsonb_each(p_indexes) e order by e.key loop
    k := zsite.slot_kind(d->>'type');
    prev := p_prev->>f;
    if k is not null and prev is not null and left(prev, 1) = k then
      r := r || jsonb_build_object(f, prev);
    end if;
  end loop;
  for f, d in select e.key, e.value from jsonb_each(p_indexes) e order by e.key loop
    continue when r ? f;
    k := zsite.slot_kind(d->>'type');
    continue when k is null;
    select x into s
    from unnest(case k when 't' then array['t1','t2','t3'] when 'n' then array['n1','n2'] else array['d1','d2'] end) x
    where not exists (select 1 from jsonb_each_text(r) e where e.value = x)
    order by x limit 1;
    if s is not null then
      r := r || jsonb_build_object(f, s);
    end if;
  end loop;
  return r;
end $$;

create or replace function zsite.index_type_fits(p_type text, p_prop jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select case p_type
    when 'text' then
         ((p_prop->>'type') = 'string' and coalesce(p_prop->>'format', '') not in ('date', 'date-time')
          and (p_prop->>'maxLength')::numeric <= 512)
      or (p_prop->>'type') = 'boolean'
    when 'number' then (p_prop->>'type') in ('integer', 'number')
    when 'timestamp' then (p_prop->>'type') = 'string' and (p_prop->>'format') in ('date', 'date-time')
    else false end
$$;

create or replace function zsite.valid_index_def(p_type_ok boolean, d jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select p_type_ok
     and jsonb_typeof(d) = 'object'
     and not exists (select 1 from jsonb_object_keys(d) k where k not in ('type', 'ops', 'sort'))
     and (d->>'type') in ('text', 'number', 'timestamp')
     and jsonb_typeof(d->'ops') = 'array'
     and jsonb_array_length(d->'ops') between 1 and 4
     and not exists (
       select 1 from jsonb_array_elements(d->'ops') o
       where jsonb_typeof(o) <> 'string'
          or (o #>> '{}') not in ('eq', 'in', 'range', 'prefix')
          or ((o #>> '{}') = 'prefix' and (d->>'type') <> 'text'))
     and (select count(*) from jsonb_array_elements(d->'ops'))
         = (select count(distinct o #>> '{}') from jsonb_array_elements(d->'ops') o)
     and (not d ? 'sort' or jsonb_typeof(d->'sort') = 'boolean')
$$;

alter table zsite.collections drop constraint if exists collections_valid;

do $$
declare x record; v_max integer;
begin
  for x in
    select c.site_id, c.name, e.key as field, c.schema->'properties'->e.key as prop
    from zsite.collections c, jsonb_each(c.indexes) e
    where jsonb_typeof(e.value) = 'string'
      and (c.schema->'properties'->e.key->>'type') = 'string'
      and coalesce(c.schema->'properties'->e.key->>'format', '') not in ('date', 'date-time')
      and (c.schema->'properties'->e.key->>'maxLength')::numeric > 512
  loop
    select coalesce(max(length(r.data->>x.field)), 0) into v_max
    from zsite.records r where r.site_id = x.site_id and r.collection = x.name;
    if v_max <= 512 then
      update zsite.collections
         set schema = jsonb_set(schema, array['properties', x.field, 'maxLength'], '512'::jsonb)
       where site_id = x.site_id and name = x.name;
      insert into zsite.migration_notices (migration, site_id, collection, subject, action, detail)
      values ('0004', x.site_id, x.name, x.field, 'indexed_string_maxlength_narrowed',
              jsonb_build_object('from', x.prop->'maxLength', 'to', 512, 'longest_stored', v_max));
    else
      update zsite.collections set indexes = indexes - x.field
       where site_id = x.site_id and name = x.name;
      insert into zsite.migration_notices (migration, site_id, collection, subject, action, detail)
      values ('0004', x.site_id, x.name, x.field, 'index_dropped_value_too_long_for_text_slot',
              jsonb_build_object('maxLength', x.prop->'maxLength', 'longest_stored', v_max));
    end if;
  end loop;
end $$;

update zsite.collections c
   set indexes = (
     select coalesce(jsonb_object_agg(e.key, jsonb_build_object(
              'type', case
                when (c.schema->'properties'->e.key->>'type') in ('integer', 'number') then 'number'
                when (c.schema->'properties'->e.key->>'format') in ('date', 'date-time') then 'timestamp'
                else 'text' end,
              'ops', '["eq"]'::jsonb,
              'sort', false)), '{}'::jsonb)
     from jsonb_each(c.indexes) e)
 where exists (select 1 from jsonb_each(c.indexes) e where jsonb_typeof(e.value) = 'string');

create or replace function zsite.valid_collection(
  p_kind text, p_rules jsonb, p_schema jsonb, p_fields jsonb, p_indexes jsonb
) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select zsite.valid_rules(p_rules)
     and jsonb_typeof(p_fields) = 'object'
     and jsonb_typeof(p_indexes) = 'object'
     and case
       when p_kind = 'files' then
         p_schema = '{}'::jsonb and p_fields = '{}'::jsonb and p_indexes = '{}'::jsonb
         and coalesce(p_rules->'list', '[]'::jsonb) = coalesce(p_rules->'get', '[]'::jsonb)
       else
         zsite.valid_schema(p_schema)
         and not exists (
           select 1 from jsonb_each(p_fields) f
           where not (p_schema->'properties') ? f.key
              or jsonb_typeof(f.value) <> 'object'
              or exists (select 1 from jsonb_object_keys(f.value) k where k not in ('read', 'write'))
              or not coalesce(zsite.valid_principals(f.value->'read', true), true)
              or not coalesce(zsite.valid_principals(f.value->'write', true), true))
         and not exists (
           select 1 from jsonb_each(p_indexes) i
           where not (p_schema->'properties') ? i.key
              or not zsite.valid_index_def(
                       zsite.index_type_fits(i.value->>'type', p_schema->'properties'->i.key), i.value))
         and (select count(*) from jsonb_each(p_indexes) i where i.value->>'type' = 'text') <= 3
         and (select count(*) from jsonb_each(p_indexes) i where i.value->>'type' = 'number') <= 2
         and (select count(*) from jsonb_each(p_indexes) i where i.value->>'type' = 'timestamp') <= 2
     end
$$;

create or replace function zsite.manifest_lock_key(p_site uuid, p_collection text) returns bigint
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return hashtextextended(p_site::text || '/' || p_collection, 0);
end $$;

create or replace function zsite.tg_collections_slots() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    perform pg_advisory_xact_lock(zsite.manifest_lock_key(OLD.site_id, OLD.name));
  end if;
  NEW.index_slots := zsite.assign_slots(NEW.indexes,
                       case when TG_OP = 'UPDATE' then OLD.index_slots else '{}'::jsonb end);
  NEW.updated_at := now();
  return NEW;
end $$;

create or replace function zsite.tg_collections_rematerialize() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  update zsite.records r set t1 = r.t1
   where r.site_id = NEW.site_id and r.collection = NEW.name;
  return null;
end $$;

drop trigger if exists collections_slots on zsite.collections;
create trigger collections_slots before insert or update on zsite.collections
  for each row execute function zsite.tg_collections_slots();
drop trigger if exists collections_rematerialize on zsite.collections;
create trigger collections_rematerialize after update on zsite.collections
  for each row when (old.index_slots is distinct from new.index_slots)
  execute function zsite.tg_collections_rematerialize();

update zsite.collections set indexes = indexes;

alter table zsite.collections add constraint collections_valid
  check (zsite.valid_collection(kind, rules, schema, fields, indexes));
alter table zsite.collections drop constraint if exists collections_slots_complete;
create or replace function zsite.slots_complete(p_indexes jsonb, p_slots jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select not exists (select 1 from jsonb_object_keys(p_indexes) k where not p_slots ? k)
$$;
alter table zsite.collections add constraint collections_slots_complete
  check (zsite.slots_complete(indexes, index_slots));

alter table zsite.records drop column if exists idx_s1;
alter table zsite.records drop column if exists idx_s2;
alter table zsite.records drop column if exists idx_s3;

create index if not exists records_t1_idx on zsite.records (site_id, collection, t1, created_at desc, id desc) where t1 is not null;
create index if not exists records_t2_idx on zsite.records (site_id, collection, t2, created_at desc, id desc) where t2 is not null;
create index if not exists records_t3_idx on zsite.records (site_id, collection, t3, created_at desc, id desc) where t3 is not null;
create index if not exists records_n1_idx on zsite.records (site_id, collection, n1, created_at desc, id desc) where n1 is not null;
create index if not exists records_n2_idx on zsite.records (site_id, collection, n2, created_at desc, id desc) where n2 is not null;
create index if not exists records_d1_idx on zsite.records (site_id, collection, d1, created_at desc, id desc) where d1 is not null;
create index if not exists records_d2_idx on zsite.records (site_id, collection, d2, created_at desc, id desc) where d2 is not null;

create or replace function zsite.grant_names(p_keys text[]) returns text[]
language plpgsql stable security invoker set search_path = '' as $$
declare g jsonb := zsite.request_grants(); r text[] := '{}'; k text;
begin
  foreach k in array p_keys loop
    r := r || array(select jsonb_array_elements_text(coalesce(g->k, '[]'::jsonb)));
  end loop;
  return r;
end $$;

create or replace function zsite.grant_uid() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
begin
  return (zsite.request_ctx()->>'uid')::uuid;
end $$;

drop policy if exists records_read on zsite.records;
create policy records_read on zsite.records for select to zsite_facade
  using (
       collection = any ((select zsite.grant_names('{list_all,get_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{list_own,get_own}'))::text[])));

drop policy if exists records_create on zsite.records;
create policy records_create on zsite.records for insert to zsite_facade
  with check (collection = any ((select zsite.grant_names('{create}'))::text[]));

drop policy if exists records_update on zsite.records;
create policy records_update on zsite.records for update to zsite_facade
  using ((select zsite.request_user()) is not null and (
       collection = any ((select zsite.grant_names('{update_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{update_own}'))::text[]))))
  with check ((select zsite.request_user()) is not null and (
       collection = any ((select zsite.grant_names('{update_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{update_own}'))::text[]))));

drop policy if exists records_delete on zsite.records;
create policy records_delete on zsite.records for delete to zsite_facade
  using ((select zsite.request_user()) is not null and (
       collection = any ((select zsite.grant_names('{delete_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{delete_own}'))::text[]))));

create or replace function zsite.project_ctx(p_ctx jsonb, p_fields jsonb, r zsite.records) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare v_data jsonb := r.data; k text; m jsonb;
begin
  if p_fields <> '{}'::jsonb then
    for k, m in select e.key, e.value from jsonb_each(p_fields) e loop
      if m ? 'read' and v_data ? k and not zsite.ctx_match(p_ctx, m->'read', r.owner_id) then
        v_data := v_data - k;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'id', r.id,
    'data', v_data,
    'mine', coalesce(r.owner_id is not null and r.owner_id::text = p_ctx->>'uid', false),
    'created_at', r.created_at,
    'updated_at', r.updated_at);
end $$;

create or replace function zsite.slot_col(p_slot text) returns text
language sql immutable security invoker set search_path = '' as $$
  select case p_slot when 't1' then 'r.t1' when 't2' then 'r.t2' when 't3' then 'r.t3'
                     when 'n1' then 'r.n1' when 'n2' then 'r.n2'
                     when 'd1' then 'r.d1' when 'd2' then 'r.d2' end
$$;

drop function if exists api.list_records(text, jsonb, integer, text);

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
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records';
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
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records';
  if not found then return null; end if;
  select * into r from zsite.records x
  where x.site_id = v_site and x.collection = p_collection and x.id = p_id
    and ((v_g->'get_all') ? p_collection
         or (x.owner_id is not null and x.owner_id::text = v_g->>'uid' and (v_g->'get_own') ? p_collection));
  if not found then return null; end if;
  return zsite.project_ctx(v_ctx, c.fields, r);
end $$;

grant create on schema api to zsite_facade;
alter function api.list_records(text, jsonb, integer, text, text) owner to zsite_facade;
alter function api.get_record(text, uuid) owner to zsite_facade;
revoke create on schema api from zsite_facade;
revoke all on function api.list_records(text, jsonb, integer, text, text) from public;
grant execute on function api.list_records(text, jsonb, integer, text, text) to anon, authenticated;

revoke all on function
  zsite.request_ctx(), zsite.ctx_match(jsonb, jsonb, uuid), zsite.request_grants(),
  zsite.slot_kind(text), zsite.assign_slots(jsonb, jsonb), zsite.index_type_fits(text, jsonb),
  zsite.valid_index_def(boolean, jsonb), zsite.slots_complete(jsonb, jsonb),
  zsite.slot_text(jsonb), zsite.slot_num(jsonb), zsite.slot_ts(jsonb),
  zsite.project_ctx(jsonb, jsonb, zsite.records), zsite.slot_col(text),
  zsite.grant_names(text[]), zsite.grant_uid(), zsite.manifest_lock_key(uuid, text)
  from public;
grant execute on function
  zsite.request_ctx(), zsite.ctx_match(jsonb, jsonb, uuid), zsite.request_grants(),
  zsite.slot_kind(text), zsite.assign_slots(jsonb, jsonb), zsite.index_type_fits(text, jsonb),
  zsite.valid_index_def(boolean, jsonb), zsite.slots_complete(jsonb, jsonb),
  zsite.slot_text(jsonb), zsite.slot_num(jsonb), zsite.slot_ts(jsonb),
  zsite.project_ctx(jsonb, jsonb, zsite.records), zsite.slot_col(text),
  zsite.grant_names(text[]), zsite.grant_uid(), zsite.manifest_lock_key(uuid, text)
  to anon, authenticated, service_role, zsite_facade;
revoke execute on function zsite.tg_collections_slots(), zsite.tg_collections_rematerialize()
  from public, anon, authenticated, service_role;

insert into zsite.migrations (version) values ('0004_membership_slots_perf') on conflict do nothing;

commit;
