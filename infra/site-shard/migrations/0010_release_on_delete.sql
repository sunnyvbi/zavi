
begin;

create index if not exists action_receipts_record_idx
  on zsite.action_receipts (site_id, (result->>'record_id')) where result is not null;

create table if not exists zsite.platform_delete_tx (
  txid bigint primary key,
  site_id uuid not null
);
alter table zsite.platform_delete_tx enable row level security;
revoke all on zsite.platform_delete_tx from public, anon, authenticated, zsite_facade;
grant select, insert, delete on zsite.platform_delete_tx to zsite_kernel;
drop policy if exists platform_delete_tx_kernel on zsite.platform_delete_tx;
create policy platform_delete_tx_kernel on zsite.platform_delete_tx for all to zsite_kernel
  using (txid = txid_current()) with check (txid = txid_current());

create or replace function zsite.release_work(p_site uuid, p_collection text, p_id uuid) returns void
language plpgsql volatile security invoker set search_path = '' as $$
declare
  k text; a jsonb; rc zsite.action_receipts; t zsite.records;
  v_cf text; v_tid uuid; v_cur numeric; v_new numeric; v_max numeric;
begin
  for k, a in select e.key, e.value from zsite.site_contracts sc, jsonb_each(sc.actions) e
              where sc.site_id = p_site and sc.schema_version = 2
                and e.value->'creates'->>'collection' = p_collection loop
    select * into rc from zsite.action_receipts x
    where x.site_id = p_site and x.action = k and x.result->>'record_id' = p_id::text
    for update;
    continue when not found or coalesce((rc.result->>'released')::boolean, false);
    v_tid := (rc.result->>'target_id')::uuid;
    select * into t from zsite.records x
    where x.site_id = p_site and x.collection = a->'target'->>'collection' and x.id = v_tid
    for update;
    if found then
      v_cf := a->'target'->>'counter';
      v_cur := case when jsonb_typeof(t.data->v_cf) = 'number' then (t.data->>v_cf)::numeric
                    else (a->>'initial')::numeric end;
      v_new := v_cur + coalesce((a->'inverse'->>'delta')::numeric, -(a->>'delta')::numeric);
      v_max := case when a->'bounds' ? 'max' then (a->'bounds'->>'max')::numeric
                    when jsonb_typeof(t.data->(a->'bounds'->>'maxField')) = 'number'
                    then (t.data->>(a->'bounds'->>'maxField'))::numeric end;
      if v_new < (a->'bounds'->>'min')::numeric or (v_max is not null and v_new > v_max) then
        raise exception 'action_bound' using errcode = '55000';
      end if;
      update zsite.records x set data = jsonb_set(x.data, array[v_cf], to_jsonb(v_new))
      where x.site_id = p_site and x.collection = t.collection and x.id = v_tid;
    end if;
    update zsite.action_receipts x set result = x.result || '{"released":true}'::jsonb
    where x.site_id = p_site and x.action = k and x.key = rc.key;
  end loop;
end $$;

