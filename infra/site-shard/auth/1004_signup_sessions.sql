
begin;

create table if not exists zsite_auth.signups (
  site_id           uuid not null,
  email_norm        text not null check (email_norm = lower(email_norm) and length(email_norm) between 3 and 320),
  auth_user_id      uuid not null unique,
  alias             text not null unique,
  state             text not null default 'pending' check (state in ('pending', 'creating', 'quarantined')),
  lease_sha         text,
  lease_until       timestamptz,
  last_challenge_at timestamptz,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  primary key (site_id, email_norm)
);

create table if not exists zsite_auth.signup_challenges (
  id            uuid primary key,
  site_id       uuid not null,
  email_norm    text not null,
  token_sha256  text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  foreign key (site_id, email_norm) references zsite_auth.signups (site_id, email_norm) on delete cascade
);
create index if not exists signup_challenges_owner on zsite_auth.signup_challenges (site_id, email_norm);

create table if not exists zsite_auth.mail_outbox (
  id           bigint generated always as identity primary key,
  site_id      uuid not null,
  to_email     text not null,
  kind         text not null check (kind in ('verify_signup', 'account_exists')),
  challenge_id uuid,
  attempts     integer not null default 0,
  lease_until  timestamptz,
  created_at   timestamptz not null default now(),
  check ((kind = 'verify_signup') = (challenge_id is not null))
);

create table if not exists zsite_auth.signup_receipts (
  token_sha256 text primary key,
  site_id      uuid not null,
  auth_user_id uuid not null,
  alias        text not null,
  expires_at   timestamptz not null
);
alter table zsite_auth.signup_receipts enable row level security;
revoke all on zsite_auth.signup_receipts from public, anon, authenticated, service_role, zsite_broker;

alter table zsite_auth.signups           enable row level security;
alter table zsite_auth.signup_challenges enable row level security;
alter table zsite_auth.mail_outbox       enable row level security;
revoke all on zsite_auth.signups, zsite_auth.signup_challenges, zsite_auth.mail_outbox
  from public, anon, authenticated, service_role, zsite_broker;

create or replace function zsite_auth.signup_request(
  p_site uuid, p_email text, p_alias text, p_uid uuid, p_challenge uuid, p_token_sha text,
  p_ttl_seconds integer, p_cooldown_seconds integer, p_max_live integer
) returns void language plpgsql security definer set search_path = '' as $$
declare v_state text; v_iuid uuid; v_ialias text; s zsite_auth.signups; v_live integer;
begin
  perform zsite_auth.assert_email(p_email);
  if p_ttl_seconds not between 60 and 7 * 86400 or p_cooldown_seconds not between 0 and 86400
     or p_max_live not between 1 and 10 or p_token_sha !~ '^[0-9a-f]{64}$'
     or p_uid is null or p_challenge is null or p_alias is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  perform 1 from zsite.sites x where x.site_id = p_site and x.status = 'active';
  if not found then return; end if;

  select i.state, i.auth_user_id, i.alias into v_state, v_iuid, v_ialias
    from zsite.identities i where i.site_id = p_site and i.email_norm = p_email;
  if found and v_state not in ('pending', 'unverified') then
    if v_state in ('active', 'email_change_pending') then
      insert into zsite_auth.mail_outbox (site_id, to_email, kind) values (p_site, p_email, 'account_exists');
    end if;
    return;
  end if;
  if found and v_state = 'unverified' then
    p_uid := v_iuid; p_alias := v_ialias;
  end if;
  if exists (select 1 from zsite_auth.email_changes c
              where c.site_id = p_site and c.new_email_norm = p_email and c.state in ('pending', 'committing')) then
    return;
  end if;

  insert into zsite_auth.signups (site_id, email_norm, auth_user_id, alias, expires_at)
  values (p_site, p_email, p_uid, lower(p_alias), pg_catalog.now() + make_interval(secs => p_ttl_seconds))
  on conflict (site_id, email_norm) do nothing;
  select * into s from zsite_auth.signups x where x.site_id = p_site and x.email_norm = p_email for update;
  if s.state <> 'pending' then return; end if;

  delete from zsite_auth.signup_challenges c
   where c.site_id = p_site and c.email_norm = p_email and c.expires_at <= pg_catalog.now();
  select count(*) into v_live from zsite_auth.signup_challenges c where c.site_id = p_site and c.email_norm = p_email;
  if v_live >= p_max_live then return; end if;
  if s.last_challenge_at is not null
     and s.last_challenge_at > pg_catalog.now() - make_interval(secs => p_cooldown_seconds) then
    return;
  end if;

  insert into zsite_auth.signup_challenges (id, site_id, email_norm, token_sha256, expires_at)
  values (p_challenge, p_site, p_email, p_token_sha, pg_catalog.now() + make_interval(secs => p_ttl_seconds));
  update zsite_auth.signups x
     set last_challenge_at = pg_catalog.now(),
         expires_at = greatest(x.expires_at, pg_catalog.now() + make_interval(secs => p_ttl_seconds))
   where x.site_id = p_site and x.email_norm = p_email;
  insert into zsite_auth.mail_outbox (site_id, to_email, kind, challenge_id)
  values (p_site, p_email, 'verify_signup', p_challenge);
