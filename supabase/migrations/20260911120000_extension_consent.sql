
begin;

create table if not exists extension_consent (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 64),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

comment on table extension_consent is
  'Per-person consent for the Zavi Chrome extension to send the page they are looking at. No current row = the extension never sends page content at all, so nothing page-derived is stored for anyone (staff included) to read later.';

alter table extension_consent enable row level security;

drop policy if exists extension_consent_self_select on extension_consent;
create policy extension_consent_self_select on extension_consent
  for select
  using (
    user_id = auth.uid()
    and exists (
      select 1 from tenant_users tu
      where tu.tenant_id = extension_consent.tenant_id
        and tu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on extension_consent from anon, authenticated;
grant select on extension_consent to authenticated;

create or replace function grant_extension_consent(
  p_tenant_id uuid,
  p_user_id uuid,
  p_version text
) returns extension_consent
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row extension_consent;
begin
  if p_tenant_id is null then
    raise exception 'tenant_id required' using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if nullif(trim(p_version), '') is null then
    raise exception 'version required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from tenant_users tu
    where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id
  ) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  insert into extension_consent (tenant_id, user_id, version, granted_at, revoked_at, updated_at)
  values (p_tenant_id, p_user_id, trim(p_version), now(), null, now())
  on conflict (tenant_id, user_id) do update
    set version = excluded.version,
        granted_at = excluded.granted_at,
        revoked_at = null,
        updated_at = now()
  returning * into v_row;

  return v_row;
end $$;

revoke all on function grant_extension_consent(uuid, uuid, text) from public, anon, authenticated;
grant execute on function grant_extension_consent(uuid, uuid, text) to service_role;

comment on function grant_extension_consent(uuid, uuid, text) is
  'Records one person''s consent for the Chrome extension to send page content, at a named consent-text version. Idempotent; a re-grant clears any prior revocation.';

create or replace function revoke_extension_consent(
  p_tenant_id uuid,
  p_user_id uuid
) returns extension_consent
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row extension_consent;
begin
  if p_tenant_id is null then
    raise exception 'tenant_id required' using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;

  update extension_consent
  set revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  where tenant_id = p_tenant_id
    and user_id = p_user_id
  returning * into v_row;

  return v_row;
end $$;

revoke all on function revoke_extension_consent(uuid, uuid) from public, anon, authenticated;
grant execute on function revoke_extension_consent(uuid, uuid) to service_role;

comment on function revoke_extension_consent(uuid, uuid) is
  'Withdraws one person''s Chrome-extension page-reading consent. Idempotent, and a no-op (not an error) when nothing was granted. The caller must ALSO strip already-stored page context for the tenant — revocation is not complete without it.';

commit;