create or replace function zsite.k_release_deleted(p_collection text, p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_site uuid := zsite.require_site();
begin
  if pg_trigger_depth() = 0 then
    raise exception 'not_in_trigger' using errcode = '42501';
  end if;
  if exists (select 1 from zsite.records r
             where r.site_id = v_site and r.collection = p_collection and r.id = p_id) then
    raise exception 'not_deleted' using errcode = '42501';
  end if;
  perform zsite.release_work(v_site, p_collection, p_id);
end $$;

create or replace function zsite.tg_records_release() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_kernel boolean := current_user = 'zsite_kernel';
  v_platform boolean := current_user <> 'zsite_kernel'
                        and pg_catalog.current_setting('role', true) is distinct from 'anon'
                        and pg_catalog.current_setting('role', true) is distinct from 'authenticated';
begin
  if not exists (select 1 from zsite.site_contracts sc, jsonb_each(sc.actions) e
                 where sc.site_id = OLD.site_id and sc.schema_version = 2
                   and e.value->'creates'->>'collection' = OLD.collection) then
    return null;
  end if;
  if v_platform or (v_kernel and exists (select 1 from zsite.platform_delete_tx p where p.txid = txid_current())) then
    perform zsite.release_work(OLD.site_id, OLD.collection, OLD.id);
  else
    perform zsite.k_release_deleted(OLD.collection, OLD.id);
  end if;
  return null;
end $$;
drop trigger if exists records_a_release on zsite.records;
create trigger records_a_release after delete on zsite.records
  for each row execute function zsite.tg_records_release();

create or replace function zsite.tg_records_after_delete() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_kernel boolean := current_user = 'zsite_kernel';
  v_platform boolean := current_user <> 'zsite_kernel'
                        and pg_catalog.current_setting('role', true) is distinct from 'anon'
                        and pg_catalog.current_setting('role', true) is distinct from 'authenticated';
  v_pdel boolean := false;
begin
  if v_kernel then
    v_pdel := exists (select 1 from zsite.platform_delete_tx p where p.txid = txid_current());
  end if;
  if not exists (select 1 from zsite.collections c, jsonb_each(c."references") e
                 where c.site_id = OLD.site_id and e.value->>'collection' = OLD.collection) then
    return null;
  end if;
  if v_platform or v_pdel then
    perform zsite.ref_delete_work(OLD.site_id, OLD.collection, OLD.id, true);
  else
    perform zsite.k_ref_delete(OLD.collection, OLD.id);
  end if;
  return null;
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
  v_fwd text; v_frc zsite.action_receipts;
begin
  select sc.actions into v_actions from zsite.site_contracts sc
  where sc.site_id = v_site and sc.schema_version = 2;
  if v_actions is not null and v_actions ? p_action then
    a := v_actions->p_action;
    v_princ := a->'principals';
  elsif v_actions is not null then
    select e.key, e.value into v_fwd, a from jsonb_each(v_actions) e where e.value->'inverse'->>'name' = p_action;
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
    select * into v_frc from zsite.action_receipts x
    where x.site_id = v_site and x.action = v_fwd and x.result->>'record_id' = p_record_id::text
    for update;
    if found and coalesce((v_frc.result->>'released')::boolean, false) then
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
    update zsite.action_receipts x set result = x.result || '{"released":true}'::jsonb
     where x.site_id = v_site and x.action = v_fwd and x.result->>'record_id' = p_record_id::text;
  end if;

  v_result := jsonb_build_object('action', p_action, 'target_id', v_tid, 'record_id', v_rid,
                                 'counter', v_new);
  update zsite.action_receipts x set result = v_result
  where x.site_id = v_site and x.action = p_action and x.key = p_idempotency_key;
  return v_result || jsonb_build_object('replayed', false);
end $$;

create or replace function zsite.k_platform_delete_record(p_site uuid, p_collection text, p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('request.jwt.claims', true); n integer;
begin
  if p_site is null or p_collection is null or p_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('request.jwt.claims',
                                jsonb_build_object('role', 'anon', 'site_id', p_site)::text, true);
  if zsite.request_site() is distinct from p_site then
    raise exception 'no_site' using errcode = '42501';
  end if;
  insert into zsite.platform_delete_tx (txid, site_id) values (txid_current(), p_site)
  on conflict (txid) do nothing;
  delete from zsite.records r where r.site_id = p_site and r.collection = p_collection and r.id = p_id;
  get diagnostics n = row_count;
  delete from zsite.platform_delete_tx p where p.txid = txid_current();
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  if n <> 1 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', p_id, 'deleted', true);
end $$;

grant create on schema zsite to zsite_kernel;
alter function zsite.k_run_action(text, uuid, uuid, jsonb, text) owner to zsite_kernel;
alter function zsite.k_release_deleted(text, uuid) owner to zsite_kernel;
alter function zsite.k_platform_delete_record(uuid, text, uuid) owner to zsite_kernel;
revoke create on schema zsite from zsite_kernel;
revoke execute on function zsite.tg_records_release() from public, anon, authenticated, service_role;
revoke all on function zsite.release_work(uuid, text, uuid), zsite.k_release_deleted(text, uuid),
  zsite.k_platform_delete_record(uuid, text, uuid) from public;
grant execute on function zsite.release_work(uuid, text, uuid) to service_role, zsite_kernel;
grant execute on function zsite.k_release_deleted(text, uuid) to zsite_facade, zsite_kernel;
grant execute on function zsite.k_platform_delete_record(uuid, text, uuid) to service_role;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zsite_broker') then
    create role zsite_broker nologin noinherit;
  end if;
end $$;
grant usage on schema zsite to zsite_broker;
grant execute on function zsite.k_platform_delete_record(uuid, text, uuid) to zsite_broker;
revoke execute on function zsite.k_platform_delete_record(uuid, text, uuid)
  from anon, authenticated, zsite_facade;

insert into zsite.migrations (version) values ('0010_release_on_delete') on conflict do nothing;

commit;
