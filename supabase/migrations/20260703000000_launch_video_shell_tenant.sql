
begin;

alter table public.tenants drop constraint if exists tenants_kind_check;
alter table public.tenants drop constraint if exists tenants_kind_allowed;
alter table public.tenants
  add constraint tenants_kind_allowed
  check (kind in ('real', 'test', 'launch_video_shell'));

comment on column public.tenants.kind is
  'Deletion/lifecycle class. ''real'' (protected) · ''test'' (QA/build throwaway, deletable) · ''launch_video_shell'' (pre-provisioned public /launch-video tenant, ownerless + inert until claimed, deletable). Delete guard blocks deleting ''real''.';

create or replace function tenant_delete_guard()
returns trigger language plpgsql as $$
begin
  if old.kind is distinct from 'test' and old.kind is distinct from 'launch_video_shell' then
    raise exception
      'tenant % (kind=%) is protected: only kind=''test'' or ''launch_video_shell'' tenants may be deleted. To remove a real tenant, first run UPDATE tenants SET kind=''test'' WHERE id=''%'' deliberately, then delete.',
      old.slug, coalesce(old.kind, 'real'), old.id
      using errcode = '2BP01';
  end if;
  return old;
end $$;

create or replace function create_launch_video_shell_tenant(
  p_slug text,
  p_display_name text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_slug text;
begin
  v_slug := left(coalesce(nullif(trim(p_slug), ''), 'launch'), 48) || '-' || substr(md5(random()::text), 1, 6);
  insert into tenants (slug, display_name, kind)
  values (v_slug, coalesce(nullif(trim(p_display_name), ''), 'Launch video'), 'launch_video_shell')
  returning id into v_tenant_id;
  return v_tenant_id;
end $$;

create or replace function claim_launch_video_tenant(
  p_user_id uuid,
  p_tenant_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_existing uuid;
begin
  select kind into v_kind from tenants where id = p_tenant_id for update;
  if v_kind is null or v_kind <> 'launch_video_shell' then
    return 'not_shell';
  end if;

  select active_tenant_id into v_existing from profiles where user_id = p_user_id;
  if v_existing is not null then
    return 'user_has_tenant';
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (p_user_id, p_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (p_user_id, p_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  update tenants set kind = 'real' where id = p_tenant_id;

  return 'claimed';
end $$;

revoke all on function create_launch_video_shell_tenant(text, text) from public, anon, authenticated;
revoke all on function claim_launch_video_tenant(uuid, uuid) from public, anon, authenticated;
grant execute on function create_launch_video_shell_tenant(text, text) to service_role;
grant execute on function claim_launch_video_tenant(uuid, uuid) to service_role;

commit;
