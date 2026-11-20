
create table oauth_clients (
  client_id                   text primary key,
  client_name                 text,
  redirect_uris               text[] not null,
  grant_types                 text[] not null default '{authorization_code,refresh_token}',
  response_types              text[] not null default '{code}',
  scopes                      text[] not null default '{}',
  token_endpoint_auth_method  text not null default 'none',
  created_at                  timestamptz not null default now()
);
alter table oauth_clients enable row level security;

create table oauth_auth_codes (
  id             uuid primary key default gen_random_uuid(),
  code_hash      text not null,
  code_salt      text not null,
  code_prefix    text not null,
  client_id      text not null references oauth_clients(client_id) on delete cascade,
  user_id        uuid not null,
  tenant_id      uuid not null,
  redirect_uri   text not null,
  code_challenge text not null,
  scopes         text[] not null default '{}',
  resource       text not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index oauth_auth_codes_prefix_idx on oauth_auth_codes(code_prefix) where consumed_at is null;
alter table oauth_auth_codes enable row level security;

create table oauth_access_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null,
  token_salt    text not null,
  token_prefix  text not null,
  client_id     text not null references oauth_clients(client_id) on delete cascade,
  user_id       uuid not null,
  tenant_id     uuid not null,
  scopes        text[] not null default '{}',
  resource      text not null,
  family_id     uuid not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create unique index oauth_access_tokens_hash_uidx on oauth_access_tokens(token_hash);
create index oauth_access_tokens_prefix_idx on oauth_access_tokens(token_prefix) where revoked_at is null;
create index oauth_access_tokens_family_idx on oauth_access_tokens(family_id);
alter table oauth_access_tokens enable row level security;

create table oauth_refresh_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null,
  token_salt    text not null,
  token_prefix  text not null,
  client_id     text not null references oauth_clients(client_id) on delete cascade,
  user_id       uuid not null,
  tenant_id     uuid not null,
  scopes        text[] not null default '{}',
  resource      text not null,
  family_id     uuid not null,
  rotated_at    timestamptz,
  replaced_by   uuid references oauth_refresh_tokens(id),
  revoked_at    timestamptz,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create unique index oauth_refresh_tokens_hash_uidx on oauth_refresh_tokens(token_hash);
create index oauth_refresh_tokens_prefix_idx on oauth_refresh_tokens(token_prefix);
create index oauth_refresh_tokens_family_idx on oauth_refresh_tokens(family_id);
alter table oauth_refresh_tokens enable row level security;

create table oauth_consent_jti (
  jti        text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table oauth_consent_jti enable row level security;

alter table mcp_tool_calls alter column pat_id drop not null;
alter table mcp_tool_calls add column oauth_access_token_id uuid references oauth_access_tokens(id) on delete set null;
alter table mcp_tool_calls add column credential_kind text not null default 'pat';
alter table mcp_tool_calls
  add constraint mcp_tool_calls_one_credential
  check ((pat_id is not null)::int + (oauth_access_token_id is not null)::int = 1);
create index mcp_tool_calls_oat_idx on mcp_tool_calls(oauth_access_token_id, created_at desc)
  where oauth_access_token_id is not null;

create or replace function mint_oauth_code(
  p_code_hash      text,
  p_code_salt      text,
  p_code_prefix    text,
  p_client_id      text,
  p_user_id        uuid,
  p_tenant_id      uuid,
  p_redirect_uri   text,
  p_code_challenge text,
  p_scopes         text[],
  p_resource       text,
  p_ttl_seconds    int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into oauth_auth_codes(code_hash, code_salt, code_prefix, client_id,
    user_id, tenant_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  values (p_code_hash, p_code_salt, p_code_prefix, p_client_id, p_user_id,
    p_tenant_id, p_redirect_uri, p_code_challenge, coalesce(p_scopes, '{}'),
    p_resource, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return v_id;
end $$;

create or replace function consume_oauth_code(p_id uuid)
returns table(user_id uuid, tenant_id uuid, scopes text[], resource text,
              redirect_uri text, client_id text, code_challenge text)
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid; v_tenant uuid; v_scopes text[]; v_resource text;
  v_redirect text; v_client text; v_challenge text;
begin
  update oauth_auth_codes
     set consumed_at = now()
   where id = p_id
     and consumed_at is null
     and expires_at > now()
  returning oauth_auth_codes.user_id, oauth_auth_codes.tenant_id,
            oauth_auth_codes.scopes, oauth_auth_codes.resource,
            oauth_auth_codes.redirect_uri, oauth_auth_codes.client_id,
            oauth_auth_codes.code_challenge
    into v_user, v_tenant, v_scopes, v_resource, v_redirect, v_client, v_challenge;
  if not found then
    raise exception 'oauth_code_consumed_or_expired' using errcode = '42501';
  end if;
  return query select v_user, v_tenant, v_scopes, v_resource, v_redirect,
                      v_client, v_challenge;
end $$;

create or replace function mint_oauth_tokens(
  p_family_id      uuid,
  p_client_id      text,
  p_user_id        uuid,
  p_tenant_id      uuid,
  p_scopes         text[],
  p_resource       text,
  p_access_hash    text,
  p_access_salt    text,
  p_access_prefix  text,
  p_access_ttl     int,
  p_issue_refresh  boolean,
  p_refresh_hash   text,
  p_refresh_salt   text,
  p_refresh_prefix text,
  p_refresh_ttl    int
) returns table(access_id uuid, refresh_id uuid)
language plpgsql security definer set search_path = public as $$
declare v_access uuid; v_refresh uuid;
begin
  insert into oauth_access_tokens(token_hash, token_salt, token_prefix, client_id,
    user_id, tenant_id, scopes, resource, family_id, expires_at)
  values (p_access_hash, p_access_salt, p_access_prefix, p_client_id, p_user_id,
    p_tenant_id, coalesce(p_scopes,'{}'), p_resource, p_family_id,
    now() + make_interval(secs => p_access_ttl))
  returning id into v_access;

  if p_issue_refresh then
    insert into oauth_refresh_tokens(token_hash, token_salt, token_prefix, client_id,
      user_id, tenant_id, scopes, resource, family_id, expires_at)
    values (p_refresh_hash, p_refresh_salt, p_refresh_prefix, p_client_id, p_user_id,
      p_tenant_id, coalesce(p_scopes,'{}'), p_resource, p_family_id,
      now() + make_interval(secs => p_refresh_ttl))
    returning id into v_refresh;
  end if;

  return query select v_access, v_refresh;
end $$;

create or replace function rotate_oauth_refresh(
  p_old_id         uuid,
  p_access_hash    text,
  p_access_salt    text,
  p_access_prefix  text,
  p_access_ttl     int,
  p_refresh_hash   text,
  p_refresh_salt   text,
  p_refresh_prefix text,
  p_refresh_ttl    int
) returns table(access_id uuid, refresh_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_fam uuid; v_client text; v_user uuid; v_tenant uuid;
  v_scopes text[]; v_resource text; v_new_access uuid; v_new_refresh uuid;
begin
  update oauth_refresh_tokens
     set rotated_at = now()
   where id = p_old_id
     and rotated_at is null
     and revoked_at is null
     and expires_at > now()
  returning family_id, client_id, user_id, tenant_id, scopes, resource
    into v_fam, v_client, v_user, v_tenant, v_scopes, v_resource;

  if not found then
    select family_id into v_fam from oauth_refresh_tokens where id = p_old_id;
    if v_fam is not null then
      update oauth_refresh_tokens set revoked_at = now()
        where family_id = v_fam and revoked_at is null;
      update oauth_access_tokens set revoked_at = now()
        where family_id = v_fam and revoked_at is null;
    end if;
    raise exception 'oauth_refresh_reuse_detected' using errcode = '42501';
  end if;

  insert into oauth_access_tokens(token_hash, token_salt, token_prefix, client_id,
    user_id, tenant_id, scopes, resource, family_id, expires_at)
  values (p_access_hash, p_access_salt, p_access_prefix, v_client, v_user,
    v_tenant, v_scopes, v_resource, v_fam, now() + make_interval(secs => p_access_ttl))
  returning id into v_new_access;

  insert into oauth_refresh_tokens(token_hash, token_salt, token_prefix, client_id,
    user_id, tenant_id, scopes, resource, family_id, expires_at)
  values (p_refresh_hash, p_refresh_salt, p_refresh_prefix, v_client, v_user,
    v_tenant, v_scopes, v_resource, v_fam, now() + make_interval(secs => p_refresh_ttl))
  returning id into v_new_refresh;

  update oauth_refresh_tokens set replaced_by = v_new_refresh where id = p_old_id;

  return query select v_new_access, v_new_refresh;
end $$;

create or replace function revoke_oauth_family(p_family_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update oauth_refresh_tokens set revoked_at = now()
    where family_id = p_family_id and revoked_at is null;
  update oauth_access_tokens set revoked_at = now()
    where family_id = p_family_id and revoked_at is null;
end $$;

create or replace function revoke_oauth_token(p_token_prefix text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update oauth_access_tokens set revoked_at = now()
    where token_prefix = p_token_prefix and revoked_at is null;
  update oauth_refresh_tokens set revoked_at = now()
    where token_prefix = p_token_prefix and revoked_at is null;
end $$;

create or replace function consume_consent_jti(p_jti text, p_expires_at timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into oauth_consent_jti(jti, expires_at)
  values (p_jti, p_expires_at)
  on conflict (jti) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

revoke all on function mint_oauth_code(text,text,text,text,uuid,uuid,text,text,text[],text,int) from public, anon, authenticated;
grant execute on function mint_oauth_code(text,text,text,text,uuid,uuid,text,text,text[],text,int) to service_role;
revoke all on function consume_oauth_code(uuid) from public, anon, authenticated;
grant execute on function consume_oauth_code(uuid) to service_role;
revoke all on function mint_oauth_tokens(uuid,text,uuid,uuid,text[],text,text,text,text,int,boolean,text,text,text,int) from public, anon, authenticated;
grant execute on function mint_oauth_tokens(uuid,text,uuid,uuid,text[],text,text,text,text,int,boolean,text,text,text,int) to service_role;
revoke all on function rotate_oauth_refresh(uuid,text,text,text,int,text,text,text,int) from public, anon, authenticated;
grant execute on function rotate_oauth_refresh(uuid,text,text,text,int,text,text,text,int) to service_role;
revoke all on function revoke_oauth_family(uuid) from public, anon, authenticated;
grant execute on function revoke_oauth_family(uuid) to service_role;
revoke all on function revoke_oauth_token(text) from public, anon, authenticated;
grant execute on function revoke_oauth_token(text) to service_role;
revoke all on function consume_consent_jti(text,timestamptz) from public, anon, authenticated;
grant execute on function consume_consent_jti(text,timestamptz) to service_role;
