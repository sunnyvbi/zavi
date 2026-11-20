
begin;

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
  v_states text[];
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
  v_own boolean; v_rc boolean; v_both boolean := false;
  i integer;
begin
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records' and x.archived_at is null;
  if not found then
    raise exception 'unknown_collection' using errcode = '42501';
  end if;

  if not (v_g->'list_all') ? p_collection then
    v_own := (v_g->'list_own') ? p_collection;
    v_rc := (v_g->'list_rcpt') ? p_collection;
    v_owner := (v_g->>'uid')::uuid;
    if v_own and v_rc then
      v_both := true;
    elsif v_own then
      v_where := v_where || ' and r.owner_id = $3';
    elsif v_rc then
      v_where := v_where || ' and r.recipient_u1 = $3';
    else
      return jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null);
    end if;
  elsif (v_g->'state_colls') ? p_collection
        and not exists (select 1 from jsonb_array_elements_text(v_g->'state_own') s where left(s, length(p_collection) + 1) = p_collection || '/')
        and not exists (select 1 from jsonb_array_elements_text(v_g->'state_rcpt') s where left(s, length(p_collection) + 1) = p_collection || '/') then
    v_states := array(select substr(s, length(p_collection) + 2)
                      from jsonb_array_elements_text(v_g->'state_all') s where left(s, length(p_collection) + 1) = p_collection || '/');
    if coalesce(array_length(v_states, 1), 0) = 0 then
      return jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null);
    end if;
    if array_length(v_states, 1) < jsonb_array_length(c.states->'values') then
      v_where := v_where || ' and r.state = any($13)';
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

  if v_both then
    v_sql := 'select array_agg(s.r order by s.n) from ('
          || 'select r, row_number() over () as n from (select r.* from ('
          || '(select r.* from zsite.records r where r.site_id = $1 and r.collection = $2 and r.owner_id = $3'
          || v_where || v_order || ' limit $12)'
          || ' union all (select r.* from zsite.records r where r.site_id = $1 and r.collection = $2'
          || ' and r.recipient_u1 = $3 and r.owner_id is distinct from $3'
          || v_where || v_order || ' limit $12)) r'
          || v_order || ' limit $12) r) s';
  else
    v_sql := 'select array_agg(s.r order by s.n) from ('
          || 'select r, row_number() over () as n from (select r.* from zsite.records r'
          || ' where r.site_id = $1 and r.collection = $2' || v_where
          || v_order || ' limit $12) r) s';
  end if;

  execute v_sql into v_rows
    using v_site, p_collection, v_owner, v_tv, v_nv, v_dv, v_cts, v_cid,
          v_cs_t, v_cs_n, v_cs_d, v_lim + 1, v_states;

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
         or (x.owner_id is not null and x.owner_id::text = v_g->>'uid' and (v_g->'get_own') ? p_collection)
         or (x.recipient_u1 is not null and x.recipient_u1::text = v_g->>'uid' and (v_g->'get_rcpt') ? p_collection));
  if not found then return null; end if;
  return zsite.project_ctx(v_ctx, c.fields, r);
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
    if v_constraint like 'records_uk%' then
      raise exception 'unique_conflict' using errcode = '23505';
    end if;
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
declare v_site uuid := zsite.require_site(); v_old jsonb; v_new jsonb; n integer; v_constraint text;
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

  begin
    update zsite.records r set data = v_new
    where r.site_id = v_site and r.collection = p_collection and r.id = p_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint like 'records_uk%' then
      raise exception 'unique_conflict' using errcode = '23505';
    end if;
    raise;
  end;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'updated', true);
end $$;

