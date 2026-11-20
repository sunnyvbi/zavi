
begin;

lock table devices in share row exclusive mode;

delete from devices
where expo_push_token in (
  select expo_push_token from devices group by expo_push_token having count(*) > 1
);

create unique index if not exists devices_expo_push_token_unique
  on devices (expo_push_token);

create or replace function upsert_device(
  p_expo_push_token text,
  p_platform        text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_id        uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_expo_push_token is null or char_length(p_expo_push_token) < 1
     or char_length(p_expo_push_token) > 512 then
    raise exception 'invalid expo_push_token' using errcode = '22023';
  end if;
  if p_platform not in ('ios', 'android') then
    raise exception 'invalid platform' using errcode = '22023';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  insert into devices (tenant_id, user_id, expo_push_token, platform)
  values (v_tenant_id, v_user_id, p_expo_push_token, p_platform)
  on conflict (expo_push_token) do update
    set tenant_id = excluded.tenant_id,
        user_id   = excluded.user_id,
        platform  = excluded.platform
  returning id into v_id;

  return v_id;
end $$;

revoke all on function upsert_device(text, text) from public, anon, authenticated;
grant execute on function upsert_device(text, text) to authenticated;

commit;
