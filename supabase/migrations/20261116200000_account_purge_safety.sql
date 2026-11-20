
begin;

alter table account_deletions
  add column if not exists storage_purged_at timestamptz,
  add column if not exists purge_storage_keys text[],
  add column if not exists held_at timestamptz,
  add column if not exists hold_reason text;

alter table account_deletions drop constraint if exists account_deletions_status_chk;
alter table account_deletions add constraint account_deletions_status_chk
  check (status in ('pending', 'soft_deleted', 'purged', 'failed', 'held'));
alter table account_deletions alter column status set default 'pending';

comment on column account_deletions.status is
  'pending: written, the login not yet confirmed soft-deleted (never purged). soft_deleted: GoTrue soft-deleted the login; purged after purge_after. failed: the GoTrue delete failed. held: paused by staff (account_purge_hold); never purged until released. purged: done.';
comment on column account_deletions.storage_purged_at is
  'When the request''s files were confirmed gone (account_purge_storage_done). Files are removed after purged_at, so a purged request with this empty still has files to remove; the daily worker retries it.';
comment on column account_deletions.purge_storage_keys is
  'Saved creator-media keys (media/<uuid>.<ext>) the person''s creator profile pointed at, captured by the purge before that profile was deleted, so the files can still be found afterwards. Cleared with storage_purged_at.';

update tenant_member_invites
   set revoked_at = now()
 where accepted_at is null
   and revoked_at is null
   and tenant_id in (select id from tenants where deleted_at is not null);

