
begin;

create table if not exists repo_profiles (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  repo_full_name   text not null,
  kind             text,
  language_stats   jsonb not null default '{}'::jsonb,
  frameworks       text[] not null default '{}',
  topics           text[] not null default '{}',
  description      text,
  default_branch   text,
  manifest_paths   text[] not null default '{}',
  fingerprint      text,
  profile_status   text not null default 'pending',
  last_error       text,
  retry_after      timestamptz,
  built_at         timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, repo_full_name)
);

alter table repo_profiles enable row level security;

drop policy if exists repo_profiles_select on repo_profiles;
create policy repo_profiles_select on repo_profiles for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

create or replace function upsert_repo_profile(
  p_tenant_id      uuid,
  p_repo_full_name text,
  p_kind           text default null,
  p_language_stats jsonb default '{}'::jsonb,
  p_frameworks     text[] default '{}',
  p_topics         text[] default '{}',
  p_description    text default null,
  p_default_branch text default null,
  p_manifest_paths text[] default '{}',
  p_fingerprint    text default null,
  p_profile_status text default 'pending',
  p_last_error     text default null,
  p_retry_after    timestamptz default null,
  p_built_at       timestamptz default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_repo_full_name is null or length(trim(p_repo_full_name)) = 0 then
    raise exception 'upsert_repo_profile: tenant_id and repo_full_name are required'
      using errcode = '22023';
  end if;

  insert into repo_profiles (
    tenant_id, repo_full_name, kind, language_stats, frameworks, topics,
    description, default_branch, manifest_paths, fingerprint, profile_status,
    last_error, retry_after, built_at, updated_at
  )
  values (
    p_tenant_id, p_repo_full_name, p_kind, coalesce(p_language_stats, '{}'::jsonb),
    coalesce(p_frameworks, '{}'), coalesce(p_topics, '{}'), p_description,
    p_default_branch, coalesce(p_manifest_paths, '{}'), p_fingerprint,
    coalesce(p_profile_status, 'pending'), p_last_error, p_retry_after,
    p_built_at, now()
  )
  on conflict (tenant_id, repo_full_name) do update set
    kind           = excluded.kind,
    language_stats = excluded.language_stats,
    frameworks     = excluded.frameworks,
    topics         = excluded.topics,
    description    = excluded.description,
    default_branch = excluded.default_branch,
    manifest_paths = excluded.manifest_paths,
    fingerprint    = excluded.fingerprint,
    profile_status = excluded.profile_status,
    last_error     = excluded.last_error,
    retry_after    = excluded.retry_after,
    built_at       = excluded.built_at,
    updated_at     = now();
end $$;

revoke all on function upsert_repo_profile(uuid, text, text, jsonb, text[], text[], text, text, text[], text, text, text, timestamptz, timestamptz) from public;
grant execute on function upsert_repo_profile(uuid, text, text, jsonb, text[], text[], text, text, text[], text, text, text, timestamptz, timestamptz) to service_role;

create or replace function seed_repo_profile_pending(
  p_tenant_id      uuid,
  p_repo_full_name text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_repo_full_name is null or length(trim(p_repo_full_name)) = 0 then
    raise exception 'seed_repo_profile_pending: tenant_id and repo_full_name are required'
      using errcode = '22023';
  end if;

  insert into repo_profiles (tenant_id, repo_full_name, profile_status, updated_at)
  values (p_tenant_id, p_repo_full_name, 'pending', now())
  on conflict (tenant_id, repo_full_name) do nothing;
end $$;

revoke all on function seed_repo_profile_pending(uuid, text) from public;
grant execute on function seed_repo_profile_pending(uuid, text) to service_role;

commit;