create or replace function zsite.k_transition(p_collection text, p_id uuid, p_to text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_ctx jsonb := zsite.request_ctx();
  v_g jsonb := zsite.request_grants();
  c zsite.collections; r zsite.records;
  v_n integer; v_legal boolean;
begin
  if (v_ctx->>'uid') is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = p_collection and x.kind = 'records'
    and x.archived_at is null and x.states is not null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into r from zsite.records x
  where x.site_id = v_site and x.collection = p_collection and x.id = p_id
  for update;
  if not found or not zsite.row_visible(v_g, r) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select count(*), coalesce(bool_or(t->>'from' = r.state), false) into v_n, v_legal
  from jsonb_array_elements(c.states->'transitions') t
  where t->>'to' = p_to and zsite.ctx_match(v_ctx, t->'principals', r.owner_id, r.recipient_u1)
    and not exists (select 1 from zsite.site_contracts sc, jsonb_each(sc.actions) e
                    where sc.site_id = v_site and sc.schema_version = 2
                      and e.value->'creates'->>'collection' = p_collection
                      and e.value->'inverse'->'transition'->>'from' = t->>'from'
                      and e.value->'inverse'->'transition'->>'to' = t->>'to');
  if v_n = 0 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if r.state = p_to then
    return jsonb_build_object('id', p_id, 'from', r.state, 'to', p_to, 'transitioned', false);
  end if;
  if not v_legal then
    raise exception 'transition_conflict' using errcode = '55000';
  end if;
  update zsite.records x set data = jsonb_set(x.data, array[c.states->>'field'], to_jsonb(p_to))
  where x.site_id = v_site and x.collection = p_collection and x.id = p_id;
  return jsonb_build_object('id', p_id, 'from', r.state, 'to', p_to, 'transitioned', true);
end $$;

create or replace function zsite.k_run_action(
  p_action text, p_target_id uuid, p_record_id uuid, p_data jsonb, p_idempotency_key text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_ctx jsonb := zsite.request_ctx();
  v_g jsonb := zsite.request_grants();
  v_uid uuid := (v_ctx->>'uid')::uuid;
  v_actions jsonb;
  a jsonb; v_inverse boolean := false; v_princ jsonb;
  tc zsite.collections; cc zsite.collections;
  t zsite.records; r zsite.records; v_ref zsite.records;
  v_ch text; v_rh text; rc zsite.action_receipts;
  v_cf text; v_tf text; v_cur numeric; v_new numeric; v_max numeric; v_delta numeric;
  v_doc jsonb; v_rid uuid; v_tid uuid; v_result jsonb; k text; w jsonb; v_rd jsonb;
  v_constraint text;
begin
  select sc.actions into v_actions from zsite.site_contracts sc
  where sc.site_id = v_site and sc.schema_version = 2;
  if v_actions is not null and v_actions ? p_action then
    a := v_actions->p_action;
    v_princ := a->'principals';
  elsif v_actions is not null then
    select e.value into a from jsonb_each(v_actions) e where e.value->'inverse'->>'name' = p_action;
    v_inverse := a is not null;
    v_princ := a->'inverse'->'principals';
  end if;
  if a is null then
    raise exception 'action_not_allowed' using errcode = '42501';
  end if;
  if v_uid is null and not coalesce(v_princ ? 'anyone', false) then
    raise exception 'action_not_allowed' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_data is null then p_data := '{}'::jsonb; end if;
  if jsonb_typeof(p_data) <> 'object'
     or (not v_inverse and (p_target_id is null or p_record_id is not null))
     or (v_inverse and (p_record_id is null or p_target_id is not null or p_data <> '{}'::jsonb)) then
    raise exception 'invalid_action_input' using errcode = '22023';
  end if;

  v_ch := encode(sha256(convert_to(coalesce(v_uid::text, 'anon'), 'UTF8')), 'hex');
  v_rh := encode(sha256(convert_to(jsonb_build_array(p_action, p_target_id, p_record_id, p_data)::text, 'UTF8')), 'hex');
  insert into zsite.action_receipts (site_id, action, key, caller_hash, request_hash)
  values (v_site, p_action, p_idempotency_key, v_ch, v_rh)
  on conflict (site_id, action, key) do nothing;
  if not found then
    select * into rc from zsite.action_receipts x
    where x.site_id = v_site and x.action = p_action and x.key = p_idempotency_key;
    if rc.caller_hash is distinct from v_ch or rc.request_hash is distinct from v_rh or rc.result is null then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    return rc.result || jsonb_build_object('replayed', true);
  end if;

  select * into tc from zsite.collections x
  where x.site_id = v_site and x.name = a->'target'->>'collection' and x.kind = 'records' and x.archived_at is null;
  select * into cc from zsite.collections x
  where x.site_id = v_site and x.name = a->'creates'->>'collection' and x.kind = 'records' and x.archived_at is null;
  if tc.name is null or cc.name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_cf := a->'target'->>'counter';
  v_tf := a->'creates'->>'targetField';

  if not v_inverse then
    select * into t from zsite.records x
    where x.site_id = v_site and x.collection = tc.name and x.id = p_target_id
    for update;
    if not found or not zsite.row_visible(v_g, t) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if not zsite.ctx_match(v_ctx, v_princ, t.owner_id, t.recipient_u1) then
      raise exception 'action_not_allowed' using errcode = '42501';
    end if;
    v_delta := (a->>'delta')::numeric;

    if p_data ? v_tf and lower(p_data->>v_tf) is distinct from p_target_id::text then
      raise exception 'invalid_action_input' using errcode = '22023';
    end if;
    if cc.states is not null and p_data ? (cc.states->>'field') then
      raise exception 'field_not_writable: %', cc.states->>'field' using errcode = '42501';
    end if;
    for k in select e.value->'target'->>'counter' from jsonb_each(v_actions) e
             where e.value->'target'->>'collection' = cc.name loop
      if p_data ? k then
        raise exception 'field_not_writable: %', k using errcode = '42501';
      end if;
    end loop;
    for k, w in select f.key, f.value->'write' from jsonb_each(cc.fields) f where f.value ? 'write' loop
      if p_data ? k and not zsite.ctx_match(v_ctx, w, v_uid, null) then
        raise exception 'field_not_writable: %', k using errcode = '42501';
      end if;
    end loop;
    for k, v_rd in select e.key, e.value from jsonb_each(cc."references") e where e.key <> v_tf loop
      continue when not p_data ? k;
      if jsonb_typeof(p_data->k) is distinct from 'string' or not zsite.is_uuid(lower(p_data->>k)) then
        raise exception 'invalid_reference' using errcode = '22023';
      end if;
      select * into v_ref from zsite.records y
      where y.site_id = v_site and y.collection = v_rd->>'collection' and y.id = lower(p_data->>k)::uuid;
      if not found or not zsite.row_visible(v_g, v_ref) then
        raise exception 'invalid_reference' using errcode = '22023';
      end if;
    end loop;
    v_doc := p_data || jsonb_build_object(v_tf, p_target_id::text);
    v_tid := p_target_id;
  else
    select * into r from zsite.records x
    where x.site_id = v_site and x.collection = cc.name and x.id = p_record_id
    for update;
    if not found or not zsite.row_visible(v_g, r) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if not zsite.ctx_match(v_ctx, v_princ, r.owner_id, r.recipient_u1) then
      raise exception 'action_not_allowed' using errcode = '42501';
    end if;
    if r.state is distinct from (a->'inverse'->'transition'->>'from') then
      raise exception 'transition_conflict' using errcode = '55000';
    end if;
    v_tid := case when zsite.is_uuid(lower(r.data->>v_tf)) then lower(r.data->>v_tf)::uuid end;
    select * into t from zsite.records x
    where x.site_id = v_site and x.collection = tc.name and x.id = v_tid
    for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    v_delta := (a->'inverse'->>'delta')::numeric;
  end if;

  v_cur := case when jsonb_typeof(t.data->v_cf) = 'number' then (t.data->>v_cf)::numeric
                else (a->>'initial')::numeric end;
  v_new := v_cur + v_delta;
  v_max := case when a->'bounds' ? 'max' then (a->'bounds'->>'max')::numeric
                when jsonb_typeof(t.data->(a->'bounds'->>'maxField')) = 'number'
                then (t.data->>(a->'bounds'->>'maxField'))::numeric end;
  if v_new < (a->'bounds'->>'min')::numeric or v_max is null or v_new > v_max then
    raise exception 'action_bound' using errcode = '55000';
  end if;

  update zsite.records x set data = jsonb_set(x.data, array[v_cf], to_jsonb(v_new))
  where x.site_id = v_site and x.collection = tc.name and x.id = v_tid;

  if not v_inverse then
    v_rid := gen_random_uuid();
    begin
      insert into zsite.records (site_id, collection, id, owner_id, data)
      values (v_site, cc.name, v_rid, v_uid, v_doc);
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint like 'records_uk%' then
        raise exception 'unique_conflict' using errcode = '23505';
      end if;
      raise;
    end;
  else
    v_rid := p_record_id;
    update zsite.records x
       set data = jsonb_set(x.data, array[cc.states->>'field'], to_jsonb(a->'inverse'->'transition'->>'to'))
     where x.site_id = v_site and x.collection = cc.name and x.id = p_record_id;
  end if;

  v_result := jsonb_build_object('action', p_action, 'target_id', v_tid, 'record_id', v_rid,
                                 'counter', v_new);
  update zsite.action_receipts x set result = v_result
  where x.site_id = v_site and x.action = p_action and x.key = p_idempotency_key;
  return v_result || jsonb_build_object('replayed', false);
end $$;

create or replace function api.transition_record(p_collection text, p_id uuid, p_to text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform zsite.require_site();
  if zsite.request_user() is null then
    raise exception 'anonymous_write_forbidden' using errcode = '42501';
  end if;
  return zsite.k_transition(p_collection, p_id, p_to);
end $$;

create or replace function api.run_action(
  p_action text, p_target_id uuid default null, p_record_id uuid default null,
  p_data jsonb default '{}'::jsonb, p_idempotency_key text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform zsite.require_site();
  return zsite.k_run_action(p_action, p_target_id, p_record_id, p_data, p_idempotency_key);
end $$;

create or replace function api.aggregate(p_name text, p_filter jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_ctx jsonb := zsite.request_ctx();
  v_g jsonb := zsite.request_grants();
  g jsonb; c zsite.collections;
  v_fn text; v_field text; v_col text;
  k text; v jsonb; typ text; col text;
  v_tv text[] := '{}'; v_nv numeric[] := '{}'; v_dv timestamptz[] := '{}';
  v_where text := '';
  v_n bigint; v_sum numeric; v_avg numeric;
  v_t0 timestamptz;
begin
  if zsite.request_user() is null or (v_ctx->>'uid') is null then
    raise exception 'aggregate_not_allowed' using errcode = '42501';
  end if;
  select sc.aggregates->p_name into g from zsite.site_contracts sc
  where sc.site_id = v_site and sc.schema_version = 2;
  if g is null or not zsite.ctx_match(v_ctx, g->'principals', null, null) then
    raise exception 'aggregate_not_allowed' using errcode = '42501';
  end if;
  select * into c from zsite.collections x
  where x.site_id = v_site and x.name = g->>'collection' and x.kind = 'records' and x.archived_at is null;
  if not found or not (v_g->'list_all') ? c.name then
    raise exception 'aggregate_not_allowed' using errcode = '42501';
  end if;
  v_fn := g->>'fn';
  v_field := g->>'field';
  if v_field is not null then
    v_col := zsite.slot_col(c.index_slots->>v_field);
    if v_col is null or v_col not in ('r.n1', 'r.n2')
       or (c.fields->v_field ? 'read' and not zsite.ctx_match(v_ctx, c.fields->v_field->'read', null, null)) then
      raise exception 'aggregate_not_allowed' using errcode = '42501';
    end if;
  end if;

  if p_filter is null then p_filter := '{}'::jsonb; end if;
  if jsonb_typeof(p_filter) <> 'object' then
    raise exception 'invalid_filter' using errcode = '22023';
  end if;
  if c.reindex_pending and (v_field is not null or p_filter <> '{}'::jsonb) then
    raise exception 'index_building' using errcode = '55000';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_filter) e loop
    if not coalesce(g->'filters' ? k, false)
       or (c.fields->k ? 'read' and not zsite.ctx_match(v_ctx, c.fields->k->'read', null, null)) then
      raise exception 'filter_not_allowed' using errcode = '22023';
    end if;
    if jsonb_typeof(v) not in ('string', 'number', 'boolean') then
      raise exception 'invalid_filter' using errcode = '22023';
    end if;
    if k = (c.states->>'field') then
      if jsonb_typeof(v) <> 'string' then
        raise exception 'invalid_filter' using errcode = '22023';
      end if;
      v_tv := v_tv || (v #>> '{}');
      v_where := v_where || ' and r.state = $3[' || array_length(v_tv, 1) || ']';
      continue;
    end if;
    typ := c.indexes->k->>'type';
    col := zsite.slot_col(c.index_slots->>k);
    if col is null then
      raise exception 'filter_not_allowed' using errcode = '22023';
    end if;
    if typ = 'text' and jsonb_typeof(v) in ('string', 'boolean') then
      v_tv := v_tv || zsite.slot_text(v);
      v_where := v_where || ' and ' || col || ' = $3[' || array_length(v_tv, 1) || ']';
    elsif typ = 'number' and jsonb_typeof(v) = 'number' then
      v_nv := v_nv || zsite.slot_num(v);
      v_where := v_where || ' and ' || col || ' = $4[' || array_length(v_nv, 1) || ']';
    elsif typ = 'timestamp' and zsite.slot_ts(v) is not null
          and (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$' then
      v_dv := v_dv || zsite.slot_ts(v);
      v_where := v_where || ' and ' || col || ' = $5[' || array_length(v_dv, 1) || ']';
    else
      raise exception 'invalid_filter' using errcode = '22023';
    end if;
  end loop;

  v_t0 := clock_timestamp();
  execute 'select count(*), sum(s.v), avg(s.v) from (select ' || coalesce(v_col, 'null::numeric')
       || ' as v from zsite.records r where r.site_id = $1 and r.collection = $2' || v_where
       || ' limit 10001) s'
    into v_n, v_sum, v_avg
    using v_site, c.name, v_tv, v_nv, v_dv;
  if v_n > 10000 or clock_timestamp() - v_t0 > interval '250 milliseconds' then
    raise exception 'aggregate_too_large' using errcode = '54000';
  end if;
  return jsonb_build_object('value', case v_fn when 'count' then v_n::numeric
                                              when 'sum' then coalesce(v_sum, 0)
                                              else v_avg end);
end $$;

grant create on schema zsite to zsite_kernel;
grant create on schema api to zsite_facade;
alter function zsite.k_transition(text, uuid, text) owner to zsite_kernel;
alter function zsite.k_run_action(text, uuid, uuid, jsonb, text) owner to zsite_kernel;
alter function api.transition_record(text, uuid, text) owner to zsite_facade;
alter function api.run_action(text, uuid, uuid, jsonb, text) owner to zsite_facade;
alter function api.aggregate(text, jsonb) owner to zsite_facade;
alter function api.list_records(text, jsonb, integer, text, text) owner to zsite_facade;
alter function api.get_record(text, uuid) owner to zsite_facade;
alter function api.create_record(text, jsonb, text) owner to zsite_facade;
alter function api.update_record(text, uuid, jsonb) owner to zsite_facade;
revoke create on schema zsite from zsite_kernel;
revoke create on schema api from zsite_facade;

revoke all on function zsite.k_transition(text, uuid, text), zsite.k_run_action(text, uuid, uuid, jsonb, text)
  from public;
grant execute on function zsite.k_transition(text, uuid, text), zsite.k_run_action(text, uuid, uuid, jsonb, text)
  to zsite_facade;

revoke all on function api.transition_record(text, uuid, text), api.run_action(text, uuid, uuid, jsonb, text),
  api.aggregate(text, jsonb) from public;
grant execute on function api.transition_record(text, uuid, text), api.aggregate(text, jsonb) to authenticated;
grant execute on function api.run_action(text, uuid, uuid, jsonb, text) to anon, authenticated;

insert into zsite.migrations (version) values ('0008_relational_api') on conflict do nothing;

commit;
