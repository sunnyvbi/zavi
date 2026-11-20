
begin;

create schema if not exists zsite_auth;

create table if not exists zsite_auth.member_admin (
  site_id    uuid primary key,
  updated_at timestamptz not null default now()
);

create table if not exists zsite_auth.member_audit (
  id         bigint generated always as identity primary key,
  site_id    uuid not null,
  actor_id   uuid,
  action     text not null check (action in (
               'invite', 'invite_activated', 'list', 'set_role', 'disable', 'enable', 'remove',
               'reassign', 'delete_data', 'self_delete', 'bootstrap_admin')),
  target_id  uuid,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists member_audit_site on zsite_auth.member_audit (site_id, id desc);

create table if not exists zsite_auth.session_epochs (
  site_id     uuid not null,
  user_id     uuid not null,
  valid_after timestamptz not null,
  primary key (site_id, user_id)
);

alter table zsite_auth.member_admin   enable row level security;
alter table zsite_auth.member_audit   enable row level security;
alter table zsite_auth.session_epochs enable row level security;
revoke all on zsite_auth.member_admin, zsite_auth.member_audit, zsite_auth.session_epochs
  from public, anon, authenticated, service_role, zsite_broker;

create or replace function zsite_auth.member_audit_guard() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_catalog.current_setting('zsite_auth.audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_append_only' using errcode = '55000';
end $$;
drop trigger if exists member_audit_no_update on zsite_auth.member_audit;
create trigger member_audit_no_update before update or delete on zsite_auth.member_audit
  for each row execute function zsite_auth.member_audit_guard();
drop trigger if exists member_audit_no_truncate on zsite_auth.member_audit;
create trigger member_audit_no_truncate before truncate on zsite_auth.member_audit
  for each statement execute function zsite_auth.member_audit_guard();

create or replace function zsite_auth.email_sha(p text) returns text
language sql immutable security invoker set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p, 'UTF8')), 'hex')
$$;

