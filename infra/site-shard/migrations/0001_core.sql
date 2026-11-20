
begin;

create schema if not exists zsite;
revoke all on schema zsite from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zsite_facade') then
    create role zsite_facade nologin noinherit;
  end if;
  execute format('grant zsite_facade to %I', current_user);
end $$;

create table if not exists zsite.migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

create or replace function zsite.claims() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function zsite.is_uuid(p text) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select p is not null and p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create or replace function zsite.claim_site() returns uuid
language sql stable security invoker set search_path = '' as $$
  select case
    when (c->>'role') in ('anon', 'authenticated') and zsite.is_uuid(c->>'site_id')
    then (c->>'site_id')::uuid
  end
  from (select zsite.claims() as c) x
$$;

create table if not exists zsite.sites (
  site_id    uuid primary key,
  status     text not null default 'active' check (status in ('active', 'suspended', 'deleting')),
  created_at timestamptz not null default now()
);

create or replace function zsite.request_site() returns uuid
language sql stable security invoker set search_path = '' as $$
  select s.site_id from zsite.sites s
  where s.site_id = zsite.claim_site() and s.status = 'active'
$$;

create or replace function zsite.request_user() returns uuid
language sql stable security invoker set search_path = '' as $$
  select case
    when pg_catalog.current_setting('role', true) = 'authenticated'
     and (c->>'role') = 'authenticated'
     and zsite.is_uuid(c->>'sub')
    then (c->>'sub')::uuid
  end
  from (select zsite.claims() as c) x
$$;

