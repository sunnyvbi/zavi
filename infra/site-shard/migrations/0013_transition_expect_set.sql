
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';

create or replace function zsite.k_transition(
  p_collection text, p_id uuid, p_to text, p_expect jsonb default null, p_set jsonb default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_ctx jsonb := zsite.request_ctx();
  v_g jsonb := zsite.request_grants();
  c zsite.collections; r zsite.records;
  v_n integer; v_legal boolean;
  v_cas boolean := p_expect is not null or p_set is not null;
  k text; v jsonb; w jsonb; v_rows integer;
begin
  if (v_ctx->>'uid') is null and (v_ctx->>'fn') is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (p_expect is not null and (jsonb_typeof(p_expect) <> 'object' or p_expect = '{}'::jsonb))
     or (p_set is not null and (jsonb_typeof(p_set) <> 'object' or p_set = '{}'::jsonb
                                 or exists (select 1 from jsonb_each(p_set) e where jsonb_typeof(e.value) = 'null'))) then
    raise exception 'invalid_transition' using errcode = '22023';
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

  if p_expect is not null then
    for k in select jsonb_object_keys(p_expect) loop
      if not (c.schema->'properties') ? k then
        raise exception 'invalid_transition' using errcode = '22023';
      end if;
      w := c.fields->k->'read';
      if w is not null and not zsite.ctx_match(v_ctx, w, r.owner_id, r.recipient_u1) then
        raise exception 'field_not_readable: %', k using errcode = '42501';
      end if;
    end loop;
  end if;
  if p_set is not null then
    if not zsite.ctx_match(v_ctx, coalesce(c.rules->'update', '[]'::jsonb), r.owner_id, r.recipient_u1) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    for k in select jsonb_object_keys(p_set) loop
      if not (c.schema->'properties') ? k or k = c.states->>'field' or c."references" ? k then
        raise exception 'field_not_writable: %', k using errcode = '42501';
      end if;
      if exists (select 1 from zsite.site_contracts sc, jsonb_each(sc.actions) e
                 where sc.site_id = v_site and sc.schema_version = 2
                   and ((e.value->'target'->>'collection' = p_collection and e.value->'target'->>'counter' = k)
                     or (e.value->'creates'->>'collection' = p_collection and e.value->'creates'->>'targetField' = k))) then
        raise exception 'field_not_writable: %', k using errcode = '42501';
      end if;
      w := c.fields->k->'write';
      if w is not null and not zsite.ctx_match(v_ctx, w, r.owner_id, r.recipient_u1) then
        raise exception 'field_not_writable: %', k using errcode = '42501';
      end if;
    end loop;
  end if;

  if r.state = p_to then
    if v_cas then
      raise exception 'transition_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object('id', p_id, 'from', r.state, 'to', p_to, 'transitioned', false);
  end if;
  if not v_legal then
    raise exception 'transition_conflict' using errcode = '55000';
  end if;
  if p_expect is not null then
    for k, v in select e.key, e.value from jsonb_each(p_expect) e loop
      if (r.data->k) is distinct from (case when jsonb_typeof(v) = 'null' then null else v end) then
        raise exception 'transition_conflict' using errcode = '55000';
      end if;
    end loop;
  end if;
  update zsite.records x
  set data = jsonb_set(x.data || coalesce(p_set, '{}'::jsonb), array[c.states->>'field'], to_jsonb(p_to))
  where x.site_id = v_site and x.collection = p_collection and x.id = p_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'from', r.state, 'to', p_to, 'transitioned', true);
end $$;

create or replace function api.transition_record(
  p_collection text, p_id uuid, p_to text, p_expect jsonb default null, p_set jsonb default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform zsite.require_site();
  if zsite.request_user() is null then
    raise exception 'anonymous_write_forbidden' using errcode = '42501';
  end if;
  return zsite.k_transition(p_collection, p_id, p_to, p_expect, p_set);
end $$;

create or replace function zsite.project_ctx(p_ctx jsonb, p_fields jsonb, r zsite.records) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare v_data jsonb := r.data; k text; m jsonb; v_out jsonb;
begin
  if p_fields <> '{}'::jsonb then
    for k, m in select e.key, e.value from jsonb_each(p_fields) e loop
      if m ? 'read' and v_data ? k and not zsite.ctx_match(p_ctx, m->'read', r.owner_id, r.recipient_u1) then
        v_data := v_data - k;
      end if;
    end loop;
  end if;
  v_out := jsonb_build_object(
    'id', r.id,
    'data', v_data,
    'mine', coalesce(r.owner_id is not null and r.owner_id::text = p_ctx->>'uid', false),
    'created_at', r.created_at,
    'updated_at', r.updated_at);
  if (p_ctx->>'fn') is not null then
    v_out := v_out || jsonb_build_object('owner_id', r.owner_id);
  end if;
  return v_out;
end $$;

drop function if exists api.transition_record(text, uuid, text);
drop function if exists zsite.k_transition(text, uuid, text);

grant create on schema zsite to zsite_kernel;
grant create on schema api to zsite_facade;
alter function zsite.k_transition(text, uuid, text, jsonb, jsonb) owner to zsite_kernel;
alter function api.transition_record(text, uuid, text, jsonb, jsonb) owner to zsite_facade;
revoke create on schema zsite from zsite_kernel;
revoke create on schema api from zsite_facade;

revoke all on function zsite.k_transition(text, uuid, text, jsonb, jsonb) from public;
grant execute on function zsite.k_transition(text, uuid, text, jsonb, jsonb) to zsite_facade;
revoke all on function api.transition_record(text, uuid, text, jsonb, jsonb) from public;
grant execute on function api.transition_record(text, uuid, text, jsonb, jsonb) to authenticated;

insert into zsite.migrations (version) values ('0013_transition_expect_set') on conflict do nothing;

commit;