end $$;

create or replace function zsite_auth.signup_confirm_begin(
  p_site uuid, p_token_sha text, p_lease_seconds integer,
  out outcome text, out auth_user_id uuid, out email_norm text, out alias text
) language plpgsql security definer set search_path = '' as $$
declare c zsite_auth.signup_challenges; s zsite_auth.signups;
begin
  if p_lease_seconds not between 5 and 600 then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  select * into c from zsite_auth.signup_challenges x where x.token_sha256 = p_token_sha;
  if not found then
    select r.auth_user_id, r.alias into auth_user_id, alias from zsite_auth.signup_receipts r
     where r.token_sha256 = p_token_sha and r.site_id = p_site and r.expires_at > pg_catalog.now();
    outcome := case when found then 'done' else 'invalid' end;
    return;
  end if;
  if c.site_id is distinct from p_site then outcome := 'invalid'; return; end if;
  select * into s from zsite_auth.signups x where x.site_id = c.site_id and x.email_norm = c.email_norm for update;
  if not found or s.state = 'quarantined' then outcome := 'invalid'; return; end if;
  if c.expires_at <= pg_catalog.now() then outcome := 'expired'; return; end if;
  if exists (select 1 from zsite.identities i where i.site_id = s.site_id and i.email_norm = s.email_norm
              and not (i.state = 'pending' or (i.state = 'unverified' and i.auth_user_id = s.auth_user_id))) then
    outcome := 'invalid'; return;
  end if;
  if s.state = 'creating' and s.lease_sha is distinct from p_token_sha and s.lease_until > pg_catalog.now() then
    outcome := 'busy'; return;
  end if;
  update zsite_auth.signups x
     set state = 'creating', lease_sha = p_token_sha,
         lease_until = pg_catalog.now() + make_interval(secs => p_lease_seconds)
   where x.site_id = s.site_id and x.email_norm = s.email_norm;
  outcome := 'ok'; auth_user_id := s.auth_user_id; email_norm := s.email_norm; alias := s.alias;
end $$;

