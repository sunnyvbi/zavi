
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zsite_kernel') then
    create role zsite_kernel nologin noinherit;
  end if;
  execute format('grant zsite_kernel to %I', current_user);
end $$;

create table if not exists zsite.site_contracts (
  site_id        uuid primary key references zsite.sites (site_id) on delete cascade,
  schema_version integer not null default 1 check (schema_version in (1, 2)),
  roles          jsonb not null default '[]'::jsonb,
  capabilities   jsonb not null default '[]'::jsonb,
  actions        jsonb not null default '{}'::jsonb,
  aggregates     jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  constraint site_contracts_shape check (
        jsonb_typeof(roles) = 'array' and jsonb_typeof(capabilities) = 'array'
    and jsonb_typeof(actions) = 'object' and jsonb_typeof(aggregates) = 'object')
);
alter table zsite.site_contracts enable row level security;

alter table zsite.collections add column if not exists recipient jsonb;
alter table zsite.collections add column if not exists uniques jsonb not null default '[]'::jsonb;
alter table zsite.collections add column if not exists unique_slots jsonb not null default '{}'::jsonb;
alter table zsite.collections add column if not exists states jsonb;
alter table zsite.collections add column if not exists "references" jsonb not null default '{}'::jsonb;
alter table zsite.collections add column if not exists reference_slots jsonb not null default '{}'::jsonb;

