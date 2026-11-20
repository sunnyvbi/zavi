
begin;

alter table zsite.records add column if not exists recipient_u1 uuid;
alter table zsite.records add column if not exists uk1 bytea;
alter table zsite.records add column if not exists uk2 bytea;
alter table zsite.records add column if not exists uk3 bytea;
alter table zsite.records add column if not exists uk4 bytea;
alter table zsite.records add column if not exists state text collate "C";
alter table zsite.records add column if not exists ref1 uuid;
alter table zsite.records add column if not exists ref2 uuid;
alter table zsite.records add column if not exists ref3 uuid;
alter table zsite.records add column if not exists ref4 uuid;

create index if not exists records_rcpt_idx
  on zsite.records (site_id, collection, recipient_u1, created_at desc, id desc) where recipient_u1 is not null;
create unique index if not exists records_uk1_uidx on zsite.records (site_id, collection, uk1) where uk1 is not null;
create unique index if not exists records_uk2_uidx on zsite.records (site_id, collection, uk2) where uk2 is not null;
create unique index if not exists records_uk3_uidx on zsite.records (site_id, collection, uk3) where uk3 is not null;
create unique index if not exists records_uk4_uidx on zsite.records (site_id, collection, uk4) where uk4 is not null;
create index if not exists records_state_idx
  on zsite.records (site_id, collection, state, created_at desc, id desc) where state is not null;
create index if not exists records_ref1_idx on zsite.records (site_id, collection, ref1) where ref1 is not null;
create index if not exists records_ref2_idx on zsite.records (site_id, collection, ref2) where ref2 is not null;
create index if not exists records_ref3_idx on zsite.records (site_id, collection, ref3) where ref3 is not null;
create index if not exists records_ref4_idx on zsite.records (site_id, collection, ref4) where ref4 is not null;

create table if not exists zsite.recipient_windows (
  site_id      uuid not null references zsite.sites (site_id) on delete cascade,
  collection   text not null,
  recipient    uuid not null,
  window_start timestamptz not null,
  n            integer not null,
  primary key (site_id, collection, recipient)
);
alter table zsite.recipient_windows enable row level security;

create table if not exists zsite.action_receipts (
  site_id      uuid not null references zsite.sites (site_id) on delete cascade,
  action       text not null,
  key          text not null check (key ~ '^[A-Za-z0-9_-]{16,128}$'),
  caller_hash  text not null,
  request_hash text not null,
  result       jsonb,
  created_at   timestamptz not null default now(),
  primary key (site_id, action, key)
);
alter table zsite.action_receipts enable row level security;

create or replace function zsite.record_lock_key(p_site uuid, p_id uuid) returns bigint
language plpgsql immutable security invoker set search_path = '' as $$
begin
  return hashtextextended('r:' || p_site::text || ':' || p_id::text, 0);
end $$;

