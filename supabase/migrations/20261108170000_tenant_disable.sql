
set lock_timeout = '5s';

alter table public.tenants
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text,
  add column if not exists disabled_by uuid;

comment on column public.tenants.disabled_at is
  'Set by staff via set_tenant_disabled. Non-null = workspace disabled: no new or queued runs, no secrets, no RLS reads, no login. NULL = active. Reversible.';
comment on column public.tenants.disabled_reason is 'Staff-entered reason for the disable.';
comment on column public.tenants.disabled_by is 'Staff user id that disabled the workspace.';

create or replace function public.is_tenant_disabled(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select t.disabled_at is not null from public.tenants t where t.id = p_tenant), false)
$$;

revoke all on function public.is_tenant_disabled(uuid) from public, anon, authenticated;
grant execute on function public.is_tenant_disabled(uuid) to service_role;

create or replace function public._agent_run_reject_disabled_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_tenant_disabled(new.tenant_id) then
    raise exception 'tenant_disabled'
      using errcode = 'P0001',
            detail = 'tenant ' || new.tenant_id::text || ' is disabled';
  end if;
  return new;
end $$;

revoke all on function public._agent_run_reject_disabled_tenant() from public, anon, authenticated;

drop trigger if exists agent_runs_reject_disabled_tenant on public.agent_runs;
create trigger agent_runs_reject_disabled_tenant
  before insert on public.agent_runs
  for each row execute function public._agent_run_reject_disabled_tenant();

create or replace function claim_agent_run(p_run_id uuid, p_worker_id text)
returns agent_runs
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row agent_runs;
  v_tenant_id uuid;
  v_agent_slug text;
  v_trigger text;
  v_killed boolean;
begin
  select tenant_id, agent_slug, trigger
    into v_tenant_id, v_agent_slug, v_trigger
    from agent_runs
   where id = p_run_id;

  if v_tenant_id is null then
    return null;
  end if;

  if public.is_tenant_disabled(v_tenant_id) then
    insert into enqueue_rejections (
      tenant_id, agent_slug, rejection_reason, body_fingerprint, trigger
    ) values (
      v_tenant_id,
      v_agent_slug,
      'tenant_disabled_at_claim',
      md5(p_run_id::text),
      coalesce(v_trigger, 'unknown')
    );
    return null;
  end if;

  select exists(
    select 1 from tenant_agent_kill_switch
     where tenant_id = v_tenant_id
       and agent_slug = v_agent_slug
       and override_state = 'hidden'
  ) into v_killed;

  if v_killed then
    insert into enqueue_rejections (
      tenant_id, agent_slug, rejection_reason, body_fingerprint, trigger
    ) values (
      v_tenant_id,
      v_agent_slug,
      'kill_switch_at_claim',
      md5(p_run_id::text),
      coalesce(v_trigger, 'unknown')
    );
    return null;
  end if;

  update agent_runs
     set status = 'running', started_at = now(),
         worker_id = coalesce(p_worker_id, worker_id)
   where id = p_run_id and status = 'queued'
   returning * into v_row;
  return v_row;
end $$;

revoke all on function claim_agent_run(uuid, text) from public, anon, authenticated;
grant execute on function claim_agent_run(uuid, text) to service_role;

create or replace function claim_agent_run(p_run_id uuid)
returns agent_runs
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row agent_runs;
  v_tenant_id uuid;
  v_agent_slug text;
  v_trigger text;
  v_killed boolean;