create or replace function zsite.valid_principals(p jsonb, p_allow_anyone boolean) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 8
     and not exists (
       select 1 from jsonb_array_elements(p) e
       where jsonb_typeof(e) <> 'string'
          or not (
               (e #>> '{}') in ('signed_in', 'owner', 'admin', 'recipient')
            or ((e #>> '{}') = 'anyone' and p_allow_anyone)
            or (e #>> '{}') ~ '^role:[a-z][a-z0-9_]{0,31}$'
          )
     )
$$;

create or replace function zsite.ctx_match(p_ctx jsonb, p_principals jsonb, p_owner uuid, p_recipient uuid)
returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare v_uid text := p_ctx->>'uid'; v_role text := p_ctx->>'role';
begin
  if jsonb_typeof(p_principals) is distinct from 'array' then return false; end if;
  if p_principals ? 'anyone' then return true; end if;
  if v_uid is null then return false; end if;
  return p_principals ? 'signed_in'
      or (p_owner is not null and p_owner::text = v_uid and p_principals ? 'owner')
      or (p_recipient is not null and p_recipient::text = v_uid and p_principals ? 'recipient')
      or (v_role = 'admin' and p_principals ? 'admin')
      or (v_role is not null and p_principals ? ('role:' || v_role));
end $$;

create or replace function zsite.ctx_match(p_ctx jsonb, p_principals jsonb, p_owner uuid) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return zsite.ctx_match(p_ctx, p_principals, p_owner, null::uuid);
end $$;

create or replace function zsite.collection_principals(p_rules jsonb, p_fields jsonb, p_states jsonb)
returns setof text
language sql immutable security invoker set search_path = '' as $$
  select x #>> '{}' from jsonb_path_query(coalesce(p_rules, '{}'::jsonb), 'lax $.*[*]') x
  where jsonb_typeof(x) = 'string'
  union all
  select x #>> '{}' from jsonb_path_query(coalesce(p_fields, '{}'::jsonb), 'lax $.*.*[*]') x
  where jsonb_typeof(x) = 'string'
  union all
  select x #>> '{}' from jsonb_path_query(coalesce(p_states, '{}'::jsonb), 'lax $.read.*[*]') x
  where jsonb_typeof(x) = 'string'
  union all
  select x #>> '{}' from jsonb_path_query(coalesce(p_states, '{}'::jsonb), 'lax $.transitions[*].principals[*]') x
  where jsonb_typeof(x) = 'string'
$$;

create or replace function zsite.json_str_set(p jsonb, p_min integer, p_max integer) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return coalesce(jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between p_min and p_max
     and not exists (select 1 from jsonb_array_elements(p) e where jsonb_typeof(e) <> 'string')
     and (select count(distinct e #>> '{}') from jsonb_array_elements(p) e) = jsonb_array_length(p), false);
end $$;

create or replace function zsite.valid_collection_v2(
  p_kind text, p_rules jsonb, p_schema jsonb, p_fields jsonb,
  p_recipient jsonb, p_uniques jsonb, p_states jsonb, p_refs jsonb
) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare
  props jsonb := coalesce(p_schema->'properties', '{}'::jsonb);
  req jsonb := coalesce(p_schema->'required', '[]'::jsonb);
  k text; v jsonb; t jsonb; f text; vals jsonb; sf text; tr jsonb;
  v_rcpt boolean := p_recipient is not null;
begin
  if p_uniques is null or p_refs is null
     or jsonb_typeof(p_uniques) <> 'array' or jsonb_typeof(p_refs) <> 'object' then
    return false;
  end if;
  if p_kind = 'files' then
    return p_recipient is null and p_uniques = '[]'::jsonb and p_states is null and p_refs = '{}'::jsonb
       and not exists (select 1 from zsite.collection_principals(p_rules, p_fields, null) x where x = 'recipient');
  end if;

  if (select count(*) from jsonb_object_keys(p_refs)) > 4 then return false; end if;
  for k, v in select e.key, e.value from jsonb_each(p_refs) e loop
    if not props ? k or jsonb_typeof(v) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(v) z where z not in ('collection', 'on_delete'))
       or jsonb_typeof(v->'collection') is distinct from 'string'
       or (v->>'collection') !~ '^[a-z][a-z0-9_]{0,62}$'
       or jsonb_typeof(v->'on_delete') is distinct from 'string'
       or (v->>'on_delete') not in ('restrict', 'cascade', 'nullify')
       or (props->k->>'type') is distinct from 'string'
       or (props->k->>'format') is distinct from 'uuid'
       or not coalesce((props->k->>'maxLength')::numeric >= 36, false) then
      return false;
    end if;
    if (v->>'on_delete') = 'nullify' and req ? k then return false; end if;
  end loop;

  if v_rcpt then
    if jsonb_typeof(p_recipient) is distinct from 'object'
       or (select array_agg(z) from jsonb_object_keys(p_recipient) z) is distinct from array['reference']
       or jsonb_typeof(p_recipient->'reference') is distinct from 'string'
       or not p_refs ? (p_recipient->>'reference')
       or not req ? (p_recipient->>'reference') then
      return false;
    end if;
  end if;

  if coalesce(p_rules->'create' ? 'recipient', false) then return false; end if;
  if not v_rcpt and exists (select 1 from zsite.collection_principals(p_rules, p_fields, p_states) x
                            where x = 'recipient') then
    return false;
  end if;

  if jsonb_array_length(p_uniques) > 4 then return false; end if;
  for t in select e from jsonb_array_elements(p_uniques) e loop
    if jsonb_typeof(t) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(t) z where z not in ('fields', 'nulls'))
       or not zsite.json_str_set(t->'fields', 1, 4)
       or jsonb_typeof(t->'nulls') is distinct from 'string'
       or (t->>'nulls') not in ('distinct', 'not_distinct') then
      return false;
    end if;
    for f in select jsonb_array_elements_text(t->'fields') loop
      if not props ? f or (props->f->>'type') not in ('string', 'integer', 'number', 'boolean') then
        return false;
      end if;
    end loop;
  end loop;
  if (select count(distinct e->'fields') from jsonb_array_elements(p_uniques) e) <> jsonb_array_length(p_uniques) then
    return false;
  end if;

  if p_states is not null then
    if jsonb_typeof(p_states) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(p_states) z
                  where z not in ('field', 'values', 'initial', 'read', 'transitions'))
       or jsonb_typeof(p_states->'field') is distinct from 'string'
       or not zsite.json_str_set(p_states->'values', 1, 16)
       or jsonb_typeof(p_states->'initial') is distinct from 'string'
       or jsonb_typeof(p_states->'transitions') is distinct from 'array'
       or jsonb_array_length(p_states->'transitions') > 32 then
      return false;
    end if;
    sf := p_states->>'field';
    vals := p_states->'values';
    if not props ? sf or not req ? sf or (props->sf->>'type') is distinct from 'string'
       or jsonb_typeof(props->sf->'enum') is distinct from 'array'
       or not (props->sf->'enum') @> vals or not vals @> (props->sf->'enum')
       or jsonb_array_length(props->sf->'enum') <> jsonb_array_length(vals)
       or not vals @> jsonb_build_array(p_states->'initial') then
      return false;
    end if;
    if p_states ? 'read' then
      if jsonb_typeof(p_states->'read') is distinct from 'object'
         or (select count(*) from jsonb_object_keys(p_states->'read')) <> jsonb_array_length(vals)
         or exists (select 1 from jsonb_each(p_states->'read') r
                    where not vals @> jsonb_build_array(r.key)
                       or not coalesce(zsite.valid_principals(r.value, true), false)) then
        return false;
      end if;
    end if;
    for tr in select e from jsonb_array_elements(p_states->'transitions') e loop
      if jsonb_typeof(tr) is distinct from 'object'
         or exists (select 1 from jsonb_object_keys(tr) z where z not in ('from', 'to', 'principals'))
         or jsonb_typeof(tr->'from') is distinct from 'string' or jsonb_typeof(tr->'to') is distinct from 'string'
         or not vals @> jsonb_build_array(tr->'from') or not vals @> jsonb_build_array(tr->'to')
         or tr->'from' = tr->'to'
         or not coalesce(zsite.valid_principals(tr->'principals', false), false)
         or jsonb_array_length(tr->'principals') = 0 then
        return false;
      end if;
    end loop;
    if (select count(distinct jsonb_build_array(e->'from', e->'to')) from jsonb_array_elements(p_states->'transitions') e)
       <> jsonb_array_length(p_states->'transitions') then
      return false;
    end if;
  end if;
  return true;
end $$;

create or replace function zsite.valid_collection_v2_strict(
  p_kind text, p_rules jsonb, p_schema jsonb, p_fields jsonb,
  p_recipient jsonb, p_uniques jsonb, p_states jsonb, p_refs jsonb
) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return coalesce(zsite.valid_collection_v2(p_kind, p_rules, p_schema, p_fields,
                                            p_recipient, p_uniques, p_states, p_refs), false);
end $$;

alter table zsite.collections drop constraint if exists collections_v2_valid;
alter table zsite.collections add constraint collections_v2_valid check (
  zsite.valid_collection_v2_strict(kind, rules, schema, fields, recipient, uniques, states, "references"));

create or replace function zsite.unique_key(t jsonb) returns text
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return jsonb_build_object('fields', t->'fields', 'nulls', t->'nulls')::text;
end $$;

create or replace function zsite.assign_fixed_slots(p_keys text[], p_prev jsonb, p_prefix text, p_n integer)
returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare r jsonb := '{}'::jsonb; k text; s text; i integer;
begin
  foreach k in array coalesce(p_keys, '{}') loop
    if p_prev ? k then r := r || jsonb_build_object(k, p_prev->>k); end if;
  end loop;
  foreach k in array coalesce(p_keys, '{}') loop
    continue when r ? k;
    s := null;
    for i in 1 .. p_n loop
      if not exists (select 1 from jsonb_each_text(r) e where e.value = p_prefix || i) then
        s := p_prefix || i; exit;
      end if;
    end loop;
    if s is not null then r := r || jsonb_build_object(k, s); end if;
  end loop;
  return r;
end $$;

create or replace function zsite.tg_collections_v2_slots() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  NEW.unique_slots := zsite.assign_fixed_slots(
    array(select zsite.unique_key(e) from jsonb_array_elements(
            case when jsonb_typeof(NEW.uniques) = 'array' then NEW.uniques else '[]'::jsonb end) e),
    case when TG_OP = 'UPDATE' then OLD.unique_slots else '{}'::jsonb end, 'uk', 4);
  NEW.reference_slots := zsite.assign_fixed_slots(
    array(select k from jsonb_object_keys(
            case when jsonb_typeof(NEW."references") = 'object' then NEW."references" else '{}'::jsonb end) k
          order by k),
    case when TG_OP = 'UPDATE' then OLD.reference_slots else '{}'::jsonb end, 'ref', 4);
  return NEW;
end $$;
drop trigger if exists collections_v2_slots on zsite.collections;
create trigger collections_v2_slots before insert or update on zsite.collections
  for each row execute function zsite.tg_collections_v2_slots();

create or replace function zsite.json_int(v jsonb) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return coalesce(jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric), false);
end $$;

create or replace function zsite.list_admits(p_list jsonb, p text) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return coalesce(p_list ? p or p_list ? 'anyone' or p_list ? 'signed_in', false);
end $$;

create or replace function zsite.validate_site_contract(p_site uuid) returns void
language plpgsql stable security invoker set search_path = '' as $$
declare
  sc zsite.site_contracts;
  v_roles text[];
  x text; k text; a jsonb; g jsonb; tc zsite.collections; cc zsite.collections; v_names text[] := '{}';
  v_n integer;
  v_caps constant text[] := array['payments', 'payouts', 'interval_overlap', 'multi_step_workflow',
                                  'webhooks', 'secrets', 'jobs', 'arbitrary_joins', 'server_compute', 'raw_sql'];
  f text; p text;
begin
  if not exists (select 1 from zsite.sites s where s.site_id = p_site) then return; end if;
  select * into sc from zsite.site_contracts c where c.site_id = p_site;

  if not found or sc.schema_version = 1 then
    if found and (sc.roles <> '[]'::jsonb or sc.capabilities <> '[]'::jsonb
                  or sc.actions <> '{}'::jsonb or sc.aggregates <> '{}'::jsonb) then
      raise exception 'invalid_contract: schemaVersion 1 carries no roles, capabilities, actions or aggregates'
        using errcode = '22023';
    end if;
    if exists (select 1 from zsite.collections c where c.site_id = p_site
               and (c.recipient is not null or c.uniques <> '[]'::jsonb or c.states is not null
                    or c."references" <> '{}'::jsonb)) then
      raise exception 'invalid_contract: recipient, unique, states and references need schemaVersion 2'
        using errcode = '22023';
    end if;
    return;
  end if;

  if not zsite.json_str_set(sc.roles, 0, 8)
     or exists (select 1 from jsonb_array_elements_text(sc.roles) r
                where r !~ '^[a-z][a-z0-9_]{0,31}$' or r in ('admin', 'user')) then
    raise exception 'invalid_contract: roles' using errcode = '22023';
  end if;
  v_roles := array(select jsonb_array_elements_text(sc.roles));

  if not zsite.json_str_set(sc.capabilities, 0, 10)
     or exists (select 1 from jsonb_array_elements_text(sc.capabilities) c where not c = any (v_caps)) then
    raise exception 'invalid_contract: capabilities' using errcode = '22023';
  end if;

  for x in
    select y from zsite.collections c, zsite.collection_principals(c.rules, c.fields, c.states) y
    where c.site_id = p_site
    union all
    select e #>> '{}' from jsonb_path_query(sc.actions, 'lax $.*.principals[*]') e
    union all
    select e #>> '{}' from jsonb_path_query(sc.actions, 'lax $.*.inverse.principals[*]') e
    union all
    select e #>> '{}' from jsonb_path_query(sc.aggregates, 'lax $.*.principals[*]') e
  loop
    if x like 'role:%' and not substr(x, 6) = any (v_roles) then
      raise exception 'invalid_contract: undeclared role %', substr(x, 6) using errcode = '22023';
    end if;
  end loop;

  if exists (select 1 from zsite.members m where m.site_id = p_site
             and m.role not in ('admin', 'user') and not m.role = any (v_roles)) then
    raise exception 'role_in_use' using errcode = '55000';
  end if;

  select count(*) into v_n from zsite.collections c, jsonb_object_keys(c."references") k where c.site_id = p_site;
  if v_n > 64 then
    raise exception 'invalid_contract: more than 64 references' using errcode = '22023';
  end if;
  if exists (select 1 from zsite.collections c, jsonb_each(c."references") e
             where c.site_id = p_site
               and not exists (select 1 from zsite.collections t
                               where t.site_id = p_site and t.name = e.value->>'collection' and t.kind = 'records')) then
    raise exception 'invalid_contract: reference to an unknown collection' using errcode = '22023';
  end if;
  if exists (
    with recursive edges as (
      select distinct c.name as src, e.value->>'collection' as dst
      from zsite.collections c, jsonb_each(c."references") e where c.site_id = p_site),
    walk(path, last, cyc) as (
      select array[src, dst], dst, src = dst from edges
      union all
      select w.path || e.dst, e.dst, e.dst = any (w.path)
      from walk w join edges e on e.src = w.last
      where not w.cyc and array_length(w.path, 1) <= 5)
    select 1 from walk where cyc or array_length(path, 1) > 5) then
    raise exception 'invalid_contract: reference graph must be acyclic with depth <= 4' using errcode = '22023';
  end if;

  for k, a in select e.key, e.value from jsonb_each(sc.actions) e loop
    v_names := v_names || k;
    if jsonb_typeof(a) is distinct from 'object' or k !~ '^[a-z][a-z0-9_]{0,62}$'
       or exists (select 1 from jsonb_object_keys(a) z
                  where z not in ('target', 'delta', 'initial', 'bounds', 'creates', 'principals', 'idempotency', 'inverse'))
       or jsonb_typeof(a->'target') is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(a->'target') z where z not in ('collection', 'counter'))
       or not zsite.json_int(a->'delta') or (a->>'delta')::numeric = 0 or abs((a->>'delta')::numeric) > 1000
       or not zsite.json_int(a->'initial')
       or jsonb_typeof(a->'bounds') is distinct from 'object' or not zsite.json_int(a->'bounds'->'min')
       or jsonb_typeof(a->'creates') is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(a->'creates') z where z not in ('collection', 'targetField'))
       or not coalesce(zsite.valid_principals(a->'principals', true), false) or jsonb_array_length(a->'principals') = 0
       or (a->>'idempotency') is distinct from 'required' then
      raise exception 'invalid_contract: action %', k using errcode = '22023';
    end if;
    select * into tc from zsite.collections c
    where c.site_id = p_site and c.name = a->'target'->>'collection' and c.kind = 'records';
    if not found or (tc.schema->'properties'->(a->'target'->>'counter')->>'type') is distinct from 'integer' then
      raise exception 'invalid_contract: action % target counter must be an integer field', k using errcode = '22023';
    end if;
    if (select array_agg(z order by z) from jsonb_object_keys(a->'bounds') z) = array['max', 'min'] then
      if not zsite.json_int(a->'bounds'->'max') or (a->'bounds'->>'max')::numeric < (a->'bounds'->>'min')::numeric
         or (a->>'initial')::numeric not between (a->'bounds'->>'min')::numeric and (a->'bounds'->>'max')::numeric then
        raise exception 'invalid_contract: action % bounds', k using errcode = '22023';
      end if;
    elsif (select array_agg(z order by z) from jsonb_object_keys(a->'bounds') z) = array['maxField', 'min'] then
      if (tc.schema->'properties'->(a->'bounds'->>'maxField')->>'type') is distinct from 'integer'
         or (a->>'initial')::numeric < (a->'bounds'->>'min')::numeric then
        raise exception 'invalid_contract: action % bounds', k using errcode = '22023';
      end if;
    else
      raise exception 'invalid_contract: action % bounds', k using errcode = '22023';
    end if;
    select * into cc from zsite.collections c
    where c.site_id = p_site and c.name = a->'creates'->>'collection' and c.kind = 'records';
    if not found or (cc."references"->(a->'creates'->>'targetField')->>'collection') is distinct from tc.name then
      raise exception 'invalid_contract: action % creates.targetField must reference the target collection', k
        using errcode = '22023';
    end if;
    if a->'principals' ? 'recipient' and tc.recipient is null then
      raise exception 'invalid_contract: action % recipient on a collection without recipient', k using errcode = '22023';
    end if;
    if a ? 'inverse' then
      g := a->'inverse';
      if jsonb_typeof(g) is distinct from 'object'
         or exists (select 1 from jsonb_object_keys(g) z where z not in ('name', 'delta', 'transition', 'principals', 'idempotency'))
         or jsonb_typeof(g->'name') is distinct from 'string' or (g->>'name') !~ '^[a-z][a-z0-9_]{0,62}$'
         or not zsite.json_int(g->'delta') or (g->>'delta')::numeric = 0 or abs((g->>'delta')::numeric) > 1000
         or jsonb_typeof(g->'transition') is distinct from 'object'
         or (select array_agg(z order by z) from jsonb_object_keys(g->'transition') z) is distinct from array['from', 'to']
         or cc.states is null
         or not (cc.states->'values') @> jsonb_build_array(g->'transition'->'from')
         or not (cc.states->'values') @> jsonb_build_array(g->'transition'->'to')
         or g->'transition'->'from' = g->'transition'->'to'
         or not coalesce(zsite.valid_principals(g->'principals', true), false) or jsonb_array_length(g->'principals') = 0
         or (g->'principals' ? 'recipient' and cc.recipient is null)
         or (g->>'idempotency') is distinct from 'required' then
        raise exception 'invalid_contract: action % inverse', k using errcode = '22023';
      end if;
      v_names := v_names || (g->>'name');
    end if;
  end loop;
  if array_length(v_names, 1) > 16
     or (select count(distinct n) from unnest(v_names) n) <> coalesce(array_length(v_names, 1), 0) then
    raise exception 'invalid_contract: at most 16 distinct action names including inverses' using errcode = '22023';
  end if;

  if (select count(*) from jsonb_object_keys(sc.aggregates)) > 8 then
    raise exception 'invalid_contract: at most 8 aggregates' using errcode = '22023';
  end if;
  for k, g in select e.key, e.value from jsonb_each(sc.aggregates) e loop
    if jsonb_typeof(g) is distinct from 'object' or k !~ '^[a-z][a-z0-9_]{0,62}$'
       or exists (select 1 from jsonb_object_keys(g) z where z not in ('collection', 'fn', 'field', 'filters', 'principals'))
       or jsonb_typeof(g->'fn') is distinct from 'string' or (g->>'fn') not in ('count', 'sum', 'avg')
       or ((g->>'fn') = 'count' and g ? 'field')
       or ((g->>'fn') <> 'count' and jsonb_typeof(g->'field') is distinct from 'string')
       or (g ? 'filters' and not zsite.json_str_set(g->'filters', 0, 2))
       or not zsite.json_str_set(g->'principals', 1, 8) then
      raise exception 'invalid_contract: aggregate %', k using errcode = '22023';
    end if;
    select * into tc from zsite.collections c
    where c.site_id = p_site and c.name = g->>'collection' and c.kind = 'records';
    if not found then
      raise exception 'invalid_contract: aggregate % collection', k using errcode = '22023';
    end if;
    if g ? 'field' and (tc.indexes->(g->>'field')->>'type') is distinct from 'number' then
      raise exception 'invalid_contract: aggregate % field must be a numeric indexed field', k using errcode = '22023';
    end if;
    for f in select jsonb_array_elements_text(coalesce(g->'filters', '[]'::jsonb)) loop
      if not tc.indexes ? f and f is distinct from (tc.states->>'field') then
        raise exception 'invalid_contract: aggregate % filter % must be indexed or the state field', k, f
          using errcode = '22023';
      end if;
    end loop;
    for p in select jsonb_array_elements_text(g->'principals') loop
      if p <> 'admin' and p !~ '^role:' then
        raise exception 'invalid_contract: aggregate % principals are admin or roles', k using errcode = '22023';
      end if;
      if not zsite.list_admits(tc.rules->'list', p) then
        raise exception 'invalid_contract: aggregate % principal % lacks list', k, p using errcode = '22023';
      end if;
      for f in select g->>'field' union all select jsonb_array_elements_text(coalesce(g->'filters', '[]'::jsonb)) loop
        if f is not null and tc.fields->f ? 'read' and not zsite.list_admits(tc.fields->f->'read', p) then
          raise exception 'invalid_contract: aggregate % principal % cannot read %', k, p, f using errcode = '22023';
        end if;
      end loop;
    end loop;
  end loop;
end $$;

create or replace function zsite.tg_validate_site() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform zsite.validate_site_contract(case when TG_OP = 'DELETE' then OLD.site_id else NEW.site_id end);
  return null;
end $$;

drop trigger if exists site_contracts_validate on zsite.site_contracts;
create constraint trigger site_contracts_validate after insert or update on zsite.site_contracts
  deferrable initially deferred for each row execute function zsite.tg_validate_site();
drop trigger if exists collections_validate_site on zsite.collections;
create constraint trigger collections_validate_site after insert or update or delete on zsite.collections
  deferrable initially deferred for each row execute function zsite.tg_validate_site();

create or replace function zsite.tg_site_contracts_touch() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  NEW.updated_at := now();
  return NEW;
end $$;
drop trigger if exists site_contracts_touch on zsite.site_contracts;
create trigger site_contracts_touch before insert or update on zsite.site_contracts
  for each row execute function zsite.tg_site_contracts_touch();

revoke all on zsite.site_contracts from public, anon, authenticated, zsite_facade, zsite_kernel;
grant select, insert, update, delete on zsite.site_contracts to service_role;
grant select on zsite.site_contracts to zsite_facade, zsite_kernel;
drop policy if exists site_contracts_site on zsite.site_contracts;
create policy site_contracts_site on zsite.site_contracts for select to zsite_facade, zsite_kernel
  using (site_id = (select zsite.request_site()));

revoke all on function
  zsite.ctx_match(jsonb, jsonb, uuid, uuid), zsite.collection_principals(jsonb, jsonb, jsonb),
  zsite.json_str_set(jsonb, integer, integer), zsite.valid_collection_v2(text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb),
  zsite.valid_collection_v2_strict(text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb),
  zsite.unique_key(jsonb), zsite.assign_fixed_slots(text[], jsonb, text, integer),
  zsite.json_int(jsonb), zsite.list_admits(jsonb, text), zsite.validate_site_contract(uuid)
  from public;
grant execute on function
  zsite.ctx_match(jsonb, jsonb, uuid, uuid), zsite.collection_principals(jsonb, jsonb, jsonb),
  zsite.json_str_set(jsonb, integer, integer), zsite.valid_collection_v2(text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb),
  zsite.valid_collection_v2_strict(text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb),
  zsite.unique_key(jsonb), zsite.assign_fixed_slots(text[], jsonb, text, integer),
  zsite.json_int(jsonb), zsite.list_admits(jsonb, text)
  to anon, authenticated, service_role, zsite_facade, zsite_kernel;
grant execute on function zsite.validate_site_contract(uuid) to service_role;
revoke execute on function zsite.tg_collections_v2_slots(), zsite.tg_validate_site(), zsite.tg_site_contracts_touch()
  from public, anon, authenticated, service_role;

insert into zsite.migrations (version) values ('0006_contract_v2') on conflict do nothing;

commit;