create or replace function zsite_auth.audit(p_site uuid, p_actor uuid, p_action text, p_target uuid, p_detail jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into zsite_auth.member_audit (site_id, actor_id, action, target_id, detail)
  values (p_site, p_actor, p_action, p_target, coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function zsite_auth.bump_sessions(p_site uuid, p_uid uuid) returns void
language sql security invoker set search_path = '' as $$
  insert into zsite_auth.session_epochs as e (site_id, user_id, valid_after)
  values (p_site, p_uid, pg_catalog.clock_timestamp())
  on conflict (site_id, user_id) do update
    set valid_after = greatest(e.valid_after, excluded.valid_after)
$$;

create or replace function zsite_auth.is_active_admin(p_site uuid, p_uid uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from zsite.members m
      join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
      join zsite.sites s      on s.site_id = m.site_id
     where m.site_id = p_site and m.user_id = p_uid
       and m.role = 'admin' and m.status = 'active'
       and i.state in ('active', 'email_change_pending')
       and s.status = 'active')
$$;

create or replace function zsite_auth.active_admin_count(p_site uuid) returns bigint
language sql stable security invoker set search_path = '' as $$
  select count(*) from zsite.members m
    join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
   where m.site_id = p_site and m.role = 'admin' and m.status = 'active'
     and i.state in ('active', 'email_change_pending')
$$;

create or replace function zsite_auth.member_lock(p_site uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  insert into zsite_auth.member_admin (site_id) values (p_site) on conflict (site_id) do nothing;
  perform 1 from zsite_auth.member_admin a where a.site_id = p_site for update;
end $$;

create or replace function zsite_auth.member_guard(p_site uuid, p_actor uuid, p_lock boolean default true)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_site is null or p_actor is null then
    raise exception 'member_admin_required' using errcode = '42501';
  end if;
  if p_lock then perform zsite_auth.member_lock(p_site); end if;
  if not zsite_auth.is_active_admin(p_site, p_actor) then
    raise exception 'member_admin_required' using errcode = '42501';
  end if;
end $$;

create or replace function zsite_auth.assert_role(p_site uuid, p_role text) returns void
language plpgsql stable security invoker set search_path = '' as $$
declare v_roles jsonb := '[]'::jsonb;
begin
  if p_role is null or p_role !~ '^[a-z][a-z0-9_]{0,31}$' then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_role in ('admin', 'user') then return; end if;
  begin
    execute 'select case when c.schema_version = 2 then coalesce(pg_catalog.to_jsonb(c.roles), ''[]''::jsonb) else ''[]''::jsonb end
               from zsite.site_contracts c where c.site_id = $1'
      into v_roles using p_site;
  exception when undefined_table or undefined_column then
    v_roles := '[]'::jsonb;
  end;
  if v_roles is null or pg_catalog.jsonb_typeof(v_roles) <> 'array' or not (v_roles ? p_role) then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
end $$;

create or replace function zsite_auth.assert_not_last_admin(p_site uuid, p_uid uuid) returns void
language plpgsql stable security invoker set search_path = '' as $$
begin
  if zsite_auth.is_active_admin(p_site, p_uid) and zsite_auth.active_admin_count(p_site) <= 1 then
    raise exception 'last_admin' using errcode = '55000';
  end if;
end $$;

create or replace function zsite_auth.member_invite_reserve(
  p_site uuid, p_actor uuid, p_email text, p_alias text, p_uid uuid, p_role text,
  out outcome text, out auth_user_id uuid
) language plpgsql security definer set search_path = '' as $$
declare v_state text; v_uid uuid; v_signup record;
begin
  perform zsite_auth.assert_email(p_email);
  perform zsite_auth.member_guard(p_site, p_actor);
  perform zsite_auth.assert_role(p_site, p_role);
  if p_uid is null or p_alias is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  select i.state, i.auth_user_id into v_state, v_uid
    from zsite.identities i where i.site_id = p_site and i.email_norm = p_email for update;
  if found then
    if v_state = 'unverified' and v_uid is not null then
      update zsite.members m set role = p_role, status = 'active' where m.site_id = p_site and m.user_id = v_uid;
      outcome := 'create'; auth_user_id := v_uid;
    elsif v_state in ('active', 'email_change_pending') and v_uid is not null
          and not exists (select 1 from zsite.members m where m.site_id = p_site and m.user_id = v_uid) then
      insert into zsite.members (site_id, user_id, role, status) values (p_site, v_uid, p_role, 'active');
      outcome := 'exists'; auth_user_id := v_uid;
    else
      outcome := 'exists'; auth_user_id := v_uid;
    end if;
  elsif exists (select 1 from zsite_auth.email_changes c
                 where c.site_id = p_site and c.new_email_norm = p_email and c.state in ('pending', 'committing')) then
    outcome := 'held';
  else
    select s.auth_user_id, s.state, s.lease_until into v_signup
      from zsite_auth.signups s where s.site_id = p_site and s.email_norm = p_email for update;
    if found and v_signup.state = 'creating' and v_signup.lease_until > pg_catalog.now() then
      outcome := 'held';
    else
      v_uid := coalesce(v_signup.auth_user_id, p_uid);
      delete from zsite_auth.signups s where s.site_id = p_site and s.email_norm = p_email;
      insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state)
      values (p_site, p_email, v_uid, lower(p_alias), 'unverified');
      insert into zsite.members (site_id, user_id, role, status) values (p_site, v_uid, p_role, 'active');
      outcome := 'create'; auth_user_id := v_uid;
    end if;
  end if;
  perform zsite_auth.audit(p_site, p_actor, 'invite', case when outcome = 'held' then null else auth_user_id end,
    jsonb_build_object('email_sha256', zsite_auth.email_sha(p_email), 'role', p_role, 'outcome', outcome));
end $$;

create or replace function zsite_auth.member_invite_finish(p_site uuid, p_actor uuid, p_uid uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  update zsite.identities i set state = 'active', updated_at = pg_catalog.now()
   where i.site_id = p_site and i.auth_user_id = p_uid and i.state = 'unverified';
  if found then
    perform zsite_auth.audit(p_site, p_actor, 'invite_activated', p_uid, '{}'::jsonb);
  end if;
  return exists (select 1 from zsite.identities i
                  where i.site_id = p_site and i.auth_user_id = p_uid and i.state in ('active', 'email_change_pending'));
end $$;

create or replace function zsite_auth.member_list(p_site uuid, p_actor uuid, p_cursor uuid, p_limit integer)
returns table (user_id uuid, email text, role text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform zsite_auth.member_guard(p_site, p_actor, false);
  perform zsite_auth.audit(p_site, p_actor, 'list', null, '{}'::jsonb);
  return query
    select m.user_id, i.email_norm, m.role,
           case when i.state = 'unverified' then 'invited' else m.status end,
           m.created_at
      from zsite.members m
      join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
     where m.site_id = p_site and i.state <> 'deleting'
       and (p_cursor is null or m.user_id > p_cursor)
     order by m.user_id
     limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

create or replace function zsite_auth.member_row(p_site uuid, p_uid uuid)
returns table (user_id uuid, email text, role text, status text, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.user_id, i.email_norm, m.role,
         case when i.state = 'unverified' then 'invited' else m.status end, m.created_at
    from zsite.members m
    join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
   where m.site_id = p_site and m.user_id = p_uid
$$;

create or replace function zsite_auth.member_target(p_site uuid, p_uid uuid, out role text, out status text, out state text)
language plpgsql security invoker set search_path = '' as $$
begin
  select m.role, m.status, i.state into role, status, state
    from zsite.members m
    join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
   where m.site_id = p_site and m.user_id = p_uid
   for update of m;
  if not found or state = 'deleting' then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
end $$;

create or replace function zsite_auth.member_set_role(p_site uuid, p_actor uuid, p_uid uuid, p_role text)
returns table (user_id uuid, email text, role text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  perform zsite_auth.assert_role(p_site, p_role);
  select * into t from zsite_auth.member_target(p_site, p_uid);
  if t.role is distinct from p_role then
    if t.role = 'admin' then perform zsite_auth.assert_not_last_admin(p_site, p_uid); end if;
    update zsite.members m set role = p_role where m.site_id = p_site and m.user_id = p_uid;
    perform zsite_auth.bump_sessions(p_site, p_uid);
    perform zsite_auth.audit(p_site, p_actor, 'set_role', p_uid, jsonb_build_object('from', t.role, 'to', p_role));
  end if;
  return query select * from zsite_auth.member_row(p_site, p_uid);
end $$;

create or replace function zsite_auth.member_disable(p_site uuid, p_actor uuid, p_uid uuid)
returns table (user_id uuid, email text, role text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  select * into t from zsite_auth.member_target(p_site, p_uid);
  if t.status <> 'disabled' then
    perform zsite_auth.assert_not_last_admin(p_site, p_uid);
    update zsite.members m set status = 'disabled' where m.site_id = p_site and m.user_id = p_uid;
    perform zsite_auth.bump_sessions(p_site, p_uid);
    perform zsite_auth.audit(p_site, p_actor, 'disable', p_uid, jsonb_build_object('role', t.role));
  end if;
  return query select * from zsite_auth.member_row(p_site, p_uid);
end $$;

create or replace function zsite_auth.member_enable(p_site uuid, p_actor uuid, p_uid uuid)
returns table (user_id uuid, email text, role text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  select * into t from zsite_auth.member_target(p_site, p_uid);
  if t.status <> 'active' then
    update zsite.members m set status = 'active' where m.site_id = p_site and m.user_id = p_uid;
    perform zsite_auth.audit(p_site, p_actor, 'enable', p_uid, jsonb_build_object('role', t.role));
  end if;
  return query select * from zsite_auth.member_row(p_site, p_uid);
end $$;

create or replace function zsite_auth.member_remove_begin(p_site uuid, p_actor uuid, p_uid uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare t record;
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  if exists (select 1 from zsite.identities i where i.site_id = p_site and i.auth_user_id = p_uid and i.state <> 'deleting')
     and not exists (select 1 from zsite.members m where m.site_id = p_site and m.user_id = p_uid) then
    return true;
  end if;
  select * into t from zsite_auth.member_target(p_site, p_uid);
  perform zsite_auth.assert_not_last_admin(p_site, p_uid);
  delete from zsite.members m where m.site_id = p_site and m.user_id = p_uid;
  perform zsite_auth.bump_sessions(p_site, p_uid);
  perform zsite_auth.audit(p_site, p_actor, 'remove', p_uid, jsonb_build_object('role', t.role));
  return true;
end $$;

create or replace function zsite_auth.member_reassign_record(
  p_site uuid, p_actor uuid, p_collection text, p_record uuid, p_to uuid,
  out id uuid, out owner_id uuid
) language plpgsql security definer set search_path = '' as $$
declare v_from uuid;
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  if not exists (select 1 from zsite.members m
                   join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
                  where m.site_id = p_site and m.user_id = p_to and m.status = 'active'
                    and i.state in ('active', 'email_change_pending')) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  select r.owner_id into v_from from zsite.records r
   where r.site_id = p_site and r.collection = p_collection and r.id = p_record for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_from is distinct from p_to then
    update zsite.records r
       set owner_id = p_to,
           idempotency_hash = case when r.idempotency_key is not null
                                   then zsite.idem_hash(p_to, r.collection, r.data) end
     where r.site_id = p_site and r.collection = p_collection and r.id = p_record;
    perform zsite_auth.audit(p_site, p_actor, 'reassign', v_from,
      jsonb_build_object('to', p_to, 'collection', p_collection, 'record_id', p_record));
  end if;
  id := p_record; owner_id := p_to;
end $$;

create or replace function zsite_auth.member_delete_data_begin(p_site uuid, p_actor uuid, p_uid uuid, p_confirm boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform zsite_auth.member_guard(p_site, p_actor);
  if p_confirm is distinct from true then
    raise exception 'confirmation_required' using errcode = '22023';
  end if;
  if exists (select 1 from zsite_auth.deletions d where d.auth_user_id = p_uid and d.site_id = p_site) then
    return true;
  end if;
  if not exists (select 1 from zsite.identities i
                  where i.site_id = p_site and i.auth_user_id = p_uid and i.state <> 'deleting') then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  perform zsite_auth.assert_not_last_admin(p_site, p_uid);
  update zsite.identities i set state = 'deleting', updated_at = pg_catalog.now()
   where i.site_id = p_site and i.auth_user_id = p_uid;
  update zsite.members m set status = 'disabled' where m.site_id = p_site and m.user_id = p_uid;
  update zsite_auth.email_changes c set state = 'cancelled', updated_at = pg_catalog.now()
   where c.auth_user_id = p_uid and c.state in ('pending', 'committing');
  insert into zsite_auth.deletions (auth_user_id, site_id) values (p_uid, p_site)
  on conflict (auth_user_id) do nothing;
  perform zsite_auth.bump_sessions(p_site, p_uid);
  perform zsite_auth.audit(p_site, p_actor, 'delete_data', p_uid, '{}'::jsonb);
  return true;
end $$;

create or replace function zsite_auth.begin_deletion(p_site uuid, p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform zsite_auth.member_lock(p_site);
  if not exists (select 1 from zsite.identities i where i.site_id = p_site and i.auth_user_id = p_uid) then
    return exists (select 1 from zsite_auth.deletions d where d.auth_user_id = p_uid and d.site_id = p_site);
  end if;
  perform zsite_auth.assert_not_last_admin(p_site, p_uid);
  update zsite.identities i set state = 'deleting', updated_at = pg_catalog.now()
   where i.site_id = p_site and i.auth_user_id = p_uid and i.state <> 'deleting';
  if found then
    perform zsite_auth.audit(p_site, p_uid, 'self_delete', p_uid, '{}'::jsonb);
  end if;
  update zsite.members m set status = 'disabled' where m.site_id = p_site and m.user_id = p_uid;
  update zsite_auth.email_changes c set state = 'cancelled', updated_at = pg_catalog.now()
   where c.auth_user_id = p_uid and c.state in ('pending', 'committing');
  insert into zsite_auth.deletions (auth_user_id, site_id) values (p_uid, p_site)
  on conflict (auth_user_id) do nothing;
  perform zsite_auth.bump_sessions(p_site, p_uid);
  return true;
end $$;

create or replace function zsite_auth.delete_account_data(p_site uuid, p_uid uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; r record; v_actions jsonb := '[]'::jsonb;
begin
  perform 1 from zsite_auth.deletions d where d.auth_user_id = p_uid and d.site_id = p_site;
  if not found then
    raise exception 'deletion_not_started' using errcode = '55000';
  end if;
  if pg_catalog.to_regprocedure('zsite.k_platform_delete_record(uuid,text,uuid)') is not null then
    for r in select x.collection, x.id from zsite.records x
              where x.site_id = p_site and x.owner_id = p_uid order by x.created_at, x.id loop
      if exists (select 1 from zsite.records x where x.site_id = p_site and x.collection = r.collection and x.id = r.id) then
        execute 'select zsite.k_platform_delete_record($1, $2, $3)' using p_site, r.collection, r.id;
        n := n + 1;
      end if;
    end loop;
  else
    begin
      execute 'select case when c.schema_version = 2 then coalesce(pg_catalog.to_jsonb(c.actions), ''[]''::jsonb) else ''[]''::jsonb end
                 from zsite.site_contracts c where c.site_id = $1' into v_actions using p_site;
    exception when undefined_table or undefined_column then
      v_actions := '[]'::jsonb;
    end;
    if v_actions is not null and v_actions not in ('[]'::jsonb, '{}'::jsonb) then
      raise exception 'kernel_delete_unavailable' using errcode = '55000';
    end if;
    delete from zsite.records x where x.site_id = p_site and x.owner_id = p_uid;
    get diagnostics n = row_count;
  end if;
  delete from zsite.identities i where i.site_id = p_site and i.auth_user_id = p_uid;
  return n;
end $$;

create or replace function zsite_auth.bootstrap_admin(p_site uuid, p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform zsite_auth.member_lock(p_site);
  if not exists (select 1 from zsite.identities i
                  where i.site_id = p_site and i.auth_user_id = p_uid
                    and i.state in ('unverified', 'active', 'email_change_pending')) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if zsite_auth.is_active_admin(p_site, p_uid) then return true; end if;
  if zsite_auth.active_admin_count(p_site) > 0 then
    raise exception 'admin_exists' using errcode = '55000';
  end if;
  update zsite.identities i set state = 'active', updated_at = pg_catalog.now()
   where i.site_id = p_site and i.auth_user_id = p_uid and i.state = 'unverified';
  update zsite.members m set role = 'admin', status = 'active' where m.site_id = p_site and m.user_id = p_uid;
  perform zsite_auth.audit(p_site, null, 'bootstrap_admin', p_uid, '{}'::jsonb);
  return true;
end $$;

create or replace function zsite_auth.revoke_sessions(p_site uuid, p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from zsite.identities i where i.site_id = p_site and i.auth_user_id = p_uid) then
    return false;
  end if;
  perform zsite_auth.bump_sessions(p_site, p_uid);
  return true;
end $$;

drop function if exists zsite_auth.set_member_role(uuid, uuid, text);
drop function if exists zsite_auth.member_reassign_records(uuid, uuid, uuid, uuid, text, integer);

revoke all on all functions in schema zsite_auth from public, anon, authenticated, service_role;
grant execute on function
  zsite_auth.member_invite_reserve(uuid, uuid, text, text, uuid, text),
  zsite_auth.member_invite_finish(uuid, uuid, uuid),
  zsite_auth.member_list(uuid, uuid, uuid, integer),
  zsite_auth.member_set_role(uuid, uuid, uuid, text),
  zsite_auth.member_disable(uuid, uuid, uuid),
  zsite_auth.member_remove_begin(uuid, uuid, uuid),
  zsite_auth.member_enable(uuid, uuid, uuid),
  zsite_auth.member_reassign_record(uuid, uuid, text, uuid, uuid),
  zsite_auth.member_delete_data_begin(uuid, uuid, uuid, boolean),
  zsite_auth.begin_deletion(uuid, uuid),
  zsite_auth.delete_account_data(uuid, uuid),
  zsite_auth.bootstrap_admin(uuid, uuid),
  zsite_auth.revoke_sessions(uuid, uuid)
  to zsite_broker;
revoke execute on function
  zsite_auth.email_sha(text), zsite_auth.audit(uuid, uuid, text, uuid, jsonb),
  zsite_auth.bump_sessions(uuid, uuid), zsite_auth.is_active_admin(uuid, uuid),
  zsite_auth.active_admin_count(uuid), zsite_auth.member_lock(uuid),
  zsite_auth.member_guard(uuid, uuid, boolean), zsite_auth.assert_role(uuid, text),
  zsite_auth.assert_not_last_admin(uuid, uuid), zsite_auth.member_row(uuid, uuid),
  zsite_auth.member_target(uuid, uuid), zsite_auth.member_audit_guard()
  from zsite_broker;
grant execute on function zsite_auth.custom_access_token_hook(jsonb) to supabase_auth_admin;

insert into zsite.migrations (version) values ('1003_member_admin') on conflict do nothing;

commit;
