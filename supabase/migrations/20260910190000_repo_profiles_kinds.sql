
alter table repo_profiles
  add column if not exists kinds text[] not null default '{}';

comment on column repo_profiles.kinds is
  'Every surface this repo exposes (ios/android/web/backend/unknown). A monorepo carries several. `kind` remains the single dominant kind for legacy readers.';

update repo_profiles
   set kinds = array[kind]
 where kinds = '{}'
   and kind is not null;

drop function if exists upsert_repo_profile(
  uuid, text, text, jsonb, text[], text[], text, text, text[], text, text, text, timestamptz, timestamptz
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
  p_built_at       timestamptz default null,
  p_kinds          text[] default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_repo_full_name is null or length(trim(p_repo_full_name)) = 0 then
    raise exception 'upsert_repo_profile: tenant_id and repo_full_name are required'
      using errcode = '22023';
  end if;

  insert into repo_profiles (
    tenant_id, repo_full_name, kind, kinds, language_stats, frameworks, topics,
    description, default_branch, manifest_paths, fingerprint, profile_status,
    last_error, retry_after, built_at, updated_at
  )
  values (
    p_tenant_id, p_repo_full_name, p_kind,
    coalesce(p_kinds, case when p_kind is null then '{}'::text[] else array[p_kind] end),
    coalesce(p_language_stats, '{}'::jsonb),
    coalesce(p_frameworks, '{}'), coalesce(p_topics, '{}'), p_description,
    p_default_branch, coalesce(p_manifest_paths, '{}'), p_fingerprint,
    coalesce(p_profile_status, 'pending'), p_last_error, p_retry_after,
    p_built_at, now()
  )
  on conflict (tenant_id, repo_full_name) do update set
    kind           = excluded.kind,
    kinds          = case
                       when p_kinds is not null then excluded.kinds
                       when p_kind  is not null then array[p_kind]
                       else repo_profiles.kinds
                     end,
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

revoke all on function upsert_repo_profile(uuid, text, text, jsonb, text[], text[], text, text, text[], text, text, text, timestamptz, timestamptz, text[]) from public;
grant execute on function upsert_repo_profile(uuid, text, text, jsonb, text[], text[], text, text, text[], text, text, text, timestamptz, timestamptz, text[]) to service_role;