create or replace function zsite_auth.signup_confirm_release(p_site uuid, p_token_sha text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update zsite_auth.signups s set state = 'pending', lease_sha = null, lease_until = null
   where s.site_id = p_site and s.state = 'creating' and s.lease_sha = p_token_sha;
  return found;
end $$;

create or replace function zsite_auth.signup_quarantine(p_site uuid, p_token_sha text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update zsite_auth.signups s set state = 'quarantined', lease_until = null
   where s.site_id = p_site and s.state = 'creating' and s.lease_sha = p_token_sha;
  return found;
end $$;

create or replace function zsite_auth.signup_confirm_finish(p_site uuid, p_token_sha text) returns text
language plpgsql security definer set search_path = '' as $$
declare s zsite_auth.signups;
begin
  select * into s from zsite_auth.signups x
   where x.site_id = p_site and x.state = 'creating' and x.lease_sha = p_token_sha for update;
  if not found then
    return case when exists (select 1 from zsite_auth.signup_receipts r
                              where r.token_sha256 = p_token_sha and r.site_id = p_site and r.expires_at > pg_catalog.now())
                then 'done' else 'invalid' end;
  end if;
  update zsite.identities i set auth_user_id = s.auth_user_id, alias = s.alias, state = 'active', updated_at = pg_catalog.now()
   where i.site_id = s.site_id and i.email_norm = s.email_norm
     and (i.state = 'pending' or (i.state = 'unverified' and i.auth_user_id = s.auth_user_id));
  if not found then
    insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state)
    values (s.site_id, s.email_norm, s.auth_user_id, s.alias, 'active')
    on conflict do nothing;
  end if;
  if not found then
    update zsite_auth.signups x set state = 'quarantined', lease_until = null
     where x.site_id = s.site_id and x.email_norm = s.email_norm;
    return 'conflict';
  end if;
  insert into zsite.members (site_id, user_id, role, status) values (s.site_id, s.auth_user_id, 'user', 'active')
  on conflict (site_id, user_id) do nothing;
  insert into zsite_auth.signup_receipts (token_sha256, site_id, auth_user_id, alias, expires_at)
  values (p_token_sha, s.site_id, s.auth_user_id, s.alias, pg_catalog.now() + interval '10 minutes')
  on conflict (token_sha256) do nothing;
  delete from zsite_auth.signups x where x.site_id = s.site_id and x.email_norm = s.email_norm;
  return 'ok';
end $$;

create or replace function zsite_auth.signup_purge(p_limit integer)
returns table (site_id uuid, auth_user_id uuid, alias text)
language plpgsql security definer set search_path = '' as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
begin
  delete from zsite_auth.signup_challenges c
   where c.id in (select x.id from zsite_auth.signup_challenges x
                   where x.expires_at <= pg_catalog.now() limit v_lim);
  delete from zsite_auth.signup_receipts r
   where r.token_sha256 in (select x.token_sha256 from zsite_auth.signup_receipts x
                             where x.expires_at <= pg_catalog.now() limit v_lim);
  delete from zsite_auth.mail_outbox o
   where o.id in (select x.id from zsite_auth.mail_outbox x
                   where x.attempts >= 5 or x.created_at < pg_catalog.now() - interval '1 day'
                      or (x.kind = 'verify_signup' and not exists (
                            select 1 from zsite_auth.signup_challenges c where c.id = x.challenge_id))
                   limit v_lim);
  return query
    with gone as (
      delete from zsite_auth.signups s
       where (s.site_id, s.email_norm) in (
               select x.site_id, x.email_norm from zsite_auth.signups x
                where x.expires_at <= pg_catalog.now()
                  and (x.lease_until is null or x.lease_until <= pg_catalog.now())
                  and not exists (select 1 from zsite_auth.signup_challenges c
                                   where c.site_id = x.site_id and c.email_norm = x.email_norm)
                limit v_lim)
      returning s.site_id, s.auth_user_id, s.alias, s.state)
    select g.site_id, g.auth_user_id, g.alias from gone g where g.state = 'creating';
end $$;

create or replace function zsite_auth.outbox_claim(p_limit integer, p_lease_seconds integer)
returns table (id bigint, site_id uuid, to_email text, kind text, challenge_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    with picked as (
      select o.id from zsite_auth.mail_outbox o
       where (o.lease_until is null or o.lease_until <= pg_catalog.now()) and o.attempts < 5
         and (o.kind <> 'verify_signup' or exists (
               select 1 from zsite_auth.signup_challenges c
                where c.id = o.challenge_id and c.expires_at > pg_catalog.now()))
       order by o.id
       limit least(greatest(coalesce(p_limit, 10), 1), 100)
       for update skip locked)
    update zsite_auth.mail_outbox o
       set lease_until = pg_catalog.now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 600)),
           attempts = o.attempts + 1
      from picked where o.id = picked.id
    returning o.id, o.site_id, o.to_email, o.kind, o.challenge_id;
end $$;

