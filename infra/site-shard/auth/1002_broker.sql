
begin;

create schema if not exists zsite_auth;
revoke all on schema zsite_auth from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zsite_broker') then
    create role zsite_broker nologin noinherit;
  end if;
end $$;

create table if not exists zsite_auth.email_changes (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null,
  auth_user_id   uuid not null,
  old_email_norm text not null,
  new_email_norm text not null check (new_email_norm = lower(new_email_norm) and length(new_email_norm) between 3 and 320),
  new_alias      text not null,
  token_sha256   text not null unique,
  state          text not null default 'pending'
                 check (state in ('pending', 'committing', 'done', 'expired', 'cancelled', 'failed')),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (site_id, auth_user_id) references zsite.identities (site_id, auth_user_id)
    on update cascade on delete cascade
);
create unique index if not exists email_changes_open_email
  on zsite_auth.email_changes (site_id, new_email_norm) where state in ('pending', 'committing');
create unique index if not exists email_changes_open_user
  on zsite_auth.email_changes (auth_user_id) where state in ('pending', 'committing');
create unique index if not exists email_changes_open_alias
  on zsite_auth.email_changes (new_alias) where state in ('pending', 'committing');

create table if not exists zsite_auth.deletions (
  auth_user_id uuid primary key,
  site_id      uuid not null,
  started_at   timestamptz not null default now()
);

create table if not exists zsite_auth.rate_counters (
  key          text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

create table if not exists zsite_auth.nonces (
  nonce      text primary key check (length(nonce) between 8 and 128),
  expires_at timestamptz not null
);

alter table zsite_auth.email_changes enable row level security;
alter table zsite_auth.nonces        enable row level security;
alter table zsite_auth.deletions     enable row level security;
alter table zsite_auth.rate_counters enable row level security;
revoke all on all tables in schema zsite_auth from public, anon, authenticated, service_role, zsite_broker;

create or replace function zsite_auth.assert_email(p text) returns void
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p is null or p <> lower(btrim(p)) or length(p) not between 3 and 320
     or p !~ '^[^@\s]{1,64}@[^@\s]{1,255}$' then
    raise exception 'email_not_normalized' using errcode = '22023';
  end if;
end $$;

create or replace function zsite_auth.reserve_signup(
  p_site uuid, p_email text, p_alias text, p_uid uuid,
  out outcome text, out auth_user_id uuid, out state text
) language plpgsql security definer set search_path = '' as $$
begin
  perform zsite_auth.assert_email(p_email);
  perform 1 from zsite.sites s where s.site_id = p_site and s.status = 'active';
  if not found then
    outcome := 'site_unavailable'; return;
  end if;
  perform 1 from zsite_auth.email_changes c
   where c.site_id = p_site and c.new_email_norm = p_email and c.state in ('pending', 'committing');
  if found then
    outcome := 'reserved'; return;
  end if;
  insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state)
  values (p_site, p_email, p_uid, p_alias, 'pending')
  on conflict (site_id, email_norm) do nothing;
  if found then
    insert into zsite.members (site_id, user_id, role) values (p_site, p_uid, 'user');
    outcome := 'created'; auth_user_id := p_uid; state := 'pending'; return;
  end if;
  select 'exists', i.auth_user_id, i.state into outcome, auth_user_id, state
    from zsite.identities i where i.site_id = p_site and i.email_norm = p_email;
end $$;

create or replace function zsite_auth.abort_signup(p_site uuid, p_uid uuid) returns boolean
language sql security definer set search_path = '' as $$
  with d as (delete from zsite.identities i
              where i.site_id = p_site and i.auth_user_id = p_uid and i.state = 'pending' returning 1)
  select exists (select 1 from d)
$$;

