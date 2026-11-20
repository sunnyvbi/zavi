
create table user_prefs (
  user_id   uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  prefs     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

alter table user_prefs enable row level security;

create policy user_prefs_self_select on user_prefs
  for select using (user_id = auth.uid());

create or replace function get_user_prefs()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_prefs jsonb;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
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

  select p.prefs into v_prefs
  from user_prefs p
  where p.user_id = v_user_id and p.tenant_id = v_tenant_id;

  return coalesce(v_prefs, '{}'::jsonb);
end;
$$;

revoke all on function get_user_prefs() from public;
grant execute on function get_user_prefs() to authenticated;

comment on function get_user_prefs() is
  'Returns the calling user''s UI prefs blob for their active tenant, or ''{}''. Powers the workspace threaded-view layout restore.';

create or replace function set_user_pref(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_num numeric;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
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

  if p_key is null or p_key not in ('viewMode', 'paneWidthPct') then
    raise exception 'unknown pref key: %', coalesce(p_key, '<null>')
      using errcode = '22023';
  end if;

  if p_key = 'viewMode' then
    if jsonb_typeof(p_value) <> 'string'
       or (p_value #>> '{}') not in ('chat', 'threaded') then
      raise exception 'viewMode must be one of ''chat'', ''threaded'''
        using errcode = '22023';
    end if;
  elsif p_key = 'paneWidthPct' then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception 'paneWidthPct must be a number' using errcode = '22023';
    end if;
    v_num := (p_value #>> '{}')::numeric;
    if v_num < 20 or v_num > 80 then
      raise exception 'paneWidthPct must be between 20 and 80 (percent)'
        using errcode = '22023';
    end if;
  end if;

  insert into user_prefs (user_id, tenant_id, prefs, updated_at)
  values (v_user_id, v_tenant_id, jsonb_build_object(p_key, p_value), now())
  on conflict (user_id, tenant_id) do update
    set prefs = user_prefs.prefs || excluded.prefs,
        updated_at = now();
end;
$$;

revoke all on function set_user_pref(text, jsonb) from public;
grant execute on function set_user_pref(text, jsonb) to authenticated;

comment on function set_user_pref(text, jsonb) is
  'Sets ONE allowlisted UI pref key (viewMode | paneWidthPct) for the calling user''s active tenant. Merges into the existing blob so setting one key never wipes the other.';