create or replace function zsite_auth.outbox_defer(p_id bigint, p_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update zsite_auth.mail_outbox o
     set lease_until = pg_catalog.now() + make_interval(secs => least(greatest(p_seconds, 1), 86400)),
         attempts = greatest(o.attempts - 1, 0)
   where o.id = p_id;
  return found;
end $$;

create or replace function zsite_auth.outbox_done(p_id bigint) returns boolean
language sql security definer set search_path = '' as $$
  with d as (delete from zsite_auth.mail_outbox o where o.id = p_id returning 1)
  select exists (select 1 from d)
$$;

create or replace function zsite_auth.provision_identity(
  p_site uuid, p_email text, p_alias text, p_uid uuid,
  out outcome text, out auth_user_id uuid, out state text
) language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  perform zsite_auth.assert_email(p_email);
  perform 1 from zsite.sites x where x.site_id = p_site and x.status = 'active';
  if not found then outcome := 'site_unavailable'; return; end if;
  select i.auth_user_id, i.state into auth_user_id, state
    from zsite.identities i where i.site_id = p_site and i.email_norm = p_email for update;
  if found then outcome := 'exists'; return; end if;
  if exists (select 1 from zsite_auth.email_changes c
              where c.site_id = p_site and c.new_email_norm = p_email and c.state in ('pending', 'committing')) then
    outcome := 'reserved'; return;
  end if;
  select s.auth_user_id into v_uid from zsite_auth.signups s
   where s.site_id = p_site and s.email_norm = p_email for update;
  v_uid := coalesce(v_uid, p_uid);
  delete from zsite_auth.signups s where s.site_id = p_site and s.email_norm = p_email;
  insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state)
  values (p_site, p_email, v_uid, lower(p_alias), 'unverified');
  insert into zsite.members (site_id, user_id, role, status) values (p_site, v_uid, 'user', 'active');
  outcome := 'created'; auth_user_id := v_uid; state := 'unverified';
end $$;

create or replace function zsite_auth.identity_by_user_v2(
  p_uid uuid,
  out site_id uuid, out email_norm text, out alias text, out state text, out role text,
  out member_status text, out sessions_valid_after timestamptz
) returns setof record language sql stable security definer set search_path = '' as $$
  select i.site_id, i.email_norm, i.alias, i.state, m.role, m.status, e.valid_after
    from zsite.identities i
    left join zsite.members m on m.site_id = i.site_id and m.user_id = i.auth_user_id
    left join zsite_auth.session_epochs e on e.site_id = i.site_id and e.user_id = i.auth_user_id
   where i.auth_user_id = p_uid
$$;

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
  perform zsite_auth.bump_sessions(c.site_id, c.auth_user_id);
  old_email_norm := c.old_email_norm; new_email_norm := c.new_email_norm;
end $$;

drop function if exists zsite_auth.reserve_signup(uuid, text, text, uuid);
drop function if exists zsite_auth.abort_signup(uuid, uuid);
drop function if exists zsite_auth.activate_identity(uuid, uuid);

create or replace function zsite_auth.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims  jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_uid     uuid;
  v_site    uuid;
  v_role    text;
  v_started numeric;
  v_after   timestamptz;
  v_deny    jsonb := jsonb_build_object('error', jsonb_build_object(
                       'http_code', 403, 'message', 'account_not_available_on_this_site'));
