
begin;

alter table tenant_first_run_progress
  add column if not exists setup_docs_at timestamptz,
  add column if not exists setup_docs_skipped boolean not null default false,
  add column if not exists setup_connectors_at timestamptz,
  add column if not exists setup_connectors_skipped boolean not null default false,
  add column if not exists setup_done_at timestamptz,
  add column if not exists setup_home_at timestamptz;

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

  if p_kind is null or p_kind not in (
    'plan_opened', 'asked', 'made',
    'setup_docs', 'setup_connectors', 'setup_done', 'setup_home'
  ) then
    raise exception 'invalid kind';
  end if;

  if p_kind like 'setup\_%' escape '\' and not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id and role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required';
  end if;

  if p_kind = 'plan_opened' then
    insert into tenant_first_run_progress (tenant_id, plan_opened_at, updated_at)
    values (v_tenant_id, now(), now())
    on conflict (tenant_id) do update
      set plan_opened_at = coalesce(tenant_first_run_progress.plan_opened_at, now()),
          updated_at     = now();
    return;
  end if;

  if p_kind in ('setup_docs', 'setup_connectors') then
    if p_key is null or p_key not in ('done', 'skipped') then
      raise exception 'invalid key';
    end if;
    insert into tenant_first_run_progress (tenant_id)
    values (v_tenant_id)
    on conflict (tenant_id) do nothing;
    if p_kind = 'setup_docs' then
      update tenant_first_run_progress
         set setup_docs_skipped = case when setup_docs_at is null then p_key = 'skipped' else setup_docs_skipped end,
             setup_docs_at = coalesce(setup_docs_at, now()),
             updated_at = now()
       where tenant_id = v_tenant_id;
    else
      update tenant_first_run_progress
         set setup_connectors_skipped = case when setup_connectors_at is null then p_key = 'skipped' else setup_connectors_skipped end,
             setup_connectors_at = coalesce(setup_connectors_at, now()),
             updated_at = now()
       where tenant_id = v_tenant_id;
    end if;
    return;
  end if;

  if p_kind = 'setup_done' then
    insert into tenant_first_run_progress (tenant_id, setup_done_at, updated_at)
    values (v_tenant_id, now(), now())
    on conflict (tenant_id) do update
      set setup_done_at = coalesce(tenant_first_run_progress.setup_done_at, now()),
          updated_at    = now();
    return;
  end if;

  if p_kind = 'setup_home' then
    insert into tenant_first_run_progress (tenant_id, setup_home_at, updated_at)
    values (v_tenant_id, now(), now())
    on conflict (tenant_id) do update
      set setup_home_at = coalesce(tenant_first_run_progress.setup_home_at, now()),
          updated_at    = now();
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

revoke all on function mark_first_run_progress(uuid, text, text) from public, anon, authenticated;
grant execute on function mark_first_run_progress(uuid, text, text) to authenticated, service_role;

comment on function mark_first_run_progress(uuid, text, text) is
  'Records a first-run step for the tenant the route resolved (plan_opened | asked | made | setup_docs | setup_connectors | setup_done | setup_home). Checked against the caller''s tenant_users membership.';

commit;