create or replace function zsite_auth.activate_identity(p_site uuid, p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update zsite.identities i set state = 'active', updated_at = now()
   where i.site_id = p_site and i.auth_user_id = p_uid and i.state = 'pending';
  return exists (select 1 from zsite.identities i
                  where i.site_id = p_site and i.auth_user_id = p_uid
                    and i.state in ('active', 'email_change_pending'));
end $$;

create or replace function zsite_auth.identity_by_user(
  p_uid uuid,
  out site_id uuid, out email_norm text, out alias text, out state text, out role text, out member_status text
) returns setof record language sql stable security definer set search_path = '' as $$
  select i.site_id, i.email_norm, i.alias, i.state, m.role, m.status
    from zsite.identities i
    left join zsite.members m on m.site_id = i.site_id and m.user_id = i.auth_user_id
   where i.auth_user_id = p_uid
$$;

create or replace function zsite_auth.identity_by_email(
  p_site uuid, p_email text,
  out auth_user_id uuid, out alias text, out state text, out role text, out member_status text
) returns setof record language sql stable security definer set search_path = '' as $$
  select i.auth_user_id, i.alias, i.state, m.role, m.status
    from zsite.identities i
    left join zsite.members m on m.site_id = i.site_id and m.user_id = i.auth_user_id
   where i.site_id = p_site and i.email_norm = p_email
$$;

create or replace function zsite_auth.resolve_alias(
  p_alias text,
  out site_id uuid, out auth_user_id uuid, out email_norm text, out kind text, out state text
) returns setof record language sql stable security definer set search_path = '' as $$
  select i.site_id, i.auth_user_id, i.email_norm, 'current', i.state
    from zsite.identities i where i.alias = lower(p_alias)
  union all
  select c.site_id, c.auth_user_id, c.new_email_norm, 'pending_change', c.state
    from zsite_auth.email_changes c
   where c.new_alias = lower(p_alias) and c.state in ('pending', 'committing')
$$;

create or replace function zsite_auth.set_member_role(p_site uuid, p_uid uuid, p_role text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_role is null or p_role !~ '^[a-z][a-z0-9_]{0,31}$' then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  update zsite.members m set role = p_role, status = 'active'
   where m.site_id = p_site and m.user_id = p_uid;
  return found;
end $$;

create or replace function zsite_auth.begin_email_change(
  p_site uuid, p_uid uuid, p_new_email text, p_new_alias text, p_token_sha text, p_ttl_seconds integer
) returns text language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  perform zsite_auth.assert_email(p_new_email);
  select i.email_norm into v_old from zsite.identities i
    join zsite.sites s on s.site_id = i.site_id and s.status = 'active'
   where i.site_id = p_site and i.auth_user_id = p_uid and i.state in ('active', 'email_change_pending')
   for update of i;
  if not found then return 'invalid'; end if;
  if v_old = p_new_email then return 'same'; end if;
  if exists (select 1 from zsite.identities i where i.site_id = p_site and i.email_norm = p_new_email) then
    return 'taken';
  end if;
  update zsite_auth.email_changes c set state = 'cancelled', updated_at = now()
   where c.auth_user_id = p_uid and c.state = 'pending';
  begin
    insert into zsite_auth.email_changes (site_id, auth_user_id, old_email_norm, new_email_norm, new_alias,
                                          token_sha256, expires_at)
    values (p_site, p_uid, v_old, p_new_email, lower(p_new_alias), p_token_sha,
            now() + make_interval(secs => p_ttl_seconds));
  exception when unique_violation then
    return 'taken';
  end;
  update zsite.identities i set state = 'email_change_pending', updated_at = now()
   where i.site_id = p_site and i.auth_user_id = p_uid;
  return 'reserved';
end $$;

create or replace function zsite_auth.claim_email_change(
  p_site uuid, p_token_sha text,
  out outcome text, out id uuid, out auth_user_id uuid, out old_email_norm text,
  out new_email_norm text, out new_alias text
) language plpgsql security definer set search_path = '' as $$
declare c zsite_auth.email_changes;
begin
  select * into c from zsite_auth.email_changes x where x.token_sha256 = p_token_sha for update;
  if not found or c.site_id is distinct from p_site or c.state in ('cancelled', 'failed') then
    outcome := 'invalid'; return;
  end if;
  if c.state = 'done' then outcome := 'used'; return; end if;
  if c.state = 'expired' then outcome := 'expired'; return; end if;
  if c.state = 'pending' and c.expires_at <= now() then
    update zsite_auth.email_changes x set state = 'expired', updated_at = now() where x.id = c.id;
    update zsite.identities i set state = 'active', updated_at = now()
     where i.site_id = c.site_id and i.auth_user_id = c.auth_user_id and i.state = 'email_change_pending';
    outcome := 'expired'; return;
  end if;
  if c.state = 'pending' then
    update zsite_auth.email_changes x set state = 'committing', updated_at = now() where x.id = c.id;
  end if;
  outcome := 'ok'; id := c.id; auth_user_id := c.auth_user_id; old_email_norm := c.old_email_norm;
  new_email_norm := c.new_email_norm; new_alias := c.new_alias;
end $$;

create or replace function zsite_auth.commit_email_change(
  p_id uuid, out old_email_norm text, out new_email_norm text
) language plpgsql security definer set search_path = '' as $$
declare c zsite_auth.email_changes;
begin
  select * into c from zsite_auth.email_changes x where x.id = p_id and x.state = 'committing' for update;
  if not found then
    raise exception 'email_change_not_committing' using errcode = '55000';
  end if;
  update zsite.identities i
     set email_norm = c.new_email_norm, alias = c.new_alias, state = 'active', updated_at = now()
   where i.site_id = c.site_id and i.auth_user_id = c.auth_user_id;
  update zsite_auth.email_changes x set state = 'done', updated_at = now() where x.id = c.id;
  old_email_norm := c.old_email_norm; new_email_norm := c.new_email_norm;
end $$;

create or replace function zsite_auth.fail_email_change(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c zsite_auth.email_changes;
begin
  update zsite_auth.email_changes x set state = 'failed', updated_at = now()
   where x.id = p_id and x.state in ('pending', 'committing') returning * into c;
  if not found then return false; end if;
  update zsite.identities i set state = 'active', updated_at = now()
   where i.site_id = c.site_id and i.auth_user_id = c.auth_user_id and i.state = 'email_change_pending';
  return true;
end $$;

create or replace function zsite_auth.begin_deletion(p_site uuid, p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update zsite.identities i set state = 'deleting', updated_at = now()
   where i.site_id = p_site and i.auth_user_id = p_uid;
  if not found then
    return exists (select 1 from zsite_auth.deletions d where d.auth_user_id = p_uid and d.site_id = p_site);
  end if;
  update zsite.members m set status = 'disabled' where m.site_id = p_site and m.user_id = p_uid;
  update zsite_auth.email_changes c set state = 'cancelled', updated_at = now()
   where c.auth_user_id = p_uid and c.state in ('pending', 'committing');
  insert into zsite_auth.deletions (auth_user_id, site_id) values (p_uid, p_site)
  on conflict (auth_user_id) do nothing;
  return true;
end $$;

create or replace function zsite_auth.user_object_names(p_site uuid, p_uid uuid, p_limit integer)
returns setof text language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
   where o.bucket_id = 'site-files'
     and o.name like p_site::text || '/%'
     and o.owner_id = p_uid::text
     and exists (select 1 from zsite_auth.deletions d where d.auth_user_id = p_uid and d.site_id = p_site)
   order by o.name
   limit least(greatest(p_limit, 1), 1000)
$$;

create or replace function zsite_auth.delete_account_data(p_site uuid, p_uid uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform 1 from zsite_auth.deletions d where d.auth_user_id = p_uid and d.site_id = p_site;
  if not found then
    raise exception 'deletion_not_started' using errcode = '55000';
  end if;
  delete from zsite.records r where r.site_id = p_site and r.owner_id = p_uid;
  get diagnostics n = row_count;
  delete from zsite.identities i where i.site_id = p_site and i.auth_user_id = p_uid;
  return n;
end $$;

create or replace function zsite_auth.finish_deletion(p_uid uuid) returns boolean
language sql security definer set search_path = '' as $$
  with d as (delete from zsite_auth.deletions x where x.auth_user_id = p_uid returning 1)
  select exists (select 1 from d)
$$;

create or replace function zsite_auth.pending_deletions(p_limit integer)
returns table (auth_user_id uuid, site_id uuid, started_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select d.auth_user_id, d.site_id, d.started_at from zsite_auth.deletions d
   order by d.started_at limit least(greatest(p_limit, 1), 1000)
$$;

create or replace function zsite_auth.rate_take(p_key text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_win timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  if p_window_seconds < 1 or p_max < 0 then
    raise exception 'invalid_rate' using errcode = '22023';
  end if;
  insert into zsite_auth.rate_counters as r (key, window_start, hits) values (p_key, v_win, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from zsite_auth.rate_counters r
     where r.ctid in (select x.ctid from zsite_auth.rate_counters x
                       where x.window_start < now() - interval '2 days' limit 500);
  end if;
  return v_hits <= p_max;
end $$;

create or replace function zsite_auth.claim_nonce(p_nonce text, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_ttl_seconds < 1 then
    raise exception 'invalid_ttl' using errcode = '22023';
  end if;
  delete from zsite_auth.nonces n where n.nonce = p_nonce and n.expires_at <= clock_timestamp();
  insert into zsite_auth.nonces (nonce, expires_at)
  values (p_nonce, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  on conflict (nonce) do nothing;
  if not found then return false; end if;
  if random() < 0.01 then
    delete from zsite_auth.nonces n
     where n.ctid in (select x.ctid from zsite_auth.nonces x where x.expires_at <= clock_timestamp() limit 500);
  end if;
  return true;
end $$;

revoke all on all functions in schema zsite_auth from public, anon, authenticated, service_role;
grant usage on schema zsite_auth to zsite_broker;
grant execute on function
  zsite_auth.reserve_signup(uuid, text, text, uuid),
  zsite_auth.abort_signup(uuid, uuid),
  zsite_auth.activate_identity(uuid, uuid),
  zsite_auth.identity_by_user(uuid),
  zsite_auth.identity_by_email(uuid, text),
  zsite_auth.resolve_alias(text),
  zsite_auth.set_member_role(uuid, uuid, text),
  zsite_auth.begin_email_change(uuid, uuid, text, text, text, integer),
  zsite_auth.claim_email_change(uuid, text),
  zsite_auth.commit_email_change(uuid),
  zsite_auth.fail_email_change(uuid),
  zsite_auth.begin_deletion(uuid, uuid),
  zsite_auth.user_object_names(uuid, uuid, integer),
  zsite_auth.delete_account_data(uuid, uuid),
  zsite_auth.finish_deletion(uuid),
  zsite_auth.pending_deletions(integer),
  zsite_auth.rate_take(text, integer, integer),
  zsite_auth.claim_nonce(text, integer)
  to zsite_broker;
revoke execute on function zsite_auth.custom_access_token_hook(jsonb) from zsite_broker;
grant execute on function zsite_auth.custom_access_token_hook(jsonb) to supabase_auth_admin;

insert into zsite.migrations (version) values ('1002_broker') on conflict do nothing;

commit;