begin
  if not zsite.is_uuid(event->>'user_id') then
    return v_deny;
  end if;
  v_uid := (event->>'user_id')::uuid;

  if jsonb_typeof(v_claims) <> 'object'
     or (v_claims->>'role') is distinct from 'authenticated'
     or coalesce((v_claims->>'is_anonymous')::boolean, false)
     or (v_claims ? 'sub' and (v_claims->>'sub') is distinct from v_uid::text) then
    return v_deny;
  end if;

  select i.site_id, m.role
    into v_site, v_role
    from zsite.identities i
    join zsite.members m on m.site_id = i.site_id and m.user_id = i.auth_user_id
    join zsite.sites s   on s.site_id = i.site_id
    join auth.users u    on u.id = i.auth_user_id
   where i.auth_user_id = v_uid
     and s.status = 'active'
     and m.status = 'active'
     and coalesce(u.is_anonymous, false) = false
     and i.state in ('active', 'email_change_pending');
  if not found then
    return v_deny;
  end if;

  if zsite.is_uuid(v_claims->>'session_id') then
    begin
      execute 'select extract(epoch from s.created_at) from auth.sessions s where s.id = $1 and s.user_id = $2'
        into v_started using (v_claims->>'session_id')::uuid, v_uid;
    exception when undefined_table or undefined_column or insufficient_privilege then
      v_started := null;
    end;
  end if;
  if v_started is null and jsonb_typeof(v_claims->'amr') = 'array' then
    select min((a->>'timestamp')::numeric) into v_started
      from jsonb_array_elements(v_claims->'amr') a
     where jsonb_typeof(a->'timestamp') = 'number';
  end if;
  if v_started is null then
    return v_deny;
  end if;
  select e.valid_after into v_after from zsite_auth.session_epochs e where e.site_id = v_site and e.user_id = v_uid;
  if v_after is not null and v_started < extract(epoch from v_after) then
    return v_deny;
  end if;

  v_claims := v_claims - 'site_id' - 'site_role' - 'session_started_at'
              || jsonb_build_object('site_id', v_site::text, 'site_role', v_role, 'session_started_at', v_started);
  return jsonb_build_object('claims', v_claims);
end $$;

create or replace function api.session_valid() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb; v_after timestamptz;
begin
  begin
    c := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return false;
  end;
  if c is null or (c->>'role') is distinct from 'authenticated'
     or not zsite.is_uuid(c->>'site_id') or not zsite.is_uuid(c->>'sub')
     or jsonb_typeof(c->'session_started_at') is distinct from 'number' then
    return false;
  end if;
  select e.valid_after into v_after from zsite_auth.session_epochs e
   where e.site_id = (c->>'site_id')::uuid and e.user_id = (c->>'sub')::uuid;
  return v_after is null or (c->>'session_started_at')::numeric >= extract(epoch from v_after);
end $$;

create or replace function api.session_valid_for(p_sub uuid, p_started numeric) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_site uuid := zsite.request_site(); v_after timestamptz;
begin
  if v_site is null or p_sub is null or p_started is null then return false; end if;
  if not exists (select 1 from zsite.members m
                   join zsite.identities i on i.site_id = m.site_id and i.auth_user_id = m.user_id
                  where m.site_id = v_site and m.user_id = p_sub and m.status = 'active'
                    and i.state in ('active', 'email_change_pending')) then
    return false;
  end if;
  select e.valid_after into v_after from zsite_auth.session_epochs e where e.site_id = v_site and e.user_id = p_sub;
  return v_after is null or p_started >= extract(epoch from v_after);
end $$;

create or replace function api.site_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select zsite.request_site() is not null
$$;

revoke all on all functions in schema zsite_auth from public, anon, authenticated, service_role;
grant execute on function
  zsite_auth.signup_request(uuid, text, text, uuid, uuid, text, integer, integer, integer),
  zsite_auth.signup_confirm_begin(uuid, text, integer),
  zsite_auth.signup_confirm_release(uuid, text),
  zsite_auth.signup_quarantine(uuid, text),
  zsite_auth.signup_confirm_finish(uuid, text),
  zsite_auth.signup_purge(integer),
  zsite_auth.outbox_claim(integer, integer),
  zsite_auth.outbox_done(bigint),
  zsite_auth.outbox_defer(bigint, integer),
  zsite_auth.provision_identity(uuid, text, text, uuid),
  zsite_auth.identity_by_user_v2(uuid),
  zsite_auth.commit_email_change(uuid)
  to zsite_broker;
revoke execute on function zsite_auth.custom_access_token_hook(jsonb) from zsite_broker;
grant execute on function zsite_auth.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke all on function api.session_valid() from public;
grant execute on function api.session_valid() to anon, authenticated;
revoke all on function api.session_valid_for(uuid, numeric) from public;
grant execute on function api.session_valid_for(uuid, numeric) to anon, authenticated;
revoke all on function api.site_active() from public;
grant execute on function api.site_active() to anon, authenticated;

insert into zsite.migrations (version) values ('1004_signup_sessions') on conflict do nothing;

commit;
