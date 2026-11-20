
create or replace function update_tenant_notification_settings(
  p_notification_email text,
  p_timezone text,
  p_digest_frequency text
) returns tenants
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row tenants;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;

  if p_digest_frequency not in ('off', 'daily') then
    raise exception 'invalid digest_frequency: %, must be off|daily', p_digest_frequency
      using errcode = '22023';
  end if;

  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'invalid timezone: %', p_timezone using errcode = '22023';
  end if;

  update tenants
    set notification_email = nullif(trim(p_notification_email), ''),
        timezone           = p_timezone,
        digest_frequency   = p_digest_frequency
    where id = v_tenant
    returning * into v_row;

  return v_row;
end $$;

revoke all on function update_tenant_notification_settings(text, text, text) from public;
grant execute on function update_tenant_notification_settings(text, text, text) to authenticated;

create or replace function get_tenant_notification_settings()
returns table (
  notification_email text,
  timezone text,
  digest_frequency text,
  last_sent_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;

  return query
    select t.notification_email,
           t.timezone,
           t.digest_frequency,
           (select max(updated_at) from tenant_brief_dispatches
              where tenant_id = v_tenant
                and surface = 'email'
                and outcome = 'sent') as last_sent_at
      from tenants t
      where t.id = v_tenant;
end $$;

revoke all on function get_tenant_notification_settings() from public;
grant execute on function get_tenant_notification_settings() to authenticated;
