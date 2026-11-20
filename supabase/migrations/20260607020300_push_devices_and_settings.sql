
begin;

create table if not exists devices (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants(id) on delete cascade,
  user_id         uuid        not null,
  expo_push_token text        not null,
  platform        text        not null check (platform in ('ios', 'android')),
  created_at      timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

create index if not exists devices_tenant_idx on devices (tenant_id);
create index if not exists devices_user_idx on devices (user_id);

alter table devices enable row level security;

create policy devices_self_member_select on devices
  for select using (
    user_id = auth.uid()
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = devices.tenant_id
    )
  );

create policy devices_self_member_delete on devices
  for delete using (
    user_id = auth.uid()
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = devices.tenant_id
    )
  );

revoke all on devices from public;

create table if not exists notification_settings (
  tenant_id     uuid        not null references tenants(id) on delete cascade,
  user_id       uuid        not null,
  agent_replies boolean     not null default true,
  approvals     boolean     not null default true,
  daily_brief   boolean     not null default false,
  primary key (tenant_id, user_id)
);

alter table notification_settings enable row level security;

create policy notification_settings_self_member_select on notification_settings
  for select using (
    user_id = auth.uid()
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = notification_settings.tenant_id
    )
  );

revoke all on notification_settings from public;

create or replace function upsert_device(
  p_expo_push_token text,
  p_platform        text
) returns uuid
language plpgsql security definer set search_path = public as $$
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

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
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
  on conflict (user_id, expo_push_token) do update
    set tenant_id = excluded.tenant_id,
        platform  = excluded.platform
  returning id into v_id;

  return v_id;
end $$;
revoke all on function upsert_device(text, text) from public;
grant execute on function upsert_device(text, text) to authenticated;

create or replace function upsert_notification_settings(
  p_agent_replies boolean,
  p_approvals     boolean,
  p_daily_brief   boolean
) returns table (agent_replies boolean, approvals boolean, daily_brief boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  insert into notification_settings (
    tenant_id, user_id, agent_replies, approvals, daily_brief
  ) values (
    v_tenant_id, v_user_id,
    coalesce(p_agent_replies, true),
    coalesce(p_approvals, true),
    coalesce(p_daily_brief, false)
  )
  on conflict (tenant_id, user_id) do update set
    agent_replies = coalesce(p_agent_replies, notification_settings.agent_replies),
    approvals     = coalesce(p_approvals,     notification_settings.approvals),
    daily_brief   = coalesce(p_daily_brief,   notification_settings.daily_brief);

  return query
    select ns.agent_replies, ns.approvals, ns.daily_brief
    from notification_settings ns
    where ns.tenant_id = v_tenant_id and ns.user_id = v_user_id;
end $$;
revoke all on function upsert_notification_settings(boolean, boolean, boolean) from public;
grant execute on function upsert_notification_settings(boolean, boolean, boolean) to authenticated;

update system_config
set blob = jsonb_set(
      coalesce(blob, '{}'::jsonb),
      '{push_notifications_enabled}',
      coalesce(blob->'push_notifications_enabled', 'false'::jsonb)
    ),
    updated_at = now()
where id = 1;

commit;