create or replace function zsite.unique_hash(p_schema jsonb, p_tuple jsonb, p_data jsonb) returns bytea
language plpgsql immutable security invoker set search_path = '' as $$
declare comps jsonb := '[]'::jsonb; f text; v jsonb; p jsonb;
begin
  for f in select e from jsonb_array_elements_text(p_tuple->'fields') with ordinality x(e, o) order by o loop
    v := p_data->f;
    if v is null or jsonb_typeof(v) = 'null' then
      if (p_tuple->>'nulls') = 'distinct' then return null; end if;
      v := 'null'::jsonb;
    else
      p := p_schema->'properties'->f;
      if jsonb_typeof(v) = 'string' and (p->>'format') = 'uuid' then
        v := to_jsonb(lower(v #>> '{}'));
      elsif jsonb_typeof(v) = 'string' and (p->>'format') = 'date-time' then
        v := to_jsonb(to_char((v #>> '{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
      elsif jsonb_typeof(v) = 'number' then
        v := to_jsonb(trim_scale((v #>> '{}')::numeric));
      end if;
    end if;
    comps := comps || jsonb_build_array(v);
  end loop;
  return sha256(convert_to(comps::text, 'UTF8'));
end $$;

create or replace function zsite.ref_col(p_slot text) returns text
language sql immutable security invoker set search_path = '' as $$
  select case p_slot when 'ref1' then 'r.ref1' when 'ref2' then 'r.ref2'
                     when 'ref3' then 'r.ref3' when 'ref4' then 'r.ref4' end
$$;

create or replace function zsite.request_grants() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  c jsonb := zsite.request_ctx();
  v_signed boolean := (c->>'uid') is not null;
  v_uid uuid := (c->>'uid')::uuid;
  x record; s record;
  la text[] := '{}'; lo text[] := '{}'; ga text[] := '{}'; go text[] := '{}'; cr text[] := '{}';
  ua text[] := '{}'; uo text[] := '{}'; da text[] := '{}'; dw text[] := '{}';
  lr text[] := '{}'; gr text[] := '{}'; ur text[] := '{}'; dr text[] := '{}';
  sc text[] := '{}'; sa text[] := '{}'; so text[] := '{}'; sr text[] := '{}';
begin
  if (c->>'site') is not null then
    for x in select y.name, y.rules, y.states from zsite.collections y
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
        if coalesce(x.rules->'list' ? 'recipient', false) then lr := lr || x.name; end if;
        if coalesce(x.rules->'get' ? 'recipient', false) then gr := gr || x.name; end if;
        if coalesce(x.rules->'update' ? 'recipient', false) then ur := ur || x.name; end if;
        if coalesce(x.rules->'delete' ? 'recipient', false) then dr := dr || x.name; end if;
      end if;
      if x.states is not null and x.states ? 'read' then
        sc := sc || x.name;
        for s in select e.key, e.value from jsonb_each(x.states->'read') e loop
          if zsite.ctx_match(c, s.value, null) then sa := sa || (x.name || '/' || s.key); end if;
          if v_signed and s.value ? 'owner' then so := so || (x.name || '/' || s.key); end if;
          if v_signed and s.value ? 'recipient' then sr := sr || (x.name || '/' || s.key); end if;
        end loop;
      end if;
    end loop;
  end if;
  return jsonb_build_object('uid', c->'uid',
    'list_all', to_jsonb(la), 'list_own', to_jsonb(lo), 'get_all', to_jsonb(ga), 'get_own', to_jsonb(go),
    'create', to_jsonb(cr), 'update_all', to_jsonb(ua), 'update_own', to_jsonb(uo),
    'delete_all', to_jsonb(da), 'delete_own', to_jsonb(dw),
    'list_rcpt', to_jsonb(lr), 'get_rcpt', to_jsonb(gr), 'update_rcpt', to_jsonb(ur), 'delete_rcpt', to_jsonb(dr),
    'state_colls', to_jsonb(sc), 'state_all', to_jsonb(sa), 'state_own', to_jsonb(so), 'state_rcpt', to_jsonb(sr));
end $$;

create or replace function zsite.row_visible(g jsonb, r zsite.records) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare v_uid text := g->>'uid'; k text;
begin
  if r.collection is null then return false; end if;
  if not ((g->'list_all') ? r.collection or (g->'get_all') ? r.collection
          or (r.owner_id is not null and r.owner_id::text = v_uid
              and ((g->'list_own') ? r.collection or (g->'get_own') ? r.collection))
          or (r.recipient_u1 is not null and r.recipient_u1::text = v_uid
              and ((g->'list_rcpt') ? r.collection or (g->'get_rcpt') ? r.collection))) then
    return false;
  end if;
  if r.state is null or not (g->'state_colls') ? r.collection then return true; end if;
  k := r.collection || '/' || r.state;
  return (g->'state_all') ? k
      or (r.owner_id is not null and r.owner_id::text = v_uid and (g->'state_own') ? k)
      or (r.recipient_u1 is not null and r.recipient_u1::text = v_uid and (g->'state_rcpt') ? k);
end $$;

create or replace function zsite.project_ctx(p_ctx jsonb, p_fields jsonb, r zsite.records) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare v_data jsonb := r.data; k text; m jsonb;
begin
  if p_fields <> '{}'::jsonb then
    for k, m in select e.key, e.value from jsonb_each(p_fields) e loop
      if m ? 'read' and v_data ? k and not zsite.ctx_match(p_ctx, m->'read', r.owner_id, r.recipient_u1) then
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

create or replace function zsite.k_recipient_take(p_collection text, p_recipient uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_site uuid := zsite.require_site(); v_now timestamptz := date_trunc('minute', clock_timestamp());
begin
  if pg_trigger_depth() = 0 then
    raise exception 'not_in_trigger' using errcode = '42501';
  end if;
  insert into zsite.recipient_windows as w (site_id, collection, recipient, window_start, n)
  values (v_site, p_collection, p_recipient, v_now, 1)
  on conflict (site_id, collection, recipient) do update
     set window_start = case when w.window_start < excluded.window_start then excluded.window_start else w.window_start end,
         n = case when w.window_start < excluded.window_start then 1 else w.n + 1 end
   where w.window_start < excluded.window_start or w.n < 30;
  if not found then
    raise exception 'recipient_rate_limited' using errcode = '53400';
  end if;
end $$;

create or replace function zsite.tg_records_before() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_kernel boolean := current_user = 'zsite_kernel';
  v_end_user boolean := current_user <> 'zsite_kernel'
                        and pg_catalog.current_setting('role', true) in ('anon', 'authenticated');
  v_platform boolean := current_user <> 'zsite_kernel'
                        and pg_catalog.current_setting('role', true) is distinct from 'anon'
                        and pg_catalog.current_setting('role', true) is distinct from 'authenticated';
  v_ctx jsonb;
  v_member uuid;
  c zsite.collections;
  k text;
  w jsonb;
  v_owner uuid;
  v_rcpt uuid;
  v_inv jsonb;
  v_data_changed boolean := TG_OP = 'INSERT' or NEW.data is distinct from OLD.data;
  v_actions jsonb;
  a jsonb;
  v_cf text; v_cur numeric; v_max numeric;
  v_rd jsonb; v_slot text; v_val text; v_tgt_owner uuid;
  v_refs uuid[] := array[null, null, null, null]::uuid[];
  v_old_refs uuid[];
  v_uks bytea[] := array[null, null, null, null]::bytea[];
  v_sf text;
  t jsonb;
begin
  if not v_platform then
    v_ctx := zsite.request_ctx();
    if (v_ctx->>'site') is null or NEW.site_id::text is distinct from v_ctx->>'site' then
      raise exception 'site_mismatch' using errcode = '42501';
    end if;
    v_member := (v_ctx->>'uid')::uuid;

    if TG_OP = 'INSERT' then
      if v_end_user then
        if NEW.owner_id is not null and NEW.owner_id is distinct from v_member then
          raise exception 'owner_id_is_server_assigned' using errcode = '42501';
        end if;
        NEW.owner_id := v_member;
      end if;
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
  if not found or c.kind <> 'records' or (not v_platform and c.archived_at is not null) then
    raise exception 'unknown_collection' using errcode = '42501';
  end if;

  if TG_OP = 'UPDATE' then
    v_old_refs := array[OLD.ref1, OLD.ref2, OLD.ref3, OLD.ref4];
  end if;
  if c.recipient is null then
    NEW.recipient_u1 := null;
  end if;
  for k, v_rd in select e.key, e.value from jsonb_each(c."references") e loop
    v_slot := c.reference_slots->>k;
    if TG_OP = 'UPDATE' and not v_platform and c.recipient is not null
       and k = c.recipient->>'reference' and (NEW.data->k) is distinct from (OLD.data->k) then
      raise exception 'field_not_writable: %', k using errcode = '42501';
    end if;
    v_val := lower(NEW.data->>k);
    if v_val is null then continue; end if;
    if jsonb_typeof(NEW.data->k) is distinct from 'string' or not zsite.is_uuid(v_val) then
      raise exception 'invalid_reference' using errcode = '22023';
    end if;
    if TG_OP = 'INSERT' or (NEW.data->k) is distinct from (OLD.data->k)
       or v_old_refs[substr(v_slot, 4)::int] is distinct from v_val::uuid
       or (c.recipient is not null and k = c.recipient->>'reference' and OLD.recipient_u1 is null)
       or (v_platform and pg_catalog.current_setting('zsite.ref_recheck', true)
                          = NEW.site_id::text || '/' || NEW.collection) then
      perform pg_advisory_xact_lock_shared(zsite.record_lock_key(NEW.site_id, v_val::uuid));
      select r.owner_id into v_tgt_owner
      from zsite.records r
      join zsite.collections tc on tc.site_id = r.site_id and tc.name = r.collection
      where r.site_id = NEW.site_id and r.collection = v_rd->>'collection' and r.id = v_val::uuid
        and tc.archived_at is null;
      if not found then
        raise exception 'invalid_reference' using errcode = '22023';
      end if;
      if c.recipient is not null and k = c.recipient->>'reference' then
        if v_tgt_owner is null then
          raise exception 'invalid_reference' using errcode = '22023';
        end if;
        NEW.recipient_u1 := v_tgt_owner;
      end if;
    end if;
    v_refs[substr(v_slot, 4)::int] := v_val::uuid;
  end loop;
  NEW.ref1 := v_refs[1]; NEW.ref2 := v_refs[2]; NEW.ref3 := v_refs[3]; NEW.ref4 := v_refs[4];

  if TG_OP = 'UPDATE' and v_end_user then
    for k in select e.value->'creates'->>'targetField' from zsite.site_contracts sc, jsonb_each(sc.actions) e
             where sc.site_id = NEW.site_id and sc.schema_version = 2
               and e.value->'creates'->>'collection' = NEW.collection loop
      if (NEW.data->k) is distinct from (OLD.data->k) then
        raise exception 'field_not_writable: %', k using errcode = '42501';
      end if;
    end loop;
  end if;

  if v_end_user then
    v_owner := case when TG_OP = 'INSERT' then NEW.owner_id else OLD.owner_id end;
    v_rcpt := case when TG_OP = 'INSERT' then NEW.recipient_u1 else OLD.recipient_u1 end;
    for k, w in select f.key, f.value->'write' from jsonb_each(c.fields) f where f.value ? 'write' loop
      if (TG_OP = 'INSERT' and NEW.data ? k)
         or (TG_OP = 'UPDATE' and (NEW.data->k) is distinct from (OLD.data->k)) then
        if not zsite.ctx_match(v_ctx, w, v_owner, v_rcpt) then
          raise exception 'field_not_writable: %', k using errcode = '42501';
        end if;
      end if;
    end loop;
  end if;

  if c.states is not null then
    v_sf := c.states->>'field';
    if TG_OP = 'INSERT' then
      if NEW.data ? v_sf then
        if v_end_user and (NEW.data->v_sf) is distinct from (c.states->'initial') then
          raise exception 'field_not_writable: %', v_sf using errcode = '42501';
        end if;
      else
        NEW.data := NEW.data || jsonb_build_object(v_sf, c.states->'initial');
      end if;
    else
      if v_end_user and (NEW.data->v_sf) is distinct from (OLD.data->v_sf) then
        raise exception 'field_not_writable: %', v_sf using errcode = '42501';
      end if;
      if not NEW.data ? v_sf then
        NEW.data := NEW.data || jsonb_build_object(v_sf, c.states->'initial');
      end if;
    end if;
    NEW.state := NEW.data->>v_sf;
  else
    NEW.state := null;
  end if;

  select sc.actions into v_actions from zsite.site_contracts sc
  where sc.site_id = NEW.site_id and sc.schema_version = 2;
  if v_actions is not null and v_actions <> '{}'::jsonb then
    for a in select e.value from jsonb_each(v_actions) e
             where e.value->'target'->>'collection' = NEW.collection loop
      v_cf := a->'target'->>'counter';
      if TG_OP = 'INSERT' then
        if NEW.data ? v_cf then
          if not v_platform and (NEW.data->v_cf) is distinct from (a->'initial') then
            raise exception 'field_not_writable: %', v_cf using errcode = '42501';
          end if;
        else
          NEW.data := NEW.data || jsonb_build_object(v_cf, a->'initial');
        end if;
      else
        if v_end_user and (NEW.data->v_cf) is distinct from (OLD.data->v_cf) then
          raise exception 'field_not_writable: %', v_cf using errcode = '42501';
        end if;
        if not NEW.data ? v_cf then
          NEW.data := NEW.data || jsonb_build_object(v_cf, a->'initial');
        end if;
      end if;
      if jsonb_typeof(NEW.data->v_cf) = 'number' then
        v_cur := (NEW.data->>v_cf)::numeric;
        v_max := case when a->'bounds' ? 'max' then (a->'bounds'->>'max')::numeric
                      when jsonb_typeof(NEW.data->(a->'bounds'->>'maxField')) = 'number'
                      then (NEW.data->>(a->'bounds'->>'maxField'))::numeric end;
        if v_cur < (a->'bounds'->>'min')::numeric or (v_max is not null and v_cur > v_max) then
          raise exception 'action_bound' using errcode = '55000';
        end if;
      end if;
    end loop;
  end if;

  if v_data_changed or NEW.data is distinct from OLD.data then
    perform zsite.validate_doc(c.schema, NEW.data);
    NEW.updated_at := now();
  end if;

  if c.uniques <> '[]'::jsonb
     and not (v_platform and pg_catalog.current_setting('zsite.uk_clear', true)
                             = NEW.site_id::text || '/' || NEW.collection) then
    for t in select e from jsonb_array_elements(c.uniques) e loop
      v_slot := c.unique_slots->>(zsite.unique_key(t));
      v_uks[substr(v_slot, 3)::int] := zsite.unique_hash(c.schema, t, NEW.data);
    end loop;
  end if;
  NEW.uk1 := v_uks[1]; NEW.uk2 := v_uks[2]; NEW.uk3 := v_uks[3]; NEW.uk4 := v_uks[4];

  if TG_OP = 'INSERT' and not v_platform and NEW.recipient_u1 is not null then
    perform zsite.k_recipient_take(NEW.collection, NEW.recipient_u1);
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

create or replace function zsite.ref_delete_work(p_site uuid, p_collection text, p_id uuid, p_platform boolean)
returns void
language plpgsql volatile security invoker set search_path = '' as $$
declare d record; col text; n integer; v_total integer;
begin
  perform pg_advisory_xact_lock(zsite.record_lock_key(p_site, p_id));
  for d in select c.name, e.key as field, e.value->>'on_delete' as mode, c.reference_slots->>e.key as slot
           from zsite.collections c, jsonb_each(c."references") e
           where c.site_id = p_site and e.value->>'collection' = p_collection
           order by c.name, e.key loop
    col := zsite.ref_col(d.slot);
    if col is null then continue; end if;
    execute 'select count(*) from zsite.records r where r.site_id = $1 and r.collection = $2 and ' || col || ' = $3'
      into n using p_site, d.name, p_id;
    continue when n = 0;
    if d.mode = 'restrict' and not p_platform then
      raise exception 'reference_restricted' using errcode = '55000';
    end if;
    if not p_platform then
      v_total := coalesce(nullif(pg_catalog.current_setting('zsite.cascade_n', true), ''), '0')::int + n;
      if v_total > 1000 then
        raise exception 'cascade_too_large' using errcode = '54000';
      end if;
      perform pg_catalog.set_config('zsite.cascade_n', v_total::text, true);
    end if;
    if d.mode = 'nullify' then
      execute 'update zsite.records r set data = r.data - $4 where r.site_id = $1 and r.collection = $2 and '
              || col || ' = $3'
        using p_site, d.name, p_id, d.field;
    else
      execute 'delete from zsite.records r where r.site_id = $1 and r.collection = $2 and ' || col || ' = $3'
        using p_site, d.name, p_id;
    end if;
  end loop;
end $$;

create or replace function zsite.k_ref_delete(p_collection text, p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_site uuid := zsite.require_site();
begin
  if exists (select 1 from zsite.records r
             where r.site_id = v_site and r.collection = p_collection and r.id = p_id) then
    raise exception 'not_deleted' using errcode = '42501';
  end if;
  perform zsite.ref_delete_work(v_site, p_collection, p_id, false);
end $$;

create or replace function zsite.tg_records_after_delete() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_platform boolean := current_user <> 'zsite_kernel'
                        and pg_catalog.current_setting('role', true) is distinct from 'anon'
                        and pg_catalog.current_setting('role', true) is distinct from 'authenticated';
begin
  if not exists (select 1 from zsite.collections c, jsonb_each(c."references") e
                 where c.site_id = OLD.site_id and e.value->>'collection' = OLD.collection) then
    return null;
  end if;
  if v_platform then
    perform zsite.ref_delete_work(OLD.site_id, OLD.collection, OLD.id, true);
  else
    perform zsite.k_ref_delete(OLD.collection, OLD.id);
  end if;
  return null;
end $$;

create or replace function zsite.tg_records_delete_stmt() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if pg_trigger_depth() = 1 then
    perform pg_catalog.set_config('zsite.cascade_n', '0', true);
  end if;
  return null;
end $$;
drop trigger if exists records_refs_delete_stmt on zsite.records;
create trigger records_refs_delete_stmt before delete on zsite.records
  for each statement execute function zsite.tg_records_delete_stmt();
drop trigger if exists records_refs_delete on zsite.records;
create trigger records_refs_delete after delete on zsite.records
  for each row execute function zsite.tg_records_after_delete();

create or replace function zsite.tg_collections_v2_backfill() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_constraint text;
begin
  begin
    if OLD.unique_slots is distinct from NEW.unique_slots then
      perform pg_catalog.set_config('zsite.uk_clear', NEW.site_id::text || '/' || NEW.name, true);
      update zsite.records r set t1 = r.t1 where r.site_id = NEW.site_id and r.collection = NEW.name;
      perform pg_catalog.set_config('zsite.uk_clear', '', true);
    end if;
    perform pg_catalog.set_config('zsite.ref_recheck', NEW.site_id::text || '/' || NEW.name, true);
    update zsite.records r set t1 = r.t1 where r.site_id = NEW.site_id and r.collection = NEW.name;
    perform pg_catalog.set_config('zsite.ref_recheck', '', true);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint like 'records_uk%' then
      raise exception 'unique_conflict' using errcode = '23505';
    end if;
    raise;
  end;
  return null;
end $$;
drop trigger if exists collections_v2_backfill on zsite.collections;
create trigger collections_v2_backfill after update on zsite.collections
  for each row when (old.uniques is distinct from new.uniques
                     or old.unique_slots is distinct from new.unique_slots
                     or old.states is distinct from new.states
                     or old."references" is distinct from new."references"
                     or old.reference_slots is distinct from new.reference_slots
                     or old.recipient is distinct from new.recipient)
  execute function zsite.tg_collections_v2_backfill();

create or replace function zsite.tg_site_contracts_backfill() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_coll text;
begin
  if TG_OP = 'UPDATE' and OLD.actions = NEW.actions and OLD.schema_version = NEW.schema_version then
    return null;
  end if;
  for v_coll in select distinct e.value->'target'->>'collection' from jsonb_each(NEW.actions) e loop
    update zsite.records r set t1 = r.t1 where r.site_id = NEW.site_id and r.collection = v_coll;
  end loop;
  return null;
end $$;
drop trigger if exists site_contracts_backfill on zsite.site_contracts;
create trigger site_contracts_backfill after insert or update on zsite.site_contracts
  for each row execute function zsite.tg_site_contracts_backfill();

drop policy if exists sites_own on zsite.sites;
create policy sites_own on zsite.sites for select to anon, authenticated, zsite_facade, zsite_kernel
  using (site_id = (select zsite.claim_site()));
drop policy if exists collections_site on zsite.collections;
create policy collections_site on zsite.collections as restrictive for all
  to anon, authenticated, zsite_facade, zsite_kernel
  using (site_id = (select zsite.request_site()));
drop policy if exists collections_read on zsite.collections;
create policy collections_read on zsite.collections for select to anon, authenticated, zsite_facade, zsite_kernel
  using (true);
drop policy if exists members_site on zsite.members;
create policy members_site on zsite.members as restrictive for all to authenticated, zsite_facade, zsite_kernel
  using (site_id = (select zsite.request_site()));
drop policy if exists members_self on zsite.members;
create policy members_self on zsite.members for select to authenticated, zsite_facade, zsite_kernel
  using (user_id = (select zsite.request_user()));
drop policy if exists identities_self on zsite.identities;
create policy identities_self on zsite.identities for select to authenticated, zsite_facade, zsite_kernel
  using (site_id = (select zsite.request_site()) and auth_user_id = (select zsite.request_user()));

drop policy if exists records_site on zsite.records;
create policy records_site on zsite.records as restrictive for all to zsite_facade, zsite_kernel
  using (site_id = (select zsite.request_site()))
  with check (site_id = (select zsite.request_site()));
drop policy if exists records_kernel on zsite.records;
create policy records_kernel on zsite.records for all to zsite_kernel using (true) with check (true);

drop policy if exists records_read on zsite.records;
create policy records_read on zsite.records for select to zsite_facade
  using (
       collection = any ((select zsite.grant_names('{list_all,get_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{list_own,get_own}'))::text[]))
    or (recipient_u1 is not null and recipient_u1 = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{list_rcpt,get_rcpt}'))::text[])));

drop policy if exists records_state_read on zsite.records;
create policy records_state_read on zsite.records as restrictive for select to zsite_facade
  using (
       state is null
    or not (collection = any ((select zsite.grant_names('{state_colls}'))::text[]))
    or (collection || '/' || state) = any ((select zsite.grant_names('{state_all}'))::text[])
    or (owner_id is not null and owner_id = (select zsite.grant_uid())
        and (collection || '/' || state) = any ((select zsite.grant_names('{state_own}'))::text[]))
    or (recipient_u1 is not null and recipient_u1 = (select zsite.grant_uid())
        and (collection || '/' || state) = any ((select zsite.grant_names('{state_rcpt}'))::text[])));

drop policy if exists records_update on zsite.records;
create policy records_update on zsite.records for update to zsite_facade
  using ((select zsite.request_user()) is not null and (
       collection = any ((select zsite.grant_names('{update_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{update_own}'))::text[]))
    or (recipient_u1 is not null and recipient_u1 = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{update_rcpt}'))::text[]))))
  with check ((select zsite.request_user()) is not null and (
       collection = any ((select zsite.grant_names('{update_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{update_own}'))::text[]))
    or (recipient_u1 is not null and recipient_u1 = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{update_rcpt}'))::text[]))));

drop policy if exists records_delete on zsite.records;
create policy records_delete on zsite.records for delete to zsite_facade
  using ((select zsite.request_user()) is not null and (
       collection = any ((select zsite.grant_names('{delete_all}'))::text[])
    or (owner_id = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{delete_own}'))::text[]))
    or (recipient_u1 is not null and recipient_u1 = (select zsite.grant_uid())
        and collection = any ((select zsite.grant_names('{delete_rcpt}'))::text[]))));

drop policy if exists recipient_windows_kernel on zsite.recipient_windows;
create policy recipient_windows_kernel on zsite.recipient_windows for all to zsite_kernel
  using (site_id = (select zsite.request_site())) with check (site_id = (select zsite.request_site()));
drop policy if exists action_receipts_kernel on zsite.action_receipts;
create policy action_receipts_kernel on zsite.action_receipts for all to zsite_kernel
  using (site_id = (select zsite.request_site())) with check (site_id = (select zsite.request_site()));

grant usage on schema zsite to zsite_kernel;
revoke all on zsite.recipient_windows, zsite.action_receipts from public, anon, authenticated, zsite_facade;
grant select, insert, update on zsite.recipient_windows to zsite_kernel;
grant select, insert, update on zsite.action_receipts to zsite_kernel;
grant select, insert, update, delete on zsite.recipient_windows, zsite.action_receipts to service_role;
grant select on zsite.sites, zsite.collections, zsite.members to zsite_kernel;
grant select (site_id, auth_user_id, state) on zsite.identities to zsite_kernel;
grant select on zsite.records to zsite_kernel;
grant insert (site_id, collection, id, owner_id, data) on zsite.records to zsite_kernel;
grant update (data) on zsite.records to zsite_kernel;
grant delete on zsite.records to zsite_kernel;

grant create on schema zsite to zsite_kernel;
alter function zsite.k_recipient_take(text, uuid) owner to zsite_kernel;
alter function zsite.k_ref_delete(text, uuid) owner to zsite_kernel;
revoke create on schema zsite from zsite_kernel;

revoke all on function
  zsite.record_lock_key(uuid, uuid), zsite.unique_hash(jsonb, jsonb, jsonb), zsite.ref_col(text),
  zsite.row_visible(jsonb, zsite.records), zsite.ref_delete_work(uuid, text, uuid, boolean),
  zsite.k_recipient_take(text, uuid), zsite.k_ref_delete(text, uuid)
  from public;
grant execute on function
  zsite.record_lock_key(uuid, uuid), zsite.unique_hash(jsonb, jsonb, jsonb), zsite.ref_col(text),
  zsite.row_visible(jsonb, zsite.records)
  to anon, authenticated, service_role, zsite_facade, zsite_kernel;
grant execute on function zsite.ref_delete_work(uuid, text, uuid, boolean) to service_role, zsite_kernel;
grant execute on function zsite.k_recipient_take(text, uuid), zsite.k_ref_delete(text, uuid)
  to zsite_facade, zsite_kernel;
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'zsite' and p.prokind = 'f'
             and has_function_privilege('zsite_facade', p.oid, 'execute')
             and not has_function_privilege('zsite_kernel', p.oid, 'execute') loop
    execute format('grant execute on function %s to zsite_kernel', f);
  end loop;
end $$;
revoke execute on function zsite.tg_records_after_delete(), zsite.tg_records_delete_stmt(), zsite.tg_collections_v2_backfill(),
  zsite.tg_site_contracts_backfill() from public, anon, authenticated, service_role;

insert into zsite.migrations (version) values ('0007_relational_slots_rls') on conflict do nothing;

commit;