create or replace function zsite.valid_principals(p jsonb, p_allow_anyone boolean) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 8
     and not exists (
       select 1 from jsonb_array_elements(p) e
       where jsonb_typeof(e) <> 'string'
          or not (
               (e #>> '{}') in ('signed_in', 'owner', 'admin')
            or ((e #>> '{}') = 'anyone' and p_allow_anyone)
            or (e #>> '{}') ~ '^role:[a-z][a-z0-9_]{0,31}$'
          )
     )
$$;

create or replace function zsite.valid_rules(p jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_object_keys(p) k
                     where k not in ('list', 'get', 'create', 'update', 'delete'))
     and coalesce(zsite.valid_principals(p->'list',   true),  true)
     and coalesce(zsite.valid_principals(p->'get',    true),  true)
     and coalesce(zsite.valid_principals(p->'create', true),  true)
     and coalesce(zsite.valid_principals(p->'update', false), true)
     and coalesce(zsite.valid_principals(p->'delete', false), true)
$$;

create or replace function zsite.valid_field_name(k text) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select k ~ '^[a-z][a-z0-9_]{0,62}$'
     and k not in ('id', 'site_id', 'owner_id', 'collection', 'created_at', 'updated_at',
                   'idempotency_key', 'mine')
$$;

create or replace function zsite.valid_property(p jsonb, p_in_array boolean) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare t text;
begin
  if jsonb_typeof(p) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k
             where k not in ('type', 'maxLength', 'minLength', 'enum', 'minimum', 'maximum',
                             'format', 'items', 'maxItems')) then
    return false;
  end if;
  t := p->>'type';
  if t = 'string' then
    if jsonb_typeof(p->'maxLength') <> 'number' or (p->>'maxLength')::numeric not between 1 and 10000 then
      return false;
    end if;
    if p ? 'minLength' and (jsonb_typeof(p->'minLength') <> 'number' or (p->>'minLength')::numeric < 0) then
      return false;
    end if;
    if p ? 'format' and (p->>'format') not in ('email', 'date', 'date-time', 'uuid') then
      return false;
    end if;
    if p ? 'enum' and (jsonb_typeof(p->'enum') <> 'array' or jsonb_array_length(p->'enum') not between 1 and 100
        or exists (select 1 from jsonb_array_elements(p->'enum') e where jsonb_typeof(e) <> 'string')) then
      return false;
    end if;
    return not (p ? 'minimum' or p ? 'maximum' or p ? 'items' or p ? 'maxItems');
  elsif t in ('integer', 'number') then
    if p ? 'minimum' and jsonb_typeof(p->'minimum') <> 'number' then return false; end if;
    if p ? 'maximum' and jsonb_typeof(p->'maximum') <> 'number' then return false; end if;
    return not (p ? 'maxLength' or p ? 'minLength' or p ? 'format' or p ? 'enum' or p ? 'items' or p ? 'maxItems');
  elsif t = 'boolean' then
    return (select count(*) from jsonb_object_keys(p)) = 1;
  elsif t = 'array' and not p_in_array then
    if jsonb_typeof(p->'maxItems') <> 'number' or (p->>'maxItems')::numeric not between 1 and 100 then
      return false;
    end if;
    return p ? 'items' and zsite.valid_property(p->'items', true)
       and not (p ? 'maxLength' or p ? 'minLength' or p ? 'format' or p ? 'enum' or p ? 'minimum' or p ? 'maximum');
  end if;
  return false;
end $$;

create or replace function zsite.valid_schema(s jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(s) = 'object'
     and (s->>'type') = 'object'
     and not exists (select 1 from jsonb_object_keys(s) k where k not in ('type', 'properties', 'required'))
     and jsonb_typeof(s->'properties') = 'object'
     and (select count(*) from jsonb_object_keys(s->'properties')) between 1 and 64
     and not exists (select 1 from jsonb_each(s->'properties') e
                     where not zsite.valid_field_name(e.key) or not zsite.valid_property(e.value, false))
     and (not s ? 'required' or (
           jsonb_typeof(s->'required') = 'array'
           and not exists (select 1 from jsonb_array_elements(s->'required') r
                           where jsonb_typeof(r) <> 'string' or not (s->'properties') ? (r #>> '{}'))))
$$;

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
              or (p_schema->'properties'->i.key->>'type') not in ('string', 'integer', 'number', 'boolean')
              or jsonb_typeof(i.value) <> 'string'
              or (i.value #>> '{}') not in ('s1', 's2', 's3'))
         and (select count(*) from jsonb_each(p_indexes))
             = (select count(distinct i.value #>> '{}') from jsonb_each(p_indexes) i)
     end
$$;

create table if not exists zsite.collections (
  site_id    uuid not null references zsite.sites (site_id) on delete cascade,
  name       text not null check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  kind       text not null default 'records' check (kind in ('records', 'files')),
  rules      jsonb not null default '{}'::jsonb,
  schema     jsonb not null default '{}'::jsonb,
  fields     jsonb not null default '{}'::jsonb,
  indexes    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (site_id, name),
  constraint collections_valid check (zsite.valid_collection(kind, rules, schema, fields, indexes))
);

create table if not exists zsite.identities (
  site_id      uuid not null references zsite.sites (site_id) on delete cascade,
  email_norm   text not null check (email_norm = lower(email_norm) and length(email_norm) between 3 and 320),
  auth_user_id uuid not null unique,
  alias        text not null unique,
  state        text not null default 'active'
               check (state in ('pending', 'active', 'email_change_pending', 'deleting')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (site_id, email_norm),
  unique (site_id, auth_user_id)
);

create table if not exists zsite.members (
  site_id    uuid not null,
  user_id    uuid not null,
  role       text not null default 'user' check (role ~ '^[a-z][a-z0-9_]{0,31}$'),
  status     text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  primary key (site_id, user_id),
  foreign key (site_id, user_id) references zsite.identities (site_id, auth_user_id) on delete cascade
);

create table if not exists zsite.quotas (
  site_id            uuid primary key references zsite.sites (site_id) on delete cascade,
  max_records        bigint  not null default 10000    check (max_records >= 0),
  max_bytes          bigint  not null default 52428800 check (max_bytes >= 0),
  max_writes_per_min integer not null default 600      check (max_writes_per_min >= 0),
  max_record_bytes   integer not null default 65536    check (max_record_bytes between 0 and 262144)
);

create table if not exists zsite.usage (
  site_id       uuid primary key references zsite.sites (site_id) on delete cascade,
  records       bigint      not null default 0,
  bytes         bigint      not null default 0,
  window_start  timestamptz not null default '-infinity',
  window_writes integer     not null default 0
);

create table if not exists zsite.records (
  site_id          uuid not null,
  collection       text not null,
  id               uuid not null,
  owner_id         uuid,
  data             jsonb not null check (jsonb_typeof(data) = 'object'),
  idempotency_key  text check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  idempotency_hash text,
  idx_s1           text,
  idx_s2           text,
  idx_s3           text,
  bytes            integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (site_id, collection, id),
  foreign key (site_id, collection) references zsite.collections (site_id, name)
);

create index if not exists records_list_idx
  on zsite.records (site_id, collection, created_at desc, id desc);
create index if not exists records_owner_idx
  on zsite.records (site_id, collection, owner_id, created_at desc, id desc) where owner_id is not null;
create unique index if not exists records_idem_uidx
  on zsite.records (site_id, collection, idempotency_key) where idempotency_key is not null;
create index if not exists records_s1_idx
  on zsite.records (site_id, collection, idx_s1, created_at desc, id desc) where idx_s1 is not null;
create index if not exists records_s2_idx
  on zsite.records (site_id, collection, idx_s2, created_at desc, id desc) where idx_s2 is not null;
create index if not exists records_s3_idx
  on zsite.records (site_id, collection, idx_s3, created_at desc, id desc) where idx_s3 is not null;

create or replace function zsite.request_member(out user_id uuid, out role text)
language sql stable security invoker set search_path = '' as $$
  select m.user_id,
         case when m.role = (zsite.claims()->>'site_role') then m.role end
  from zsite.members m
  where m.site_id = zsite.request_site()
    and m.user_id = zsite.request_user()
    and m.status = 'active'
$$;

create or replace function zsite.principal_match(p_principals jsonb, p_owner uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select bool_or(
             p = 'anyone'
          or (m.user_id is not null and (
                  p = 'signed_in'
               or (p = 'owner' and p_owner = m.user_id)
               or (m.role is not null and (p = 'admin' and m.role = 'admin'))
               or (m.role is not null and p = 'role:' || m.role))))
    from jsonb_array_elements_text(
           case when jsonb_typeof(p_principals) = 'array' then p_principals else '[]'::jsonb end) p
    left join zsite.request_member() m on true
  ), false)
$$;

create or replace function zsite.permits(p_collection text, p_op text, p_owner uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select zsite.principal_match(c.rules->p_op, p_owner)
    from zsite.collections c
    where c.site_id = zsite.request_site() and c.name = p_collection and c.kind = 'records'
  ), false)
$$;

create or replace function zsite.validate_value(p_key text, p jsonb, v jsonb) returns void
language plpgsql immutable security invoker set search_path = '' as $$
declare t text := p->>'type'; s text; n numeric; e jsonb;
begin
  if t = 'string' then
    if jsonb_typeof(v) <> 'string' then
      raise exception 'schema_violation: % must be a string', p_key using errcode = '22023';
    end if;
    s := v #>> '{}';
    if length(s) > (p->>'maxLength')::int then
      raise exception 'schema_violation: % is longer than %', p_key, p->>'maxLength' using errcode = '22023';
    end if;
    if p ? 'minLength' and length(s) < (p->>'minLength')::int then
      raise exception 'schema_violation: % is shorter than %', p_key, p->>'minLength' using errcode = '22023';
    end if;
    if p ? 'enum' and not (p->'enum') @> jsonb_build_array(v) then
      raise exception 'schema_violation: % is not an allowed value', p_key using errcode = '22023';
    end if;
    if (p->>'format') = 'email' and s !~ '^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{1,63}$' then
      raise exception 'schema_violation: % is not an email', p_key using errcode = '22023';
    elsif (p->>'format') = 'date' and (s !~ '^\d{4}-\d{2}-\d{2}$' or not pg_input_is_valid(s, 'date')) then
      raise exception 'schema_violation: % is not a date', p_key using errcode = '22023';
    elsif (p->>'format') = 'date-time'
          and (s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$'
               or not pg_input_is_valid(s, 'timestamptz')) then
      raise exception 'schema_violation: % is not a date-time', p_key using errcode = '22023';
    elsif (p->>'format') = 'uuid' and not zsite.is_uuid(lower(s)) then
      raise exception 'schema_violation: % is not a uuid', p_key using errcode = '22023';
    end if;
  elsif t in ('integer', 'number') then
    if jsonb_typeof(v) <> 'number' then
      raise exception 'schema_violation: % must be a number', p_key using errcode = '22023';
    end if;
    n := (v #>> '{}')::numeric;
    if t = 'integer' and n <> trunc(n) then
      raise exception 'schema_violation: % must be an integer', p_key using errcode = '22023';
    end if;
    if p ? 'minimum' and n < (p->>'minimum')::numeric then
      raise exception 'schema_violation: % is below the minimum', p_key using errcode = '22023';
    end if;
    if p ? 'maximum' and n > (p->>'maximum')::numeric then
      raise exception 'schema_violation: % is above the maximum', p_key using errcode = '22023';
    end if;
  elsif t = 'boolean' then
    if jsonb_typeof(v) <> 'boolean' then
      raise exception 'schema_violation: % must be a boolean', p_key using errcode = '22023';
    end if;
  elsif t = 'array' then
    if jsonb_typeof(v) <> 'array' then
      raise exception 'schema_violation: % must be an array', p_key using errcode = '22023';
    end if;
    if jsonb_array_length(v) > (p->>'maxItems')::int then
      raise exception 'schema_violation: % has too many items', p_key using errcode = '22023';
    end if;
    for e in select x from jsonb_array_elements(v) x loop
      perform zsite.validate_value(p_key || '[]', p->'items', e);
    end loop;
  else
    raise exception 'schema_violation: % has no valid type', p_key using errcode = '22023';
  end if;
end $$;

create or replace function zsite.validate_doc(p_schema jsonb, p_doc jsonb) returns void
language plpgsql immutable security invoker set search_path = '' as $$
declare k text; v jsonb; r text;
begin
  if jsonb_typeof(p_doc) is distinct from 'object' then
    raise exception 'schema_violation: document must be an object' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_doc) e loop
    if not (p_schema->'properties') ? k then
      raise exception 'schema_violation: unknown field %', k using errcode = '22023';
    end if;
    perform zsite.validate_value(k, p_schema->'properties'->k, v);
  end loop;
  for r in select jsonb_array_elements_text(coalesce(p_schema->'required', '[]'::jsonb)) loop
    if not p_doc ? r then
      raise exception 'schema_violation: % is required', r using errcode = '22023';
    end if;
  end loop;
end $$;

create or replace function zsite.idem_hash(p_member uuid, p_collection text, p_data jsonb) returns text
language sql immutable security invoker set search_path = '' as $$
  select encode(sha256(convert_to(
    coalesce(p_member::text, 'anon') || ':' || p_collection || ':' || coalesce(p_data::text, 'null'), 'UTF8')), 'hex')
$$;

create or replace function zsite.tg_records_before() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_end_user boolean := pg_catalog.current_setting('role', true) in ('anon', 'authenticated');
  v_site uuid;
  v_member uuid;
  c zsite.collections;
  k text;
  w jsonb;
  v_owner uuid;
begin
  if v_end_user then
    v_site := zsite.request_site();
    if v_site is null or NEW.site_id is distinct from v_site then
      raise exception 'site_mismatch' using errcode = '42501';
    end if;
    select m.user_id into v_member from zsite.request_member() m;

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
  elsif TG_OP = 'UPDATE' and (NEW.site_id is distinct from OLD.site_id
                              or NEW.collection is distinct from OLD.collection
                              or NEW.id is distinct from OLD.id) then
    raise exception 'system_field_immutable' using errcode = '42501';
  end if;

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
        if not zsite.principal_match(w, v_owner) then
          raise exception 'field_not_writable: %', k using errcode = '42501';
        end if;
      end if;
    end loop;
  end if;

  perform zsite.validate_doc(c.schema, NEW.data);

  NEW.idx_s1 := (select NEW.data->>i.key from jsonb_each_text(c.indexes) i where i.value = 's1');
  NEW.idx_s2 := (select NEW.data->>i.key from jsonb_each_text(c.indexes) i where i.value = 's2');
  NEW.idx_s3 := (select NEW.data->>i.key from jsonb_each_text(c.indexes) i where i.value = 's3');
  NEW.bytes := octet_length(NEW.data::text);
  NEW.updated_at := now();
  return NEW;
end $$;

create or replace function zsite.tg_records_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_site uuid;
  d_rec integer;
  d_bytes bigint;
  v_size integer;
  v_now timestamptz := date_trunc('minute', clock_timestamp());
  v_max_records bigint; v_max_bytes bigint; v_max_wpm integer; v_max_rec_bytes integer;
begin
  if TG_OP = 'INSERT' then
    v_site := NEW.site_id; d_rec := 1;  d_bytes := NEW.bytes;             v_size := NEW.bytes;
  elsif TG_OP = 'UPDATE' then
    v_site := NEW.site_id; d_rec := 0;  d_bytes := NEW.bytes - OLD.bytes; v_size := NEW.bytes;
  else
    v_site := OLD.site_id; d_rec := -1; d_bytes := -OLD.bytes;            v_size := 0;
  end if;

  select q.max_records, q.max_bytes, q.max_writes_per_min, q.max_record_bytes
    into v_max_records, v_max_bytes, v_max_wpm, v_max_rec_bytes
    from zsite.quotas q where q.site_id = v_site for share;
  if not found then
    raise exception 'quota_exceeded' using errcode = '53400';
  end if;

  update zsite.usage u
     set records       = u.records + d_rec,
         bytes         = u.bytes + d_bytes,
         window_start  = case when u.window_start < v_now then v_now else u.window_start end,
         window_writes = case when u.window_start < v_now then 1 else u.window_writes + 1 end
   where u.site_id = v_site
     and (d_rec <= 0 or u.records + d_rec <= v_max_records)
     and (d_bytes <= 0 or u.bytes + d_bytes <= v_max_bytes)
     and v_size <= v_max_rec_bytes
     and (u.window_start < v_now or u.window_writes < v_max_wpm);
  if not found then
    raise exception 'quota_exceeded' using errcode = '53400';
  end if;
  return null;
end $$;

drop trigger if exists records_before on zsite.records;
create trigger records_before before insert or update on zsite.records
  for each row execute function zsite.tg_records_before();
drop trigger if exists records_quota on zsite.records;
create trigger records_quota after insert or update or delete on zsite.records
  for each row execute function zsite.tg_records_quota();

create or replace function zsite.tg_sites_init() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  insert into zsite.quotas (site_id) values (NEW.site_id) on conflict do nothing;
  insert into zsite.usage (site_id) values (NEW.site_id) on conflict do nothing;
  return null;
end $$;
drop trigger if exists sites_init on zsite.sites;
create trigger sites_init after insert on zsite.sites
  for each row execute function zsite.tg_sites_init();

alter table zsite.sites       enable row level security;
alter table zsite.collections enable row level security;
alter table zsite.identities  enable row level security;
alter table zsite.members     enable row level security;
alter table zsite.quotas      enable row level security;
alter table zsite.usage       enable row level security;
alter table zsite.records     enable row level security;
alter table zsite.migrations  enable row level security;

drop policy if exists sites_own on zsite.sites;
create policy sites_own on zsite.sites for select to anon, authenticated, zsite_facade
  using (site_id = (select zsite.claim_site()));

drop policy if exists collections_site on zsite.collections;
create policy collections_site on zsite.collections as restrictive for all to anon, authenticated, zsite_facade
  using (site_id = (select zsite.request_site()));
drop policy if exists collections_read on zsite.collections;
create policy collections_read on zsite.collections for select to anon, authenticated, zsite_facade
  using (true);

drop policy if exists members_site on zsite.members;
create policy members_site on zsite.members as restrictive for all to authenticated, zsite_facade
  using (site_id = (select zsite.request_site()));
drop policy if exists members_self on zsite.members;
create policy members_self on zsite.members for select to authenticated, zsite_facade
  using (user_id = (select zsite.request_user()));

drop policy if exists records_site on zsite.records;
create policy records_site on zsite.records as restrictive for all to zsite_facade
  using (site_id = (select zsite.request_site()))
  with check (site_id = (select zsite.request_site()));

drop policy if exists records_read on zsite.records;
create policy records_read on zsite.records for select to zsite_facade
  using (zsite.permits(collection, 'get', owner_id) or zsite.permits(collection, 'list', owner_id));

drop policy if exists records_create on zsite.records;
create policy records_create on zsite.records for insert to zsite_facade
  with check (zsite.permits(collection, 'create', owner_id));

drop policy if exists records_update on zsite.records;
create policy records_update on zsite.records for update to zsite_facade
  using ((select zsite.request_user()) is not null and zsite.permits(collection, 'update', owner_id))
  with check ((select zsite.request_user()) is not null and zsite.permits(collection, 'update', owner_id));

drop policy if exists records_delete on zsite.records;
create policy records_delete on zsite.records for delete to zsite_facade
  using ((select zsite.request_user()) is not null and zsite.permits(collection, 'delete', owner_id));

revoke all on all tables in schema zsite from public, anon, authenticated;
revoke all on all functions in schema zsite from public;
alter default privileges in schema zsite revoke execute on functions from public;

revoke all on all tables in schema zsite from zsite_facade;
grant usage on schema zsite to anon, authenticated, service_role, zsite_facade;

grant select on zsite.sites to anon, authenticated;
grant select on zsite.collections to anon, authenticated;
grant select on zsite.members to anon, authenticated;
grant select on zsite.sites, zsite.collections, zsite.members to zsite_facade;
grant select on zsite.records to zsite_facade;
grant insert (site_id, collection, id, data, idempotency_key) on zsite.records to zsite_facade;
grant update (data) on zsite.records to zsite_facade;
grant delete on zsite.records to zsite_facade;

grant select, insert, update, delete on all tables in schema zsite to service_role;

grant execute on function
  zsite.claims(), zsite.is_uuid(text), zsite.claim_site(), zsite.request_site(),
  zsite.request_user(), zsite.request_member(), zsite.principal_match(jsonb, uuid),
  zsite.permits(text, text, uuid), zsite.validate_value(text, jsonb, jsonb),
  zsite.validate_doc(jsonb, jsonb),
  zsite.valid_principals(jsonb, boolean), zsite.valid_rules(jsonb), zsite.valid_field_name(text),
  zsite.valid_property(jsonb, boolean), zsite.valid_schema(jsonb),
  zsite.valid_collection(text, jsonb, jsonb, jsonb, jsonb), zsite.idem_hash(uuid, text, jsonb)
  to anon, authenticated, service_role, zsite_facade;
revoke execute on function zsite.tg_records_before(), zsite.tg_records_quota(), zsite.tg_sites_init()
  from public, anon, authenticated, service_role;

insert into zsite.migrations (version) values ('0001_core') on conflict do nothing;

commit;