create or replace function account_purge_hold(p_deletion_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_deletion_id is null or coalesce(trim(p_reason), '') = '' then
    raise exception 'account_purge_hold: deletion id and a reason are required';
  end if;
  update account_deletions
     set status = 'held', held_at = now(), hold_reason = left(trim(p_reason), 500)
   where id = p_deletion_id and status = 'soft_deleted' and purged_at is null;
  if not found then
    raise exception 'account_purge_hold: only an unpurged soft_deleted request can be held (deletion %)', p_deletion_id;
  end if;
end $$;

comment on function account_purge_hold(uuid, text) is
  'Pause the 30-day purge of ONE account_deletions request (status -> held). The purge refuses a held request; account_purge_release undoes it.';
revoke all on function account_purge_hold(uuid, text) from public, anon, authenticated;
grant execute on function account_purge_hold(uuid, text) to service_role;

create or replace function account_purge_release(p_deletion_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update account_deletions
     set status = 'soft_deleted', held_at = null, hold_reason = null
   where id = p_deletion_id and status = 'held' and purged_at is null;
  if not found then
    raise exception 'account_purge_release: deletion % is not held', p_deletion_id;
  end if;
end $$;

comment on function account_purge_release(uuid) is
  'Release a held account_deletions request back to soft_deleted. The purge still checks that the login was really soft-deleted.';
revoke all on function account_purge_release(uuid) from public, anon, authenticated;
grant execute on function account_purge_release(uuid) to service_role;

create or replace function account_deletion_staff_block(p_user_id uuid, p_session_id text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_session_created timestamptz;
begin
  if p_user_id is null then
    raise exception 'account_deletion_staff_block: user id is required';
  end if;
  if p_session_id is null
     or p_session_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 'unknown_session';
  end if;
  if p_session_id is not null and exists (
       select 1 from admin_action_log a
        where a.action = 'login_as' and a.after_state->>'session_id' = p_session_id) then
    return 'staff_session';
  end if;
  if p_session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select s.created_at into v_session_created
      from auth.sessions s where s.id = p_session_id::uuid and s.user_id = p_user_id;
    if v_session_created is not null and exists (
         select 1 from admin_action_log a
          where a.action = 'login_as'
            and a.after_state->>'target_user_id' = p_user_id::text
            and not coalesce(a.after_state ? 'session_id', false)
            and a.created_at between v_session_created - interval '1 minute'
                                 and v_session_created + interval '5 minutes') then
      return 'staff_session';
    end if;
  end if;
  if exists (
       select 1 from admin_action_log a
        where a.action = 'login_as'
          and a.after_state->>'target_user_id' = p_user_id::text
          and a.created_at > now() - interval '24 hours') then
    return 'recent_staff_login';
  end if;
  return null;
end $$;

comment on function account_deletion_staff_block(uuid, text) is
  'DELETE /api/account refuses when this returns non-null: unknown_session (no session id to check), staff_session (the bearer session was minted by a staff login_as) or recent_staff_login (a login_as on this person in the last 24 hours). See 20261116200000_account_purge_safety.sql.';
revoke all on function account_deletion_staff_block(uuid, text) from public, anon, authenticated;
grant execute on function account_deletion_staff_block(uuid, text) to service_role;

create or replace function account_deletion_begin(
  p_deletion_id uuid,
  p_user_id uuid,
  p_email_sha256 text,
  p_source text,
  p_purge_after timestamptz,
  p_deleted_tenant_ids uuid[],
  p_left_tenant_ids uuid[]
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_deleted uuid[] := coalesce(p_deleted_tenant_ids, '{}'::uuid[]);
begin
  if p_deletion_id is null or p_user_id is null or p_purge_after is null then
    raise exception 'account_deletion: deletion id, user id and purge_after are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account_deletion:' || p_user_id::text, 0));
  if exists (select 1 from account_deletions where id = p_deletion_id) then
    raise exception 'account_deletion: duplicate_id (%)', p_deletion_id;
  end if;
  if exists (select 1 from auth.users where id = p_user_id and deleted_at is not null) then
    raise exception 'account_deletion: already_in_progress (the login is already deleted)'
      using errcode = '55P03';
  end if;
  if exists (select 1 from account_deletions d
              where d.user_id = p_user_id
                and d.status in ('pending', 'soft_deleted', 'held', 'purged')) then
    raise exception 'account_deletion: already_in_progress (this account already has a deletion request)'
      using errcode = '55P03';
  end if;
  perform 1 from tenants where id = any (v_deleted) order by id for update;
  if exists (
       select 1 from unnest(v_deleted) t(id)
        where not exists (select 1 from tenants x where x.id = t.id)
           or not exists (select 1 from tenant_users tu where tu.tenant_id = t.id and tu.user_id = p_user_id)
           or exists (select 1 from tenant_users tu where tu.tenant_id = t.id and tu.user_id <> p_user_id)) then
    raise exception 'account_deletion: workspace_changed (a workspace going with the account no longer has the person as its only member)'
      using errcode = '40001';
  end if;
  insert into account_deletions (id, user_id, email_sha256, source, purge_after, status, deleted_tenant_ids, left_tenant_ids)
  values (p_deletion_id, p_user_id, p_email_sha256, coalesce(p_source, 'api'), p_purge_after, 'pending',
          v_deleted, coalesce(p_left_tenant_ids, '{}'::uuid[]));
  update tenants set deleted_at = coalesce(deleted_at, now()) where id = any (v_deleted);
  return p_deletion_id;
end $$;

comment on function account_deletion_begin(uuid, uuid, text, text, timestamptz, uuid[], uuid[]) is
  'DELETE /api/account: in one transaction, refuse a second deletion of the same person, lock the workspaces that go with the account, re-check the person is their only member (workspace_changed), write the request as pending and set tenants.deleted_at. See 20261116200000_account_purge_safety.sql.';
revoke all on function account_deletion_begin(uuid, uuid, text, text, timestamptz, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function account_deletion_begin(uuid, uuid, text, text, timestamptz, uuid[], uuid[]) to service_role;

drop function if exists account_deletion_abort(uuid);
create or replace function account_deletion_abort(p_deletion_id uuid, p_definite boolean default false)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d account_deletions;
begin
  select * into d from account_deletions where id = p_deletion_id;
  if not found then
    return 'noop';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account_deletion:' || d.user_id::text, 0));
  select * into d from account_deletions where id = p_deletion_id for update;
  if d.status is distinct from 'pending' then
    return 'noop';
  end if;
  perform 1 from auth.users where id = d.user_id for update;
  if exists (select 1 from auth.users where id = d.user_id and deleted_at is not null) then
    update account_deletions set status = 'soft_deleted' where id = d.id;
    return 'soft_deleted';
  end if;
  if not coalesce(p_definite, false) and d.requested_at > now() - interval '1 hour' then
    return 'too_early';
  end if;
  update account_deletions set status = 'failed' where id = d.id;
  update tenants t set deleted_at = null
   where t.id = any (d.deleted_tenant_ids)
     and t.deleted_at is not null
     and exists (select 1 from tenant_users tu where tu.tenant_id = t.id and tu.user_id = d.user_id)
     and not exists (select 1 from account_deletions o
                      where o.id <> d.id and t.id = any (o.deleted_tenant_ids)
                        and o.status in ('pending', 'soft_deleted', 'held', 'purged'));
  return 'failed';
end $$;

comment on function account_deletion_abort(uuid, boolean) is
  'Settle a pending account deletion by auth.users: login soft-deleted -> soft_deleted (marks kept); login live -> failed and workspace marks cleared unless another live request covers them (by hand: only an hour after the request, else too_early; the route passes p_definite after a GoTrue 4xx or a lost begin answer). Returns soft_deleted | failed | too_early | noop.';
revoke all on function account_deletion_abort(uuid, boolean) from public, anon, authenticated;
grant execute on function account_deletion_abort(uuid, boolean) to service_role;

create or replace function account_deletion_mismatches(p_limit integer default 25)
returns table (id uuid, kind text)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id, 'killed_after_fail'::text
    from account_deletions d
    join auth.users u on u.id = d.user_id
   where d.status = 'failed' and u.deleted_at is not null
   order by d.requested_at
   limit greatest(1, least(coalesce(p_limit, 25), 200))
$$;

revoke all on function account_deletion_mismatches(integer) from public, anon, authenticated;
grant execute on function account_deletion_mismatches(integer) to service_role;

create or replace function accept_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invite tenant_member_invites;
  v_caller_email text;
  v_slug text;
  v_tier text;
  v_max int;
  v_deleted_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select email into v_caller_email from auth.users where id = auth.uid();
  if v_caller_email is null then
    raise exception 'caller email unknown' using errcode = '42501';
  end if;

  select * into v_invite from tenant_member_invites where id = p_invite_id;
  if v_invite.id is null then
    raise exception 'invite % not found', p_invite_id using errcode = '42704';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite already accepted' using errcode = '42501';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite revoked' using errcode = '42501';
  end if;
  if lower(v_caller_email) <> lower(v_invite.email) then
    raise exception 'invite is for a different email' using errcode = '42501';
  end if;

  select deleted_at into v_deleted_at from tenants where id = v_invite.tenant_id for share;
  if not found or v_deleted_at is not null then
    raise exception 'invite revoked (the workspace was deleted)' using errcode = '42501';
  end if;

  if not exists (select 1 from tenant_users
                  where tenant_id = v_invite.tenant_id and user_id = auth.uid()) then
    v_tier := _tenant_tier(v_invite.tenant_id);
    select max_seats into v_max from tenant_seat_limits where tier = v_tier;
    if v_max is not null and v_max >= 0
       and (select count(*) from tenant_users where tenant_id = v_invite.tenant_id) >= v_max then
      raise exception 'seat_cap_exceeded — tier % allows % seats', v_tier, v_max
        using errcode = '42501';
    end if;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (auth.uid(), v_invite.tenant_id, v_invite.role)
  on conflict (user_id, tenant_id) do nothing;

  if v_invite.role = 'member' then
    foreach v_slug in array v_invite.agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_invite.tenant_id, auth.uid(), v_slug, v_invite.invited_by)
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;

  update tenant_member_invites
     set accepted_at = now(),
         accepted_user_id = auth.uid()
   where id = p_invite_id;

  insert into profiles (user_id, active_tenant_id)
  values (auth.uid(), v_invite.tenant_id)
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id;
end $$;

revoke all on function accept_invite(uuid) from public, anon, authenticated;
grant execute on function accept_invite(uuid) to authenticated;

create or replace function purge_tenant_credentials(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_secret record;
  v_purged integer := 0;
begin
  if p_tenant_id is null then
    raise exception 'purge_tenant_credentials: tenant_id is required';
  end if;

  for v_secret in
    select distinct vault_secret_id from secrets where tenant_id = p_tenant_id
      and not exists (
        select 1 from public.site_providers sp
         where sp.tenant_id = p_tenant_id
           and sp.kind = 'supabase_project'
           and sp.state <> 'deleted'
           and secrets.key in ('site.' || sp.site_id::text || '.sb_service_role',
                               'site.' || sp.site_id::text || '.sb_anon',
                               'site.' || sp.site_id::text || '.sb_db_password'))
  loop
    delete from vault.secrets v
     where v.id = v_secret.vault_secret_id
       and not exists (select 1 from public.secrets s
                        where s.vault_secret_id = v.id
                          and (s.tenant_id is distinct from p_tenant_id
                               or exists (
                                 select 1 from public.site_providers sp
                                  where sp.tenant_id = p_tenant_id
                                    and sp.kind = 'supabase_project'
                                    and sp.state <> 'deleted'
                                    and s.key in ('site.' || sp.site_id::text || '.sb_service_role',
                                                  'site.' || sp.site_id::text || '.sb_anon',
                                                  'site.' || sp.site_id::text || '.sb_db_password'))))
       and not exists (select 1 from public.site_function_secrets s where s.vault_secret_id = v.id)
       and not exists (select 1 from public.site_function_retired_secrets s where s.vault_secret_id = v.id)
       and not exists (select 1 from public.site_backend_settings s where s.turnstile_secret_id = v.id)
       and not exists (select 1 from public.tenant_buffer_connection b where b.vault_secret_name = v.name)
       and not exists (select 1 from public.platform_secrets p where p.vault_secret_id = v.id)
       and not exists (select 1 from public.site_shard_secrets p where p.vault_secret_id = v.id);
    if found then
      v_purged := v_purged + 1;
    end if;
  end loop;

  delete from secrets where tenant_id = p_tenant_id
      and not exists (
        select 1 from public.site_providers sp
         where sp.tenant_id = p_tenant_id
           and sp.kind = 'supabase_project'
           and sp.state <> 'deleted'
           and secrets.key in ('site.' || sp.site_id::text || '.sb_service_role',
                               'site.' || sp.site_id::text || '.sb_anon',
                               'site.' || sp.site_id::text || '.sb_db_password'));
  delete from connector_metadata where tenant_id = p_tenant_id;

  update tenant_mcp_servers set enabled = false where tenant_id = p_tenant_id;

  return v_purged;
end $$;

comment on function purge_tenant_credentials(uuid) is
  'Deletes every Vault secret + connector_metadata row for one tenant and disables its MCP servers, EXCEPT a new-flow site''s own keys (site.<id>.sb_*) while its Supabase project is not yet hard-deleted, and a Vault secret any row that stays still points at (another workspace, this workspace''s kept site key, a site function / Turnstile / Buffer row, a platform credential or a shard; only the tenant''s own unprotected secrets rows go). Account-deletion teardown only (routes/account). Returns the number of Vault secrets removed.';

revoke all on function purge_tenant_credentials(uuid) from public, anon, authenticated;
grant execute on function purge_tenant_credentials(uuid) to service_role;

create or replace function _account_purge_covered_sql(p_cover jsonb, p_rel text, p_alias text)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(
           (select '(' || string_agg(format('%I.%I = any ($1)', p_alias, c), ' or ' order by c) || ')'
              from jsonb_array_elements_text(p_cover -> p_rel) c),
           'false')
$$;

revoke all on function _account_purge_covered_sql(jsonb, text, text) from public, anon, authenticated;

create or replace function account_purge_person_links()
returns table (rel text, col text)
language sql immutable set search_path = public, pg_temp as $$
  values ('creator_notifications'::text, 'human_member_id'::text)
$$;

comment on function account_purge_person_links() is
  'Foreign keys from a person''s own rows whose cascaded rows with an empty tenant_id belong to that person (the account purge deletes them). Any other such row refuses the purge. See 20261116200000_account_purge_safety.sql.';
revoke all on function account_purge_person_links() from public, anon, authenticated;

drop function if exists _account_purge_cross_tenant(uuid[], uuid, uuid[], text);

do $mk$
declare
  v_body text := $walk$
declare
  v_tenants uuid[] := coalesce(p_tenants, '{}'::uuid[]);
  v_auth oid;
  v_cover jsonb;
  v_person jsonb;
  v_queue jsonb := '[]'::jsonb;
  v_pos integer := 0;
  v_item jsonb;
  v_pred text;
  v_ctids tid[];
  v_seen jsonb := '{}'::jsonb;
  v_out jsonb := '{}'::jsonb;
  v_rows bigint := 0;
  v_match text;
  v_follow text;
  v_key text;
  v_found tid[];
  v_new text[];
  v_pns text;
  v_prel text;
  n bigint;
  r record;
  e record;
begin
  -- Each table's delete-bucket columns, once: what "covered" means per table.
  select coalesce(jsonb_object_agg(s.rel, s.cols), '{}'::jsonb) into v_cover
    from (select t.rel, jsonb_agg(t.col order by t.col) as cols
            from _account_purge_tenant_refs() t where t.bucket = 'delete' group by t.rel) s;
  select coalesce(jsonb_object_agg(l.rel || '.' || l.col, true), '{}'::jsonb) into v_person
    from account_purge_person_links() l;

  if p_mode = 'runs' then
    if coalesce(cardinality(p_runs), 0) = 0 then return v_out; end if;
    v_queue := jsonb_build_array(jsonb_build_object('rel', 'public.agent_runs'::regclass::oid, 'pred', 'p.id = any ($3)'));
  elsif p_mode = 'workspace' then
    if cardinality(v_tenants) = 0 then return v_out; end if;
    for r in select t.rel, t.col from _account_purge_tenant_refs() t where t.bucket = 'delete' order by 1, 2 loop
      v_queue := v_queue || jsonb_build_object(
        'rel', to_regclass('public.' || quote_ident(r.rel))::oid,
        'pred', format('p.%I = any ($1)', r.col));
    end loop;
  elsif p_mode = 'user' then
    if p_user is null then return v_out; end if;
    select c.oid into v_auth
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'auth' and c.relname = 'users';
    for r in
      select cl.relname::text as rel, a.attname::text as col
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = v_auth and c.conparentid = 0
         and array_length(c.conkey, 1) = 1 and c.confdeltype = 'c'
         and ns.nspname = 'public' and cl.relkind in ('r', 'p')
       order by 1, 2
    loop
      v_queue := v_queue || jsonb_build_object(
        'rel', to_regclass('public.' || quote_ident(r.rel))::oid,
        'pred', format('p.%I = $2 and not coalesce(%s, false)', r.col, _account_purge_covered_sql(v_cover, r.rel, 'p')));
    end loop;
  else
    raise exception 'account_purge: unknown walk mode %', p_mode;
  end if;

  while v_pos < jsonb_array_length(v_queue) loop
    v_item := v_queue -> v_pos;
    v_pos := v_pos + 1;
    if v_pos > 5000 then
      raise exception 'account_purge: cascade_check_too_large (more than 5000 steps)';
    end if;
    continue when v_item->>'rel' is null;
    v_pred := v_item->>'pred';
    v_ctids := case when v_item ? 'ctids'
                    then array(select jsonb_array_elements_text(v_item->'ctids'))::tid[] end;
    -- Lock the rows this step starts from (a followed row was locked when it
    -- was found): no child can be attached to them until the purge commits.
    if p_lock and not (v_item ? 'ctids') then
      select ns.nspname::text, c.relname::text into v_pns, v_prel
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where c.oid = (v_item->>'rel')::oid;
      execute format('select 1 from %I.%I p where %s for update of p', v_pns, v_prel, v_pred)
        using v_tenants, p_user, p_runs, v_ctids;
    end if;

    for e in
      select c.conrelid as child,
             cn.nspname::text as cns, cc.relname::text as crel, cc.relkind as ckind,
             pn.nspname::text as pns, pc.relname::text as prel,
             c.confdeltype as act,
             (select string_agg('x.' || quote_ident(a.attname), ', ' order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as ccols,
             (select string_agg(a.attname::text, ',' order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as clabel,
             (select string_agg('p.' || quote_ident(a.attname), ', ' order by k.ord)
                from unnest(c.confkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as pcols,
             exists (select 1 from pg_attribute t
                      where t.attrelid = c.conrelid and t.attname = 'tenant_id' and not t.attisdropped) as has_tenant,
             -- A composite key that pairs tenant_id with the parent's tenant_id:
             -- the child cannot carry another workspace.
             exists (select 1 from unnest(c.conkey, c.confkey) k(ck, pk)
                       join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = k.ck
                       join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.pk
                      where ca.attname = 'tenant_id' and pa.attname = 'tenant_id') as same_tenant
        from pg_constraint c
        join pg_class cc on cc.oid = c.conrelid
        join pg_namespace cn on cn.oid = cc.relnamespace
        join pg_class pc on pc.oid = c.confrelid
        join pg_namespace pn on pn.oid = pc.relnamespace
       where c.contype = 'f'
         and c.confrelid = (v_item->>'rel')::oid
         and c.conparentid = 0
         and c.confdeltype in ('c', 'n', 'd')
         and cc.relkind in ('r', 'p')
       order by cc.relname, c.conname
    loop
      v_match := format('(%s) in (select %s from %I.%I p where %s)', e.ccols, e.pcols, e.pns, e.prel, v_pred);
      v_key := format('%s.%s <- %s', e.crel, e.clabel, e.prel);
      if e.has_tenant and not e.same_tenant then
        execute format(
          'select count(*) from %I.%I x where %s and x.tenant_id is not null and not (x.tenant_id = any ($1))',
          e.cns, e.crel, v_match)
          into n using v_tenants, p_user, p_runs, v_ctids;
        if n > 0 then
          v_out := v_out || jsonb_build_object(v_key, coalesce((v_out->>v_key)::bigint, 0) + n);
        end if;
        -- (7) From the person's rows, a row with no workspace is theirs only
        -- where account_purge_person_links() says so.
        if p_mode = 'user' and not (v_person ? (e.crel || '.' || e.clabel)) then
          execute format('select count(*) from %I.%I x where %s and x.tenant_id is null', e.cns, e.crel, v_match)
            into n using v_tenants, p_user, p_runs, v_ctids;
          if n > 0 then
            v_out := v_out || jsonb_build_object(v_key || ' (no workspace)',
                       coalesce((v_out->>(v_key || ' (no workspace)'))::bigint, 0) + n);
          end if;
        end if;
      end if;

      if e.act = 'c' then
        -- Rows this cascade deletes that are not already flagged (another
        -- workspace) and not covered by their own root: follow them (locked
        -- first when p_lock).
        v_follow := case when e.has_tenant then ' and (x.tenant_id is null or x.tenant_id = any ($1))' else '' end;
        if p_mode <> 'runs' and e.cns = 'public' then
          v_follow := v_follow || format(' and not coalesce(%s, false)', _account_purge_covered_sql(v_cover, e.crel, 'x'));
        end if;
        if e.ckind = 'p' then
          execute format('select count(*) from %I.%I x where %s%s', e.cns, e.crel, v_match, v_follow)
            into n using v_tenants, p_user, p_runs, v_ctids;
          if n > 0 then
            raise exception 'account_purge: cascade_check_partitioned (%: a cascade reaches a partitioned table; check it by hand)', v_key;
          end if;
          continue;
        end if;
        execute format('select coalesce(array_agg(f.c), ''{}''::tid[]) from (select x.ctid as c from %I.%I x where %s%s%s) f',
                       e.cns, e.crel, v_match, v_follow, case when p_lock then ' for update of x' else '' end)
          into v_found using v_tenants, p_user, p_runs, v_ctids;
        if cardinality(v_found) > 0 then
          -- Rows not seen before (a set difference, so a large batch stays linear).
          v_new := array(
            select t::text from unnest(v_found) t
            except
            select s from jsonb_array_elements_text(coalesce(v_seen -> e.child::text, '[]'::jsonb)) s);
          if cardinality(v_new) > 0 then
            v_rows := v_rows + cardinality(v_new);
            if v_rows > 200000 then
              raise exception 'account_purge: cascade_check_too_large (more than 200000 cascaded rows)';
            end if;
            v_seen := jsonb_set(v_seen, array[e.child::text],
                                coalesce(v_seen -> e.child::text, '[]'::jsonb) || to_jsonb(v_new));
            v_queue := v_queue || jsonb_build_object('rel', e.child, 'pred', 'p.ctid = any ($4)', 'ctids', to_jsonb(v_new));
          end if;
        end if;
      end if;
    end loop;
  end loop;
  return v_out;
end
$walk$;
begin
  execute format($f$create or replace function _account_purge_cross_tenant(p_tenants uuid[], p_user uuid, p_runs uuid[], p_mode text, p_lock boolean)
    returns jsonb language plpgsql volatile set search_path = public, pg_temp as %L$f$, v_body);
  execute format($f$create or replace function _account_purge_cross_tenant_report(p_tenants uuid[], p_user uuid, p_runs uuid[], p_mode text, p_lock boolean)
    returns jsonb language plpgsql stable set search_path = public, pg_temp as %L$f$, v_body);
end $mk$;

revoke all on function _account_purge_cross_tenant(uuid[], uuid, uuid[], text, boolean) from public, anon, authenticated;
revoke all on function _account_purge_cross_tenant_report(uuid[], uuid, uuid[], text, boolean) from public, anon, authenticated;

create or replace function account_purge_storage_ref_columns()
returns table (rel text, col text)
language sql immutable set search_path = public, pg_temp as $$
  values
    ('agent_run_trace'::text, 'storage_path'::text),
    ('creator_submissions', 'preview_path'),
    ('creator_submissions', 'storage_path'),
    ('engineer_html_preview_artifacts', 'storage_path'),
    ('engineer_prototype_links', 'artifact_path'),
    ('extension_screenshots', 'image_path'),
    ('run_artifacts', 'storage_path'),
    ('shared_pages', 'storage_path'),
    ('site_preview_snapshots', 'path'),
    ('sites', 'thumbnail_path'),
    ('tenant_document', 'storage_path')
$$;

comment on function account_purge_storage_ref_columns() is
  'Columns holding a storage object name, in tables with a tenant_id. The account purge never removes a file a row of another workspace points at through one of these. See 20261116200000_account_purge_safety.sql.';
revoke all on function account_purge_storage_ref_columns() from public, anon, authenticated;

create or replace function _account_purge_saved_media_keys(p_user uuid)
returns text[]
language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct k order by k), '{}'::text[])
    from human_members h
    cross join lateral unnest(
      array[h.photo_path, h.illustration_path, h.intro_video_path]
      || coalesce(h.sample_video_paths, '{}'::text[])) k
   where h.auth_user_id = p_user and k like 'media/%'
$$;

revoke all on function _account_purge_saved_media_keys(uuid) from public, anon, authenticated;

drop function if exists _account_purge_storage_targets(uuid, uuid[]);

create or replace function _account_purge_storage_targets(p_user uuid, p_tenants uuid[], p_saved_keys text[])
returns table (bucket_id text, name text)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  r record;
  v_refs text := '';
begin
  for r in
    select l.rel, l.col, a.attndims > 0 or t.typcategory = 'A' as is_array
      from account_purge_storage_ref_columns() l
      join pg_attribute a on a.attrelid = to_regclass('public.' || quote_ident(l.rel))
                         and a.attname = l.col and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
     where exists (select 1 from pg_attribute ta
                    where ta.attrelid = to_regclass('public.' || quote_ident(l.rel))
                      and ta.attname = 'tenant_id' and not ta.attisdropped)
  loop
    v_refs := v_refs || format(
      ' and not exists (select 1 from public.%I ref where %s and not coalesce(ref.tenant_id = any ($2), false))',
      r.rel,
      case when r.is_array then format('o.name = any (ref.%I)', r.col) else format('ref.%I = o.name', r.col) end);
  end loop;

  return query execute format($q$
    select o.bucket_id::text, o.name::text
      from storage.objects o
     where (exists (select 1 from unnest($2) t(id) where o.name like t.id::text || '/%%')
            or (o.bucket_id = 'creator-media'
                and (o.name like $1::text || '/%%' or o.name = any ($3))))
       -- Never a file another person's creator profile points at. Profile paths
       -- are keys in the creator-media bucket (services/creators/creator-media.ts),
       -- so a same-named object in another bucket is not theirs.
       and not (o.bucket_id = 'creator-media'
                and exists (
                  select 1 from human_members other
                   where other.auth_user_id is distinct from $1
                     and (o.name in (other.photo_path, other.illustration_path, other.intro_video_path)
                          or o.name = any (coalesce(other.sample_video_paths, '{}'::text[])))))
       %s
  $q$, v_refs)
  using p_user, coalesce(p_tenants, '{}'::uuid[]), coalesce(p_saved_keys, '{}'::text[]);
end $$;

revoke all on function _account_purge_storage_targets(uuid, uuid[], text[]) from public, anon, authenticated;

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
  if exists (select 1 from auth.users where id = d.user_id and deleted_at is null) then
    raise exception 'account_purge: auth_user_live (the login of this request was never soft-deleted)';
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
    if exists (select 1 from agent_runs r
                where r.tenant_id = v_tenant
                  and r.status in ('queued', 'pending', 'dispatched', 'running', 'in_progress', 'started')) then
      raise exception 'account_purge: runs_in_flight (%)', v_tenant;
    end if;
    if exists (select 1 from tenant_agent_schedules s where s.tenant_id = v_tenant and s.enabled) then
      raise exception 'account_purge: schedules_enabled (%)', v_tenant;
    end if;
    if exists (select 1 from agent_runs r where r.tenant_id = v_tenant and r.finished_at > now() - interval '1 day') then
      raise exception 'account_purge: runs_recent (%)', v_tenant;
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
  if p_deletion_id is null then
    raise exception 'account_purge: deletion id is required';
  end if;
  select * into d from account_deletions where id = p_deletion_id for update;
  if not found then
    raise exception 'account_purge: not_found (deletion %)', p_deletion_id;
  end if;
  if d.purged_at is null or d.status is distinct from 'purged' then
    raise exception 'account_purge: storage_before_purge (files are removed only after the database purge committed; status %)', d.status;
  end if;
  if d.storage_purged_at is not null then
    return;
  end if;
  perform 1 from tenants where id = any (d.deleted_tenant_ids) for update;
  if exists (select 1 from tenant_users where tenant_id = any (d.deleted_tenant_ids)) then
    raise exception 'account_purge: workspace_has_members (a deleted workspace has members again)';
  end if;
  if exists (select 1 from tenants where id = any (d.deleted_tenant_ids) and deleted_at is null) then
    raise exception 'account_purge: workspace_not_marked (a deleted workspace lost its deleted_at mark)';
  end if;
  if exists (select 1 from auth.users where id = d.user_id) then
    raise exception 'account_purge: auth_user_present (the login of a purged request exists)';
  end if;
  return query
    select s.bucket_id, s.name
      from _account_purge_storage_targets(d.user_id, d.deleted_tenant_ids, d.purge_storage_keys) s
     order by s.bucket_id, s.name
     limit greatest(1, least(coalesce(p_limit, 1000), 1000));
end $$;

revoke all on function account_purge_storage_objects(uuid, integer) from public, anon, authenticated;
grant execute on function account_purge_storage_objects(uuid, integer) to service_role;

create or replace function account_purge_storage_done(p_deletion_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d account_deletions;
  n bigint;
begin
  select * into d from account_deletions where id = p_deletion_id for update;
  if not found then
    raise exception 'account_purge: not_found (deletion %)', p_deletion_id;
  end if;
  if d.purged_at is null or d.status is distinct from 'purged' then
    raise exception 'account_purge: storage_before_purge (status %)', d.status;
  end if;
  if d.storage_purged_at is not null then
    return d.storage_purged_at;
  end if;
  select count(*) into n
    from _account_purge_storage_targets(d.user_id, d.deleted_tenant_ids, d.purge_storage_keys);
  if n > 0 then
    raise exception 'account_purge: storage_not_empty (% objects left)', n;
  end if;
  if d.purged_at > now() - interval '1 day' then
    return null;
  end if;
  update account_deletions
     set storage_purged_at = now(), purge_storage_keys = null,
         purge_summary = coalesce(purge_summary, '{}'::jsonb) || jsonb_build_object('storage_pending', false)
   where id = d.id;
  return now();
end $$;

revoke all on function account_purge_storage_done(uuid) from public, anon, authenticated;
grant execute on function account_purge_storage_done(uuid) to service_role;

create or replace function account_purge_delete_runs(p_deletion_id uuid, p_limit integer default 25)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d account_deletions;
  v_kept jsonb;
  v_kept_after jsonb;
  v_deleted integer;
  v_ids uuid[];
  v_cross jsonb;
begin
  d := _account_purge_check(p_deletion_id, true);
  if d.purged_at is not null or cardinality(d.deleted_tenant_ids) = 0
     or not exists (select 1 from agent_runs where tenant_id = any (d.deleted_tenant_ids)) then
    return 0;
  end if;

  if not (coalesce(d.purge_summary, '{}'::jsonb) ? 'planned_delete') then
    update account_deletions
       set purge_summary = coalesce(purge_summary, '{}'::jsonb)
             || jsonb_build_object('planned_delete', purge_account_deletion(p_deletion_id, false)->'delete')
     where id = d.id;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
    from (select id from agent_runs
           where tenant_id = any (d.deleted_tenant_ids)
           order by id
           limit greatest(1, least(coalesce(p_limit, 25), 200))
           for update) b;
  v_cross := _account_purge_cross_tenant(d.deleted_tenant_ids, null, v_ids, 'runs', true);
  if v_cross <> '{}'::jsonb then
    raise exception 'account_purge: cross_tenant_rows (deleting these runs would reach rows of other workspaces: %)', v_cross;
  end if;

  v_kept := _account_purge_kept_counts(d.deleted_tenant_ids);
  delete from agent_runs where id = any (v_ids);
  get diagnostics v_deleted = row_count;
  v_kept_after := _account_purge_kept_counts(d.deleted_tenant_ids);
  if v_kept_after is distinct from v_kept then
    raise exception 'account_purge: kept_rows_changed (before %, after %)', v_kept, v_kept_after;
  end if;

  if v_deleted > 0 then
    update account_deletions
       set purge_summary = coalesce(purge_summary, '{}'::jsonb)
             || jsonb_build_object('batched_agent_runs',
                  coalesce((purge_summary->>'batched_agent_runs')::integer, 0) + v_deleted)
     where id = d.id;
  end if;
  return v_deleted;
end $$;

revoke all on function account_purge_delete_runs(uuid, integer) from public, anon, authenticated;
grant execute on function account_purge_delete_runs(uuid, integer) to service_role;

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
  v_cross jsonb := '{}'::jsonb;
  v_saved_keys text[];
  v_storage_left bigint;
  v_auth oid;
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
  select c.oid into v_auth
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'auth' and c.relname = 'users';

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
  v_saved_keys := case when v_already then coalesce(d.purge_storage_keys, '{}'::text[])
                       else _account_purge_saved_media_keys(d.user_id) end;
  select count(*) into v_storage from _account_purge_storage_targets(d.user_id, v_tenants, v_saved_keys);

  if not v_already then
    if p_execute then
      v_cross := _account_purge_cross_tenant(v_tenants, d.user_id, null, 'workspace', true)
              || _account_purge_cross_tenant(v_tenants, d.user_id, null, 'user', true);
    else
      v_cross := _account_purge_cross_tenant_report(v_tenants, d.user_id, null, 'workspace', false)
              || _account_purge_cross_tenant_report(v_tenants, d.user_id, null, 'user', false);
    end if;
  end if;

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
       and c.confrelid = v_auth
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
    'cross_tenant_links', v_cross,
    'storage_objects', v_storage,
    'storage_pending', case when v_already then d.storage_purged_at is null else v_storage > 0 end,
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
  if v_cross <> '{}'::jsonb then
    raise exception 'account_purge: cross_tenant_rows (a delete would reach rows of other workspaces: %)', v_cross;
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
    select cl.relname::text as rel, a.attname::text as col,
           exists (select 1 from pg_attribute ta
                    where ta.attrelid = c.conrelid and ta.attname = 'tenant_id' and not ta.attisdropped) as has_tenant
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = v_auth
       and c.conparentid = 0
       and array_length(c.conkey, 1) = 1
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
     order by 1, 2
  loop
    execute format('select 1 from public.%I where %I = $1 for update', r.rel, r.col) using d.user_id;
    if r.has_tenant then
      execute format(
        'select count(*) from public.%I where %I = $1 and tenant_id is not null and not (tenant_id = any ($2))',
        r.rel, r.col) into n using d.user_id, v_tenants;
      if n > 0 then v_user_block := v_user_block || jsonb_build_object(r.rel || '.' || r.col || ' (other workspaces)', n); end if;
    end if;
  end loop;
  if v_user_block <> '{}'::jsonb then
    raise exception 'account_purge: user_rows_outside (rows outside the deleted workspaces still point at the person: %)', v_user_block;
  end if;
  v_cross := _account_purge_cross_tenant(v_tenants, d.user_id, null, 'user', true);
  if v_cross <> '{}'::jsonb then
    raise exception 'account_purge: cross_tenant_rows (deleting the person would reach rows of other workspaces: %)', v_cross;
  end if;
  v_saved_keys := _account_purge_saved_media_keys(d.user_id);
  perform 1 from auth.users where id = d.user_id for update;
  if exists (select 1 from auth.users where id = d.user_id and deleted_at is null) then
    raise exception 'account_purge: auth_user_live (the login of this request was never soft-deleted)';
  end if;

  delete from auth.users where id = d.user_id;

  v_kept_after := _account_purge_kept_counts(v_tenants);
  if v_kept_after is distinct from v_kept then
    raise exception 'account_purge: kept_rows_changed (before %, after %)', v_kept, v_kept_after;
  end if;

  select count(*) into v_storage_left from _account_purge_storage_targets(d.user_id, v_tenants, v_saved_keys);
  v_summary := v_summary || jsonb_build_object('status', 'purged', 'storage_pending', true,
                                               'storage_objects', v_storage_left);

  update account_deletions
     set purged_at = now(),
         status = 'purged',
         purge_summary = v_summary,
         purge_last_error = null,
         purge_attempts = purge_attempts + 1,
         purge_last_attempt_at = now(),
         purge_storage_keys = v_saved_keys,
         storage_purged_at = null
   where id = d.id;

  return v_summary || jsonb_build_object('purged_at', now());
end $$;

comment on function purge_account_deletion(uuid, boolean) is
  'The 30-day purge of one account_deletions request (p_execute=false is a dry run). Deletes the deleted workspaces'' rows and the auth user, keeps billing records and audit logs, stamps purged_at + purge_summary; the request''s files are removed after it commits (account_purge_storage_objects / account_purge_storage_done). Raises (changing nothing) when the request is not due or not safe: login not soft-deleted, held, a row of the workspaces in an unclassified column, or a delete that would reach a row of another workspace. See 20261115200000, 20261115210000 and 20261116200000.';

revoke all on function purge_account_deletion(uuid, boolean) from public, anon, authenticated;
grant execute on function purge_account_deletion(uuid, boolean) to service_role;

commit;
