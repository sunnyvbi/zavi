
begin;

create or replace function account_purge_link_columns()
returns table (rel text, col text, kind text)
language sql immutable set search_path = public, pg_temp as $$
  values
    ('ads_provider_accounts'::text, 'credential_tenant_id'::text, 'owner'::text),
    ('profiles', 'active_tenant_id', 'foreign')
$$;

comment on function account_purge_link_columns() is
  'Foreign-key columns to tenants not named tenant_id, for the account purge: owner (the workspace''s own row, handled by the FK delete action) or foreign (another person''s row, left alone). An unlisted column blocks a purge that would touch it. See 20261115210000_account_purge_link_columns.sql.';
revoke all on function account_purge_link_columns() from public, anon, authenticated;

create or replace function _account_purge_tenant_refs()
returns table (rel text, col text, action text, bucket text)
language sql stable set search_path = public, pg_temp as $$
  with fk as (
    select cl.relname::text as rel, a.attname::text as col, c.confdeltype::text as action
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'public.tenants'::regclass
       and c.conparentid = 0
       and array_length(c.conkey, 1) = 1
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
  ),
  unlinked as (
    select t as rel, 'tenant_id'::text as col, null::text as action, l.bucket
      from (select unnest(account_purge_unlinked_tables()) as t, 'delete'::text as bucket
            union all
            select unnest(account_purge_keep_tables()), 'keep') l
     where to_regclass('public.' || quote_ident(l.t)) is not null
       and exists (select 1 from pg_attribute ta
                    where ta.attrelid = to_regclass('public.' || quote_ident(l.t))
                      and ta.attname = 'tenant_id' and not ta.attisdropped)
       and not exists (select 1 from fk where fk.rel = l.t and fk.col = 'tenant_id')
  )
  select fk.rel, fk.col, fk.action,
         case
           when fk.col <> 'tenant_id'
                and not coalesce(lc.kind = 'owner' or (lc.kind = 'foreign' and fk.action <> 'c'), false)
             then 'unclassified'
           when fk.rel = any (account_purge_keep_tables()) then 'keep'
           when lc.kind = 'foreign' then 'other'
           when fk.action in ('a', 'r') then 'keep'
           when fk.action = 'c' then 'delete'
           else 'clear'
         end
    from fk
    left join account_purge_link_columns() lc on lc.rel = fk.rel and lc.col = fk.col
  union all
  select rel, col, action, bucket from unlinked
  order by 1, 2
$$;

revoke all on function _account_purge_tenant_refs() from public, anon, authenticated;

create or replace function _account_purge_unclassified(p_tenants uuid[])
returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  r record;
  n bigint;
  v_out jsonb := '{}'::jsonb;
begin
  if coalesce(cardinality(p_tenants), 0) = 0 then
    return v_out;
  end if;
  for r in select * from _account_purge_tenant_refs() where bucket = 'unclassified' loop
    execute format('select count(*) from public.%I where %I = any ($1)', r.rel, r.col)
      into n using p_tenants;
    if n > 0 then
      v_out := v_out || jsonb_build_object(r.rel || '.' || r.col, n);
    end if;
  end loop;
  return v_out;
end $$;

revoke all on function _account_purge_unclassified(uuid[]) from public, anon, authenticated;

create or replace function _account_purge_refuse_unclassified(p_tenants uuid[])
returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_found jsonb;
begin
  v_found := _account_purge_unclassified(p_tenants);
  if v_found <> '{}'::jsonb then
    raise exception 'account_purge: unclassified_links (rows of the deleted workspaces sit in foreign-key columns account_purge_link_columns() does not classify; add them there first: %)', v_found;
  end if;
end $$;

revoke all on function _account_purge_refuse_unclassified(uuid[]) from public, anon, authenticated;

create or replace function _account_purge_check(p_deletion_id uuid, p_lock boolean)
returns account_deletions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d account_deletions;
  v_tenant uuid;
