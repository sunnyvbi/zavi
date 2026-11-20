
begin;

alter table public.tenant_channels add column if not exists autorun_set_at timestamptz;

comment on column public.tenant_channels.autorun_set_at is
  'When the founder last set autorun (set_channel_autorun). Read with cgo_autopilot_state.on_at: a founder OFF newer than the latest Autopilot ON means ask first.';

create table if not exists public.cgo_autopilot_state (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  on_at      timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.cgo_autopilot_state is
  'One row per tenant: the latest instant Autopilot was turned on. Trigger-written (cgo_autopilot_setting_changed); read by services/growth/channel-autorun.ts.';

alter table public.cgo_autopilot_state enable row level security;
revoke all on table public.cgo_autopilot_state from public, anon, authenticated;
grant select, insert, update, delete on table public.cgo_autopilot_state to service_role;

create table if not exists public.cgo_autopilot_audit (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null,
  enabled       boolean,
  prior_enabled boolean,
  actor         text,
  at            timestamptz not null default now()
);

create index if not exists cgo_autopilot_audit_tenant_at on public.cgo_autopilot_audit (tenant_id, at desc);

alter table public.cgo_autopilot_audit enable row level security;
revoke all on table public.cgo_autopilot_audit from public, anon, authenticated;
grant select, insert on table public.cgo_autopilot_audit to service_role;

create or replace function public.cgo_autopilot_setting_changed()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_on    boolean;
  v_prior boolean;
begin
  if tg_op = 'DELETE' then
    if old.key is distinct from 'cgo_autopilot_enabled' then return old; end if;
    if not exists (select 1 from tenants where id = old.tenant_id) then return old; end if;
    insert into cgo_autopilot_audit (tenant_id, enabled, prior_enabled, actor)
    values (old.tenant_id, null, old.value = 'true'::jsonb, 'cleared');
    return old;
  end if;

  if new.key is distinct from 'cgo_autopilot_enabled' then return new; end if;
  v_on := coalesce(new.value = 'true'::jsonb, false);
  v_prior := case when tg_op = 'UPDATE' then coalesce(old.value = 'true'::jsonb, false) end;

  if v_on then
    insert into cgo_autopilot_state (tenant_id, on_at, updated_at, updated_by)
    values (new.tenant_id, now(), now(), new.updated_by)
    on conflict (tenant_id) do update
      set on_at      = now(),
          updated_at = now(),
          updated_by = excluded.updated_by;
  end if;

  insert into cgo_autopilot_audit (tenant_id, enabled, prior_enabled, actor)
  values (new.tenant_id, v_on, v_prior, new.updated_by);
  return new;
end $$;

revoke all on function public.cgo_autopilot_setting_changed() from public, anon, authenticated;

drop trigger if exists tenant_app_setting_cgo_autopilot on public.tenant_app_setting;
create trigger tenant_app_setting_cgo_autopilot
  after insert or update or delete on public.tenant_app_setting
  for each row execute function public.cgo_autopilot_setting_changed();

create or replace function public.set_cgo_autopilot(
  p_tenant_id     uuid,
  p_enabled       boolean,
  p_actor_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior jsonb;
  v_on_at timestamptz;
begin
  if p_tenant_id is null or p_enabled is null or p_actor_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = p_tenant_id and user_id = p_actor_user_id and role in ('owner', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_owner_or_admin');
  end if;

  select value into v_prior
    from tenant_app_setting
   where tenant_id = p_tenant_id and key = 'cgo_autopilot_enabled'
   for update;

  insert into tenant_app_setting (tenant_id, key, value, updated_by, updated_at)
  values (p_tenant_id, 'cgo_autopilot_enabled', to_jsonb(p_enabled), 'user:' || p_actor_user_id, now())
  on conflict (tenant_id, key) do update
    set value      = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  select on_at into v_on_at from cgo_autopilot_state where tenant_id = p_tenant_id;

  return jsonb_build_object(
    'ok', true,
    'enabled', p_enabled,
    'prior', case when v_prior is null then null else v_prior = 'true'::jsonb end,
    'on_at', v_on_at
  );
end $$;

revoke all on function public.set_cgo_autopilot(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.set_cgo_autopilot(uuid, boolean, uuid) to service_role;

create or replace function public.set_channel_autorun(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_autorun      boolean
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_exists boolean;
begin
  if p_tenant_id is null
     or nullif(trim(p_channel_slug), '') is null
     or p_autorun is null then
    return false;
  end if;

  insert into tenant_channels (tenant_id, channel_slug, autorun, autorun_set_by, autorun_set_at)
  values (p_tenant_id, p_channel_slug, p_autorun, 'founder', now())
  on conflict (tenant_id, channel_slug) do update
    set autorun        = p_autorun,
        autorun_set_by = 'founder',
        autorun_set_at = now();

  select true into v_exists
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and autorun_set_by = 'founder'
     and autorun is not distinct from p_autorun;

  return coalesce(v_exists, false);
end $$;

revoke all on function public.set_channel_autorun(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.set_channel_autorun(uuid, text, boolean)
  to service_role;

insert into public.cgo_autopilot_state (tenant_id, on_at, updated_at, updated_by)
select s.tenant_id, now(), now(), 'migration:20261101090000'
  from public.tenant_app_setting s
 where s.key = 'cgo_autopilot_enabled' and s.value = 'true'::jsonb
on conflict (tenant_id) do update
  set on_at      = excluded.on_at,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

insert into public.cgo_autopilot_audit (tenant_id, enabled, prior_enabled, actor)
select s.tenant_id, true, true, 'migration:20261101090000'
  from public.tenant_app_setting s
 where s.key = 'cgo_autopilot_enabled' and s.value = 'true'::jsonb;

commit;
