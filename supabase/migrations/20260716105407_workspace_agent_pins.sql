
create table workspace_agent_pins (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  pinned_slugs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

alter table workspace_agent_pins enable row level security;

create policy workspace_agent_pins_self_select on workspace_agent_pins
  for select using (user_id = auth.uid());

create or replace function set_agent_pins(p_slugs jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_elem jsonb;
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

  if jsonb_typeof(p_slugs) <> 'array' then
    raise exception 'p_slugs must be a json array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_slugs) > 30 then
    raise exception 'too many pins (max 30)' using errcode = '22023';
  end if;
  for v_elem in select * from jsonb_array_elements(p_slugs) loop
    if jsonb_typeof(v_elem) <> 'string'
       or length(v_elem #>> '{}') < 1
       or length(v_elem #>> '{}') > 128 then
      raise exception 'every pin must be a 1-128 char string'
        using errcode = '22023';
    end if;
  end loop;

  insert into workspace_agent_pins (user_id, tenant_id, pinned_slugs, updated_at)
  values (v_user_id, v_tenant_id, p_slugs, now())
  on conflict (user_id, tenant_id) do update
    set pinned_slugs = excluded.pinned_slugs,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function set_agent_pins(jsonb) from public;
grant execute on function set_agent_pins(jsonb) to authenticated;

comment on function set_agent_pins(jsonb) is
  'Upserts the calling user''s pinned agent slugs for their active tenant. Powers the sidebar Main-tab pin/unpin (Figma 1140:62656). Cap 30, elements 1-128 char strings.';