begin
  if p_deletion_id is null then
    raise exception 'account_purge: deletion id is required';
  end if;

  if p_lock then
    select * into d from account_deletions where id = p_deletion_id for update;
  else
    select * into d from account_deletions where id = p_deletion_id;
  end if;
  if not found then
    raise exception 'account_purge: not_found (deletion %)', p_deletion_id;
  end if;
  if d.purged_at is not null then
    return d;
  end if;

  if d.status is distinct from 'soft_deleted' then
    raise exception 'account_purge: status_% (only soft_deleted requests are purged)', d.status;
  end if;
  if d.purge_after > now() then
    raise exception 'account_purge: not_due (due %)', d.purge_after;
  end if;
  if p_lock then
    perform 1 from auth.users where id = d.user_id for update;
    perform 1 from tenants where id = any (d.deleted_tenant_ids) for update;
  end if;
  if exists (select 1 from tenant_users where user_id = d.user_id) then
    raise exception 'account_purge: user_still_member (the person is a member of a workspace again)';
  end if;

  foreach v_tenant in array d.deleted_tenant_ids loop
    if exists (select 1 from tenant_users where tenant_id = v_tenant) then
      raise exception 'account_purge: workspace_has_members (%)', v_tenant;
    end if;
    if exists (select 1 from tenants where id = v_tenant and deleted_at is null) then
      raise exception 'account_purge: workspace_not_marked (%)', v_tenant;
    end if;
    if exists (select 1 from site_providers where tenant_id = v_tenant and state <> 'deleted') then
      raise exception 'account_purge: sites_cleanup_pending (%)', v_tenant;
    end if;
  end loop;

  if p_lock then
    perform _account_purge_refuse_unclassified(d.deleted_tenant_ids);
  end if;

  return d;
end $$;

revoke all on function _account_purge_check(uuid, boolean) from public, anon, authenticated;

