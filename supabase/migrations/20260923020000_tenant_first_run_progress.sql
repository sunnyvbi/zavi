
create table if not exists tenant_first_run_progress (
  tenant_id      uuid primary key references tenants(id) on delete cascade,
  plan_opened_at timestamptz,
  asked          jsonb not null default '{}'::jsonb,
  made           jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

alter table tenant_first_run_progress enable row level security;

create policy tenant_first_run_progress_member_select on tenant_first_run_progress
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_first_run_progress.tenant_id
    )
  );
create policy tenant_first_run_progress_active_tenant_restrict
  on tenant_first_run_progress as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke all on table tenant_first_run_progress from anon;
revoke all on table tenant_first_run_progress from authenticated;
grant select on table tenant_first_run_progress to authenticated;

create or replace function mark_first_run_progress(p_tenant_id uuid, p_kind text, p_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
  v_existing  jsonb;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  v_tenant_id := p_tenant_id;
  if v_tenant_id is null then
    raise exception 'tenant required';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;

  if p_kind is null or p_kind not in ('plan_opened', 'asked', 'made') then
    raise exception 'invalid kind';
  end if;

  if p_kind = 'plan_opened' then
    insert into tenant_first_run_progress (tenant_id, plan_opened_at, updated_at)
    values (v_tenant_id, now(), now())
    on conflict (tenant_id) do update
      set plan_opened_at = coalesce(tenant_first_run_progress.plan_opened_at, now()),
          updated_at     = now();
    return;
  end if;

  if p_key is null or length(p_key) = 0 or length(p_key) > 300 then
    raise exception 'invalid key';
  end if;

  insert into tenant_first_run_progress (tenant_id)
  values (v_tenant_id)
  on conflict (tenant_id) do nothing;

  select case when p_kind = 'asked' then asked else made end
    into v_existing
  from tenant_first_run_progress
  where tenant_id = v_tenant_id
  for update;

  if not (v_existing ? p_key)
     and (select count(*) from jsonb_object_keys(v_existing)) >= 20 then
    raise exception 'too many keys';
  end if;

  if p_kind = 'asked' then
    update tenant_first_run_progress
       set asked = asked || jsonb_build_object(p_key, now()),
           updated_at = now()
     where tenant_id = v_tenant_id;
  else
    update tenant_first_run_progress
       set made = made || jsonb_build_object(p_key, now()),
           updated_at = now()
     where tenant_id = v_tenant_id;
  end if;
end;
$$;

revoke all on function mark_first_run_progress(uuid, text, text) from public;
revoke all on function mark_first_run_progress(uuid, text, text) from anon;
grant execute on function mark_first_run_progress(uuid, text, text) to authenticated;

comment on function mark_first_run_progress(uuid, text, text) is
  'Records a Home next-tile first-run step (plan_opened | asked | made) for the caller''s active tenant. Tenant passed by the route (requireAuth resolution) and checked against the caller''s tenant_users membership.';