begin
  select tenant_id, agent_slug, trigger
    into v_tenant_id, v_agent_slug, v_trigger
    from agent_runs
   where id = p_run_id;

  if v_tenant_id is null then
    return null;
  end if;

  if public.is_tenant_disabled(v_tenant_id) then
    insert into enqueue_rejections (
      tenant_id, agent_slug, rejection_reason, body_fingerprint, trigger
    ) values (
      v_tenant_id,
      v_agent_slug,
      'tenant_disabled_at_claim',
      md5(p_run_id::text),
      coalesce(v_trigger, 'unknown')
    );
    return null;
  end if;

  select exists(
    select 1 from tenant_agent_kill_switch
     where tenant_id = v_tenant_id
       and agent_slug = v_agent_slug
       and override_state = 'hidden'
  ) into v_killed;

  if v_killed then
    insert into enqueue_rejections (
      tenant_id, agent_slug, rejection_reason, body_fingerprint, trigger
    ) values (
      v_tenant_id,
      v_agent_slug,
      'kill_switch_at_claim',
      md5(p_run_id::text),
      coalesce(v_trigger, 'unknown')
    );
    return null;
  end if;

  update agent_runs
     set status = 'running', started_at = now()
   where id = p_run_id and status = 'queued'
   returning * into v_row;
  return v_row;
end $$;

revoke all on function claim_agent_run(uuid) from public, anon, authenticated;
grant execute on function claim_agent_run(uuid) to service_role;

create or replace function get_secret(p_tenant_id uuid, p_key text) returns text
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_id uuid; v_plaintext text;
begin
  if public.is_tenant_disabled(p_tenant_id) then return null; end if;
  select vault_secret_id into v_id from secrets
  where tenant_id = p_tenant_id and key = p_key;
  if v_id is null then return null; end if;
  select decrypted_secret into v_plaintext
  from vault.decrypted_secrets where id = v_id;
  return v_plaintext;
end $$;

revoke all on function get_secret(uuid, text) from public, anon, authenticated;
grant execute on function get_secret(uuid, text) to service_role;

create or replace function public.app_active_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_session uuid;
  v_tenant uuid;
begin
  if v_user is null then
    return null;
  end if;

  begin
    v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    v_session := null;
  end;
  if v_session is not null then
    select st.tenant_id into v_tenant
      from public.session_tenants st
     where st.session_id = v_session
       and st.user_id = v_user;
  end if;

  if v_tenant is null then
    begin
      v_tenant := nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid;
    exception when invalid_text_representation then
      v_tenant := null;
    end;
  end if;
  if v_tenant is null then
    select p.active_tenant_id into v_tenant
      from public.profiles p
     where p.user_id = v_user;
  end if;

  if v_tenant is null
     or not exists (select 1 from public.tenant_users tu
                     where tu.user_id = v_user and tu.tenant_id = v_tenant)
     or exists (select 1 from public.tenants t
                 where t.id = v_tenant and t.disabled_at is not null) then
    return null;
  end if;
  return v_tenant;
end $$;

revoke all on function public.app_active_tenant() from public, anon, authenticated;
grant execute on function public.app_active_tenant() to anon, authenticated;

create or replace function public.set_tenant_disabled(
  p_tenant uuid,
  p_disabled boolean,
  p_reason text,
  p_actor uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.tenants;
begin
  if p_disabled is null then
    raise exception 'p_disabled is required' using errcode = '22004';
  end if;

  select * into v_row from public.tenants where id = p_tenant for update;
  if not found then
    raise exception 'tenant % not found', p_tenant using errcode = 'P0002';
  end if;

  if (v_row.disabled_at is not null) = p_disabled then
    return jsonb_build_object(
      'changed', false,
      'disabled', p_disabled,
      'disabled_at', v_row.disabled_at,
      'disabled_reason', v_row.disabled_reason,
      'disabled_by', v_row.disabled_by
    );
  end if;

  if p_disabled then
    update public.tenants
       set disabled_at = now(),
           disabled_reason = nullif(btrim(coalesce(p_reason, '')), ''),
           disabled_by = p_actor
     where id = p_tenant
     returning * into v_row;
  else
    update public.tenants
       set disabled_at = null,
           disabled_reason = null,
           disabled_by = null
     where id = p_tenant
     returning * into v_row;
  end if;

  return jsonb_build_object(
    'changed', true,
    'disabled', p_disabled,
    'disabled_at', v_row.disabled_at,
    'disabled_reason', v_row.disabled_reason,
    'disabled_by', v_row.disabled_by
  );
end $$;

revoke all on function public.set_tenant_disabled(uuid, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.set_tenant_disabled(uuid, boolean, text, uuid) to service_role;