create or replace function account_purge_storage_objects(p_deletion_id uuid, p_limit integer default 1000)
returns table (bucket_id text, name text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d account_deletions;
begin
  d := _account_purge_check(p_deletion_id, false);
  if d.purged_at is not null then
    return;
  end if;
  perform _account_purge_refuse_unclassified(d.deleted_tenant_ids);
  return query
    select s.bucket_id, s.name
      from _account_purge_storage_targets(d.user_id, d.deleted_tenant_ids) s
     order by s.bucket_id, s.name
     limit greatest(1, least(coalesce(p_limit, 1000), 1000));
end $$;

revoke all on function account_purge_storage_objects(uuid, integer) from public, anon, authenticated;
grant execute on function account_purge_storage_objects(uuid, integer) to service_role;

create or replace function purge_account_deletion(p_deletion_id uuid, p_execute boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d account_deletions;
  v_tenants uuid[];
  v_already boolean;
  r record;
  n bigint;
  v_key text;
  v_delete jsonb := '{}'::jsonb;
  v_clear jsonb := '{}'::jsonb;
  v_kept jsonb := '{}'::jsonb;
  v_kept_after jsonb := '{}'::jsonb;
  v_other jsonb := '{}'::jsonb;
  v_unclassified jsonb := '{}'::jsonb;
  v_user_cascade jsonb := '{}'::jsonb;
  v_user_clear jsonb := '{}'::jsonb;
  v_user_block jsonb := '{}'::jsonb;
  v_storage bigint := 0;
  v_auth_present boolean;
  v_pass integer;
  v_moved bigint;
  v_blocked text[];
  v_summary jsonb;
begin
  d := _account_purge_check(p_deletion_id, p_execute);
  v_already := d.purged_at is not null;
  v_tenants := coalesce(d.deleted_tenant_ids, '{}'::uuid[]);

  if cardinality(v_tenants) > 0 then
    for r in select * from _account_purge_tenant_refs() loop
      execute format('select count(*) from public.%I where %I = any ($1)', r.rel, r.col)
        into n using v_tenants;
      if n > 0 then
        v_key := r.rel || '.' || r.col;
        if r.bucket = 'delete' then v_delete := v_delete || jsonb_build_object(v_key, n);
        elsif r.bucket = 'clear' then v_clear := v_clear || jsonb_build_object(v_key, n);
        elsif r.bucket = 'keep' then v_kept := v_kept || jsonb_build_object(v_key, n);
        elsif r.bucket = 'unclassified' then v_unclassified := v_unclassified || jsonb_build_object(v_key, n);
        else v_other := v_other || jsonb_build_object(v_key, n);
        end if;
      end if;
    end loop;
  end if;
  select count(*) into v_storage from _account_purge_storage_targets(d.user_id, v_tenants);

  v_auth_present := exists (select 1 from auth.users where id = d.user_id);
  for r in
    select cl.relname::text as rel, a.attname::text as col, c.confdeltype::text as action,
           exists (select 1 from pg_attribute ta
                    where ta.attrelid = c.conrelid and ta.attname = 'tenant_id'
                      and not ta.attisdropped) as has_tenant,
           exists (select 1 from _account_purge_tenant_refs() t
                    where t.rel = cl.relname::text and t.col = 'tenant_id'
                      and t.bucket = 'delete') as goes_with_workspace
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
       and c.conparentid = 0
       and array_length(c.conkey, 1) = 1
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
     order by 1, 2
  loop
    v_key := r.rel || '.' || r.col;
    if r.has_tenant then
      execute format(
        'select count(*) from public.%I where %I = $1 and tenant_id is not null and not (tenant_id = any ($2))',
        r.rel, r.col) into n using d.user_id, v_tenants;
      if n > 0 then v_user_block := v_user_block || jsonb_build_object(v_key || ' (other workspaces)', n); end if;
      if r.action in ('a', 'r') and r.goes_with_workspace then
        execute format('select count(*) from public.%I where %I = $1 and tenant_id is null', r.rel, r.col)
          into n using d.user_id;
      else
        execute format(
          'select count(*) from public.%I where %I = $1 and (tenant_id is null or tenant_id = any ($2))',
          r.rel, r.col) into n using d.user_id, v_tenants;
      end if;
    else
      execute format('select count(*) from public.%I where %I = $1', r.rel, r.col)
        into n using d.user_id;
    end if;
    if n > 0 then
      if r.action = 'c' then v_user_cascade := v_user_cascade || jsonb_build_object(v_key, n);
      elsif r.action in ('n', 'd') then v_user_clear := v_user_clear || jsonb_build_object(v_key, n);
      else v_user_block := v_user_block || jsonb_build_object(v_key, n);
      end if;
    end if;
  end loop;

  v_summary := jsonb_build_object(
    'deletion_id', d.id,
    'workspaces', cardinality(v_tenants),
    'delete', v_delete,
    'clear', v_clear,
    'keep', v_kept,
    'other_links', v_other,
    'unclassified_links', v_unclassified,
    'storage_objects', v_storage,
    'batched_agent_runs', coalesce((d.purge_summary->>'batched_agent_runs')::integer, 0),
    'planned_delete', d.purge_summary->'planned_delete',
    'auth_user', jsonb_build_object(
      'present', v_auth_present,
      'cascade', v_user_cascade,
      'clear', v_user_clear,
      'blockers', v_user_block
    )
  );

  if v_already then
    return v_summary || jsonb_build_object('status', 'already_purged', 'purged_at', d.purged_at);
  end if;
  if not p_execute then
    return v_summary || jsonb_build_object('status', 'dry_run');
  end if;

  if v_unclassified <> '{}'::jsonb then
    raise exception 'account_purge: unclassified_links (rows of the deleted workspaces sit in foreign-key columns account_purge_link_columns() does not classify; add them there first: %)', v_unclassified;
  end if;
  if v_user_block <> '{}'::jsonb then
    raise exception 'account_purge: user_rows_outside (rows outside the deleted workspaces still point at the person: %)', v_user_block;
  end if;
  if v_storage > 0 then
    raise exception 'account_purge: storage_not_empty (% objects of this person or workspace; remove them through the Storage API first)', v_storage;
  end if;

  if cardinality(v_tenants) > 0 then
    delete from vault.secrets vs
     where (vs.id in (
             select s.vault_secret_id from secrets s where s.tenant_id = any (v_tenants)
             union all
             select s.vault_secret_id from site_function_secrets s where s.tenant_id = any (v_tenants)
             union all
             select s.vault_secret_id from site_function_retired_secrets s where s.tenant_id = any (v_tenants)
             union all
             select s.turnstile_secret_id from site_backend_settings s where s.tenant_id = any (v_tenants)
           )
        or vs.name in (select b.vault_secret_name from tenant_buffer_connection b where b.tenant_id = any (v_tenants)))
       and not exists (select 1 from secrets s
                        where s.vault_secret_id = vs.id and not coalesce(s.tenant_id = any (v_tenants), false))
       and not exists (select 1 from site_function_secrets s
                        where s.vault_secret_id = vs.id and not coalesce(s.tenant_id = any (v_tenants), false))
       and not exists (select 1 from site_function_retired_secrets s
                        where s.vault_secret_id = vs.id and not coalesce(s.tenant_id = any (v_tenants), false))
       and not exists (select 1 from site_backend_settings s
                        where s.turnstile_secret_id = vs.id and not coalesce(s.tenant_id = any (v_tenants), false))
       and not exists (select 1 from tenant_buffer_connection b
                        where b.vault_secret_name = vs.name and not coalesce(b.tenant_id = any (v_tenants), false))
       and not exists (select 1 from platform_secrets p where p.vault_secret_id = vs.id)
       and not exists (select 1 from site_shard_secrets p where p.vault_secret_id = vs.id);

    for v_pass in 1..12 loop
      v_moved := 0;
      v_blocked := '{}';
      for r in select * from _account_purge_tenant_refs() where bucket = 'delete' loop
        begin
          execute format('delete from public.%I where %I = any ($1)', r.rel, r.col) using v_tenants;
          get diagnostics n = row_count;
          v_moved := v_moved + n;
        exception when foreign_key_violation then
          v_blocked := v_blocked || (r.rel || '.' || r.col);
        end;
      end loop;
      for r in select * from _account_purge_tenant_refs() where bucket = 'clear' loop
        if r.action = 'd' then
          execute format('update public.%I set %I = default where %I = any ($1)', r.rel, r.col, r.col) using v_tenants;
        else
          execute format('update public.%I set %I = null where %I = any ($1)', r.rel, r.col, r.col) using v_tenants;
        end if;
        get diagnostics n = row_count;
        v_moved := v_moved + n;
      end loop;
      exit when v_moved = 0 and cardinality(v_blocked) = 0;
      if v_moved = 0 then
        raise exception 'account_purge: blocked (rows in % are still referenced by kept or foreign rows)', array_to_string(v_blocked, ', ');
      end if;
      if v_pass = 12 then
        raise exception 'account_purge: did_not_converge (still deleting after 12 passes; last blocked: %)', array_to_string(v_blocked, ', ');
      end if;
    end loop;

    update tenants
       set display_name = 'Deleted workspace',
           slug = 'deleted-' || id::text,
           notification_phone = null,
           sms_enabled = false,
           product_url = null,
           settings = '{}'::jsonb,
           show_in_public_feed = false
     where id = any (v_tenants);
  end if;

  v_user_block := '{}'::jsonb;
  for r in
    select cl.relname::text as rel, a.attname::text as col
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
       and c.conparentid = 0
       and array_length(c.conkey, 1) = 1
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute ta
                    where ta.attrelid = c.conrelid and ta.attname = 'tenant_id' and not ta.attisdropped)
     order by 1, 2
  loop
    execute format('select 1 from public.%I where %I = $1 for update', r.rel, r.col) using d.user_id;
    execute format(
      'select count(*) from public.%I where %I = $1 and tenant_id is not null and not (tenant_id = any ($2))',
      r.rel, r.col) into n using d.user_id, v_tenants;
    if n > 0 then v_user_block := v_user_block || jsonb_build_object(r.rel || '.' || r.col || ' (other workspaces)', n); end if;
  end loop;
  if v_user_block <> '{}'::jsonb then
    raise exception 'account_purge: user_rows_outside (rows outside the deleted workspaces still point at the person: %)', v_user_block;
  end if;

  delete from auth.users where id = d.user_id;

  v_kept_after := _account_purge_kept_counts(v_tenants);
  if v_kept_after is distinct from v_kept then
    raise exception 'account_purge: kept_rows_changed (before %, after %)', v_kept, v_kept_after;
  end if;

  v_summary := v_summary || jsonb_build_object('status', 'purged');

  update account_deletions
     set purged_at = now(),
         status = 'purged',
         purge_summary = v_summary,
         purge_last_error = null,
         purge_attempts = purge_attempts + 1,
         purge_last_attempt_at = now()
   where id = d.id;

  return v_summary || jsonb_build_object('purged_at', now());
end $$;

comment on function purge_account_deletion(uuid, boolean) is
  'The 30-day purge of one account_deletions request (p_execute=false is a dry run). Deletes the deleted workspaces'' rows and the auth user, keeps billing records and audit logs, stamps purged_at + purge_summary. Raises (changing nothing) when the request is not due or not safe, including while a row of the workspaces sits in a foreign-key column account_purge_link_columns() does not classify. See 20261115200000_account_deletion_purge.sql and 20261115210000_account_purge_link_columns.sql.';

revoke all on function purge_account_deletion(uuid, boolean) from public, anon, authenticated;
grant execute on function purge_account_deletion(uuid, boolean) to service_role;

commit;
